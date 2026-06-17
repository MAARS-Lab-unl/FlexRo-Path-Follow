"""
FastAPI bridge between the React frontend and the serial GPS hardware.

REST:
  POST /api/connect            { port, baud }  -> open serial port
  POST /api/disconnect                         -> close serial port
  GET  /api/status                             -> connection + tx state
  POST /api/send               { lat, lon }    -> write one GPS packet to serial
  POST /api/transmit/start     { lat, lon, interval, use_geo }
                                               -> continuously transmit GPS over serial
  POST /api/transmit/stop                      -> stop continuous transmit
  POST /api/simulate/start     { lat, lon, interval }  -> simulated receiver stream
  POST /api/simulate/stop                              -> stop simulation

WebSocket:
  WS /ws/gps   -> streams incoming GPS packets (receiver mode) to the browser
  WS /ws/tx    -> streams outgoing TX log (sender mode) to the browser
"""

import asyncio
import json
import math
import random
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import serial
import serial.tools.list_ports
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from pymavlink import mavutil as _mavutil
    HAS_MAVLINK = True
except ImportError:
    HAS_MAVLINK = False

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── shared state ─────────────────────────────────────────────────────────────

class AppState:
    def __init__(self):
        self.ser: Optional[serial.Serial] = None
        self.port: str = ""
        self.baud: int = 57600
        self.connected: bool = False
        self.lock = threading.Lock()

        # receiver WebSocket clients
        self.ws_clients: list[WebSocket] = []
        # sender TX log WebSocket clients
        self.tx_clients: list[WebSocket] = []

        self.reader_thread: Optional[threading.Thread] = None
        self.reader_stop = threading.Event()

        # simulation (receiver side)
        self.sim_thread: Optional[threading.Thread] = None
        self.sim_stop = threading.Event()
        self.sim_running: bool = False

        # continuous transmit (sender side)
        self.tx_thread: Optional[threading.Thread] = None
        self.tx_stop = threading.Event()
        self.tx_running: bool = False
        self.tx_count: int = 0
        self.tx_lat: float = 0.0
        self.tx_lon: float = 0.0
        self.tx_interval: float = 1.0
        self.device_id: str = "ATV-1"

        # last received ATV info (receiver side)
        self.last_atv_lat: float = 0.0
        self.last_atv_lon: float = 0.0
        self.last_atv_device_id: str = ""
        self.last_atv_time: str = ""
        self.atv_paired: bool = False

        # robot self-position (receiver side — browser pushes geolocation here)
        self.robot_lat: float = 0.0
        self.robot_lon: float = 0.0
        self.robot_time: str = ""
        self.robot_pos_set: bool = False

        # robot transmit loop (sends robot GPS back over radio to ATV)
        self.robot_tx_thread: Optional[threading.Thread] = None
        self.robot_tx_stop = threading.Event()
        self.robot_tx_running: bool = False
        self.robot_tx_interval: float = 1.0

        # WebSocket clients that receive incoming robot GPS (on sender side)
        self.robot_clients: list[WebSocket] = []

        # MAVLink (Cube Orange) GPS reader — sender side only
        self.mav_conn = None           # mavutil connection object
        self.mav_port: str = ""
        self.mav_baud: int = 115200
        self.mav_connected: bool = False
        self.mav_fix_type: int = 0
        self.mav_satellites: int = 0
        self.mav_cog: Optional[float] = None  # course over ground in degrees
        self.mav_thread: Optional[threading.Thread] = None
        self.mav_stop = threading.Event()
        # WebSocket clients that receive live MAVLink GPS (sender browser)
        self.mav_clients: list[WebSocket] = []

state = AppState()
_main_loop: asyncio.AbstractEventLoop | None = None


# ── broadcast helpers ─────────────────────────────────────────────────────────

async def _broadcast(clients: list[WebSocket], payload: dict):
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in clients:
            clients.remove(ws)


def broadcast_sync(clients: list[WebSocket], payload: dict):
    if _main_loop is None:
        return
    asyncio.run_coroutine_threadsafe(_broadcast(clients, payload), _main_loop)


# ── Serial reader thread (receiver mode) ─────────────────────────────────────

