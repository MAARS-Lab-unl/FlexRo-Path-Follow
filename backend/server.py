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
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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
        except Exception:
            time.sleep(0.1)
            continue
        if not raw:
            continue
        line = raw.decode("ascii", errors="replace").strip()
        if not line:
            continue
        receive_time = datetime.now(timezone.utc).isoformat()
        data = None
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            pass
        if data is not None and data.get("type") == "gps":
            broadcast_sync(state.ws_clients, {
                "type": "gps",
                "receive_time_utc": receive_time,
                "lat": data.get("lat"),
                "lon": data.get("lon"),
                "timestamp_utc": data.get("timestamp_utc"),
                "source": data.get("source", "serial"),
            })
        elif line.startswith("$GPRMC") or line.startswith("$GNRMC"):
            parsed = _parse_nmea_lat_lon(line)
            if parsed:
                lat, lon = parsed
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
        broadcast_sync(state.ws_clients, {
            "type": "gps",
            "receive_time_utc": datetime.now(timezone.utc).isoformat(),
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "source": "simulated",
        })
        step += 1
        time.sleep(interval)
    state.sim_running = False


# ── Continuous transmit thread (sender mode) ─────────────────────────────────

def _make_json_packet(lat: float, lon: float) -> str:
    return json.dumps({
        "type": "gps",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "source": "atv",
        "radio": "RFD 900x-US",
    }) + "\r\n"


def transmit_loop(lat: float, lon: float, interval: float):
    state.tx_count = 0
    while not state.tx_stop.is_set():
        packet = _make_json_packet(lat, lon)
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
            "lat": lat,
            "lon": lon,
            "sent": sent,
            "count": state.tx_count,
            "error": error,
        }
        broadcast_sync(state.tx_clients, log_entry)
        time.sleep(interval)
    state.tx_running = False


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
        "sim_running": state.sim_running,
        "tx_running": state.tx_running,
        "tx_count": state.tx_count,
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