def _parse_nmea_lat_lon(sentence: str):
    try:
        parts = sentence.split(",")
        if len(parts) < 7:
            return None
        lat_raw, lat_dir = parts[3], parts[4]
        lon_raw, lon_dir = parts[5], parts[6].split("*")[0]
        if not lat_raw or not lon_raw:
            return None
        lat_deg = int(lat_raw[:2])
        lat_min = float(lat_raw[2:])
        lat = lat_deg + lat_min / 60.0
        if lat_dir == "S":
            lat = -lat
        lon_deg = int(lon_raw[:3])
        lon_min = float(lon_raw[3:])
        lon = lon_deg + lon_min / 60.0
        if lon_dir == "W":
            lon = -lon
        return lat, lon
    except Exception:
        return None


def serial_reader_loop():
    while not state.reader_stop.is_set():
        with state.lock:
            ser = state.ser
        if ser is None or not ser.is_open:
            time.sleep(0.1)
            continue
        try:
            raw = ser.readline()
        except Exception as e:
            print(f"[serial] read error: {e}")
            time.sleep(0.1)
            continue
        if not raw:
            continue
        line = raw.decode("ascii", errors="replace").strip()
        if not line:
            continue
        print(f"[serial] received: {line}")
        receive_time = datetime.now(timezone.utc).isoformat()
        data = None
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            pass
        if data is not None and data.get("type") == "gps":
            src = data.get("source", "serial")
            device_id = data.get("device_id", "")

            if src == "robot":
                # Incoming robot GPS on the sender side — forward to sender browser
                print(f"[serial] received robot GPS from {device_id}")
                broadcast_sync(state.robot_clients, {
                    "type": "robot_gps",
                    "receive_time_utc": receive_time,
                    "lat": data.get("lat"),
                    "lon": data.get("lon"),
                    "device_id": device_id,
                })
            else:
                # Incoming ATV GPS on the receiver side
                print(f"[serial] broadcasting GPS to {len(state.ws_clients)} WebSocket client(s)")
                state.last_atv_lat = data.get("lat", 0.0)
                state.last_atv_lon = data.get("lon", 0.0)
                state.last_atv_device_id = device_id or "unknown"
                state.last_atv_time = receive_time
                state.atv_paired = True
                broadcast_sync(state.ws_clients, {
                    "type": "gps",
                    "receive_time_utc": receive_time,
                    "lat": data.get("lat"),
                    "lon": data.get("lon"),
                    "timestamp_utc": data.get("timestamp_utc"),
                    "source": src,
                    "device_id": device_id,
                })
        elif line.startswith("$GPRMC") or line.startswith("$GNRMC"):
            parsed = _parse_nmea_lat_lon(line)
            if parsed:
                lat, lon = parsed
                print(f"[serial] broadcasting NMEA to {len(state.ws_clients)} WebSocket client(s)")
                broadcast_sync(state.ws_clients, {
                    "type": "gps",
                    "receive_time_utc": receive_time,
                    "lat": lat,
                    "lon": lon,
                    "source": "nmea",
                    "raw": line,
                })


# ── Simulation thread (receiver side) ────────────────────────────────────────

def simulation_loop(start_lat: float, start_lon: float, interval: float):
    step = 0
    while not state.sim_stop.is_set():
        radius = 0.0005
        angle = step * 0.1
        lat = start_lat + radius * math.sin(angle) + random.uniform(-0.00002, 0.00002)
        lon = start_lon + radius * math.cos(angle) + random.uniform(-0.00002, 0.00002)
        now = datetime.now(timezone.utc).isoformat()
        state.last_atv_lat = round(lat, 7)
        state.last_atv_lon = round(lon, 7)
        state.last_atv_device_id = "SIM-ATV"
        state.last_atv_time = now
        state.atv_paired = True
        broadcast_sync(state.ws_clients, {
            "type": "gps",
            "receive_time_utc": now,
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "source": "simulated",
            "device_id": "SIM-ATV",
        })
        step += 1
        time.sleep(interval)
    state.sim_running = False


# ── Robot transmit loop (receiver side — sends robot GPS back to ATV) ─────────

def _make_robot_packet() -> str:
    return json.dumps({
        "type": "gps",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "lat": round(state.robot_lat, 7),
        "lon": round(state.robot_lon, 7),
        "source": "robot",
        "device_id": state.device_id,
        "radio": "RFD 900x-US",
    }) + "\r\n"


def robot_transmit_loop(interval: float):
    while not state.robot_tx_stop.is_set():
        if not state.robot_pos_set:
            time.sleep(0.5)
            continue
        packet = _make_robot_packet()
        with state.lock:
            ser = state.ser
        if ser and ser.is_open:
            try:
                ser.write(packet.encode("ascii"))
                ser.flush()
            except Exception:
                pass
        time.sleep(interval)
    state.robot_tx_running = False


# ── Continuous transmit thread (sender mode) ─────────────────────────────────

def _make_json_packet(lat: float, lon: float) -> str:
    pkt: dict = {
        "type": "gps",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "source": "atv",
        "device_id": state.device_id,
        "radio": "RFD 900x-US",
    }
    if state.mav_cog is not None:
        pkt["cog"] = round(state.mav_cog, 1)
    return json.dumps(pkt) + "\r\n"


def transmit_loop(lat: float, lon: float, interval: float):
    state.tx_count = 0
    while not state.tx_stop.is_set():
        # Use live MAVLink GPS if available, else fall back to the initial lat/lon
        cur_lat = state.tx_lat if state.mav_connected and state.tx_lat != 0.0 else lat
        cur_lon = state.tx_lon if state.mav_connected and state.tx_lon != 0.0 else lon
        packet = _make_json_packet(cur_lat, cur_lon)
        sent = False
        error = None
        with state.lock:
            ser = state.ser
        if ser and ser.is_open:
            try:
                ser.write(packet.encode("ascii"))
                ser.flush()
                sent = True
                state.tx_count += 1
            except Exception as e:
                error = str(e)

        log_entry = {
            "type": "tx_log",
            "time": datetime.now(timezone.utc).isoformat(),
            "lat": cur_lat,
            "lon": cur_lon,
            "sent": sent,
            "count": state.tx_count,
            "error": error,
        }
        broadcast_sync(state.tx_clients, log_entry)
        time.sleep(interval)
    state.tx_running = False


# ── MAVLink GPS reader thread (sender / ATV side) ────────────────────────────

def mavlink_reader_loop():
    """Reads GPS_RAW_INT from Cube Orange and updates state.tx_lat/tx_lon live."""
    conn = state.mav_conn
    if conn is None:
        return
    print(f"[mav] waiting for heartbeat on {state.mav_port}…")
    try:
        conn.wait_heartbeat(timeout=10)
    except Exception as e:
        print(f"[mav] heartbeat timeout: {e}")
        state.mav_connected = False
        return
    print(f"[mav] connected — system {conn.target_system} component {conn.target_component}")
    while not state.mav_stop.is_set():
        try:
            msg = conn.recv_match(type="GPS_RAW_INT", blocking=True, timeout=2)
        except Exception as e:
            print(f"[mav] recv error: {e}")
            time.sleep(0.5)
            continue
        if msg is None:
            continue
        lat = msg.lat / 1e7
        lon = msg.lon / 1e7
        fix = msg.fix_type
        sats = msg.satellites_visible
        # cog = course over ground in centidegrees (65535 = unknown)
        cog_raw = getattr(msg, "cog", 65535)
        cog = (cog_raw / 100.0) if cog_raw != 65535 else None
        now = datetime.now(timezone.utc).isoformat()
        state.tx_lat = lat
        state.tx_lon = lon
        state.mav_fix_type = fix
        state.mav_satellites = sats
        state.mav_cog = cog
        print(f"[mav] GPS fix={fix} sats={sats} lat={lat:.6f} lon={lon:.6f} cog={cog}")
        payload = {
            "type": "mav_gps",
            "time": now,
            "lat": lat,
            "lon": lon,
            "fix_type": fix,
            "satellites": sats,
            "cog": cog,
        }
        broadcast_sync(state.mav_clients, payload)
    print("[mav] reader stopped")
    state.mav_connected = False


# ── USB port scanner ──────────────────────────────────────────────────────────

_RFD_HINTS = {"rfd", "sik", "900x", "ftdi", "cp210", "ch340", "ch341", "prolific", "pl2303"}
_MAV_HINTS = {"cube", "pixhawk", "ardupilot", "mav", "stm32", "blackmagic"}

def _classify_port(p) -> str:
    desc = (p.description or "").lower()
    mfr  = (p.manufacturer or "").lower()
    prod = (getattr(p, "product", None) or "").lower()
    combined = f"{desc} {mfr} {prod}"
    if any(h in combined for h in _MAV_HINTS):
        return "cube"
    if any(h in combined for h in _RFD_HINTS):
        return "rfd"
    return "serial"


# ── Startup / shutdown ────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    global _main_loop
    _main_loop = asyncio.get_event_loop()
    state.reader_stop.clear()
    state.reader_thread = threading.Thread(target=serial_reader_loop, daemon=True)
    state.reader_thread.start()


@app.on_event("shutdown")
async def shutdown():
    state.reader_stop.set()
    state.sim_stop.set()
    state.tx_stop.set()
    with state.lock:
        if state.ser and state.ser.is_open:
            state.ser.close()


# ── REST endpoints ────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    port: str = "/dev/ttyUSB0"
    baud: int = 57600
    device_id: str = "ATV-1"


class SendRequest(BaseModel):
    lat: float
    lon: float


class SimulateRequest(BaseModel):
    lat: float = 32.7767
    lon: float = -96.7970
    interval: float = 1.0


class TransmitRequest(BaseModel):
    lat: float = 32.7767
    lon: float = -96.7970
    interval: float = 1.0


class RobotPositionRequest(BaseModel):
    lat: float
    lon: float


class RobotTransmitRequest(BaseModel):
    interval: float = 1.0


class MavlinkConnectRequest(BaseModel):
    port: str = "COM7"
    baud: int = 115200


@app.get("/api/ports")
async def list_ports():
    """Return real USB serial ports (skips built-in ttyS* with no manufacturer)."""
    ports = []
    for p in serial.tools.list_ports.comports():
        # Skip bare system serial ports that have no real hardware attached
        if not p.manufacturer and (not p.description or p.description.strip().lower() == "n/a"):
            continue
        ports.append({
            "port": p.device,
            "description": p.description,
            "manufacturer": p.manufacturer,
            "type": _classify_port(p),
        })
    return {"ports": ports}


@app.post("/api/mavlink/connect")
async def mavlink_connect(req: MavlinkConnectRequest):
    if not HAS_MAVLINK:
        return {"ok": False, "error": "pymavlink not installed — run: pip install pymavlink"}
    # stop existing reader
    state.mav_stop.set()
    if state.mav_thread and state.mav_thread.is_alive():
        state.mav_thread.join(timeout=3)
    if state.mav_conn:
        try:
            state.mav_conn.close()
        except Exception:
            pass
        state.mav_conn = None
    state.mav_connected = False
    try:
        conn = _mavutil.mavlink_connection(req.port, baud=req.baud)
        state.mav_conn = conn
        state.mav_port = req.port
        state.mav_baud = req.baud
        state.mav_connected = True
        state.mav_stop.clear()
        state.mav_thread = threading.Thread(target=mavlink_reader_loop, daemon=True)
        state.mav_thread.start()
        return {"ok": True, "port": req.port, "baud": req.baud}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/mavlink/disconnect")
async def mavlink_disconnect():
    state.mav_stop.set()
    if state.mav_conn:
        try:
            state.mav_conn.close()
        except Exception:
            pass
        state.mav_conn = None
    state.mav_connected = False
    return {"ok": True}


@app.post("/api/connect")
async def connect(req: ConnectRequest):
    with state.lock:
        if state.ser and state.ser.is_open:
            state.ser.close()
        state.ser = None
        state.connected = False
        try:
            ser = serial.Serial(
                port=req.port,
                baudrate=req.baud,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1,
                write_timeout=1,
            )
            state.ser = ser
            state.port = req.port
            state.baud = req.baud
            state.device_id = req.device_id
            state.connected = True
            return {"ok": True, "port": req.port, "baud": req.baud}
        except Exception as e:
            return {"ok": False, "error": str(e)}


@app.post("/api/disconnect")
async def disconnect():
    state.tx_stop.set()
    state.tx_running = False
    with state.lock:
        if state.ser and state.ser.is_open:
            state.ser.close()
        state.ser = None
        state.connected = False
    return {"ok": True}


@app.get("/api/status")
async def status():
    return {
        "connected": state.connected,
        "port": state.port,
        "baud": state.baud,
        "device_id": state.device_id,
        "sim_running": state.sim_running,
        "tx_running": state.tx_running,
        "tx_count": state.tx_count,
        "tx_lat": state.tx_lat,
        "tx_lon": state.tx_lon,
        "tx_interval": state.tx_interval,
        "atv_paired": state.atv_paired,
        "last_atv_device_id": state.last_atv_device_id,
        "last_atv_lat": state.last_atv_lat,
        "last_atv_lon": state.last_atv_lon,
        "last_atv_time": state.last_atv_time,
        "robot_tx_running": state.robot_tx_running,
        "robot_tx_interval": state.robot_tx_interval,
        "robot_lat": state.robot_lat,
        "robot_lon": state.robot_lon,
        "mav_connected": state.mav_connected,
        "mav_port": state.mav_port,
        "mav_baud": state.mav_baud,
        "mav_fix_type": state.mav_fix_type,
        "mav_satellites": state.mav_satellites,
    }


@app.post("/api/send")
async def send_coords(req: SendRequest):
    with state.lock:
        if not state.connected or state.ser is None:
            return {"ok": False, "error": "Not connected"}
        payload = _make_json_packet(req.lat, req.lon)
        try:
            state.ser.write(payload.encode("ascii"))
            state.ser.flush()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


@app.post("/api/transmit/start")
async def transmit_start(req: TransmitRequest):
    if state.tx_running:
        state.tx_stop.set()
        time.sleep(0.1)
    state.tx_stop.clear()
    state.tx_running = True
    state.tx_lat = req.lat
    state.tx_lon = req.lon
    state.tx_interval = req.interval
    state.tx_thread = threading.Thread(
        target=transmit_loop,
        args=(req.lat, req.lon, req.interval),
        daemon=True,
    )
    state.tx_thread.start()
    return {"ok": True}


@app.post("/api/transmit/stop")
async def transmit_stop():
    state.tx_stop.set()
    state.tx_running = False
    return {"ok": True}


@app.post("/api/simulate/start")
async def simulate_start(req: SimulateRequest):
    if state.sim_running:
        return {"ok": False, "error": "Simulation already running"}
    state.sim_stop.clear()
    state.sim_running = True
    state.sim_thread = threading.Thread(
        target=simulation_loop,
        args=(req.lat, req.lon, req.interval),
        daemon=True,
    )
    state.sim_thread.start()
    return {"ok": True}


@app.post("/api/simulate/stop")
async def simulate_stop():
    state.sim_stop.set()
    state.sim_running = False
    return {"ok": True}


@app.post("/api/robot/position")
async def robot_position(req: RobotPositionRequest):
    """Browser pushes robot's geolocation here continuously."""
    state.robot_lat = req.lat
    state.robot_lon = req.lon
    state.robot_time = datetime.now(timezone.utc).isoformat()
    state.robot_pos_set = True
    return {"ok": True}


@app.post("/api/robot/transmit/start")
async def robot_transmit_start(req: RobotTransmitRequest):
    if state.robot_tx_running:
        state.robot_tx_stop.set()
        time.sleep(0.1)
    state.robot_tx_stop.clear()
    state.robot_tx_running = True
    state.robot_tx_interval = req.interval
    state.robot_tx_thread = threading.Thread(
        target=robot_transmit_loop,
        args=(req.interval,),
        daemon=True,
    )
    state.robot_tx_thread.start()
    return {"ok": True}


@app.post("/api/robot/transmit/stop")
async def robot_transmit_stop():
    state.robot_tx_stop.set()
    state.robot_tx_running = False
    return {"ok": True}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/gps")
async def ws_gps(websocket: WebSocket):
    await websocket.accept()
    state.ws_clients.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.ws_clients:
            state.ws_clients.remove(websocket)


@app.websocket("/ws/tx")
async def ws_tx(websocket: WebSocket):
    await websocket.accept()
    state.tx_clients.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.tx_clients:
            state.tx_clients.remove(websocket)


@app.websocket("/ws/robot")
async def ws_robot(websocket: WebSocket):
    """Sender browser connects here to receive incoming robot GPS packets."""
    await websocket.accept()
    state.robot_clients.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.robot_clients:
            state.robot_clients.remove(websocket)


@app.websocket("/ws/mav")
async def ws_mav(websocket: WebSocket):
    """Sender browser connects here to receive live MAVLink GPS from Cube Orange."""
    await websocket.accept()
    state.mav_clients.append(websocket)
    # Send current fix immediately so the browser doesn't wait for next packet
    if state.mav_connected and state.tx_lat != 0.0:
        await websocket.send_json({
            "type": "mav_gps",
            "time": datetime.now(timezone.utc).isoformat(),
            "lat": state.tx_lat,
            "lon": state.tx_lon,
            "fix_type": state.mav_fix_type,
            "satellites": state.mav_satellites,
        })
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.mav_clients:
            state.mav_clients.remove(websocket)
