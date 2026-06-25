"""
End-to-end simulation test — no hardware required.

1. Starts the FastAPI server in a subprocess.
2. Hits /api/simulate/start  with a configurable origin.
3. Opens a WebSocket and collects N GPS packets.
4. Validates lat/lon are within expected radius.
5. Stops simulation and tears down.

Run:
    python backend/test_simulation.py
"""

import asyncio
import json
import subprocess
import sys
import time
import math
import os

import websockets
import httpx


BACKEND_URL = "http://127.0.0.1:8000"
WS_URL = "ws://127.0.0.1:8000/ws/gps"
ORIGIN_LAT = 32.7767
ORIGIN_LON = -96.7970
COLLECT = 10          # packets to collect before asserting
INTERVAL = 0.3        # seconds between simulated packets
RADIUS_DEG = 0.002    # max expected drift from origin


def distance_deg(lat1, lon1, lat2, lon2):
    return math.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2)


async def collect_packets(n: int):
    packets = []
    async with websockets.connect(WS_URL) as ws:
        while len(packets) < n:
            msg = await asyncio.wait_for(ws.recv(), timeout=10)
            data = json.loads(msg)
            if data.get("type") == "gps":
                packets.append(data)
                print(f"  [{len(packets):02d}/{n}] lat={data['lat']:.7f}  lon={data['lon']:.7f}  src={data['source']}")
    return packets


async def run_test():
    print("=" * 60)
    print("FlexRo GPS Simulation Test")
    print("=" * 60)

    async with httpx.AsyncClient() as client:
        # 1. Wait for server to be ready
        print("\n[1] Waiting for backend…")
        for _ in range(20):
            try:
                r = await client.get(f"{BACKEND_URL}/api/status", timeout=2)
                if r.status_code == 200:
                    print("    Backend ready.")
                    break
            except Exception:
                await asyncio.sleep(0.5)
        else:
            print("    ERROR: backend did not start in time.")
            return False

        # 2. Start simulation
        print(f"\n[2] Starting simulation at ({ORIGIN_LAT}, {ORIGIN_LON}), interval={INTERVAL}s")
        r = await client.post(f"{BACKEND_URL}/api/simulate/start", json={
            "lat": ORIGIN_LAT,
            "lon": ORIGIN_LON,
            "interval": INTERVAL,
        })
        result = r.json()
        assert result["ok"], f"simulate/start failed: {result}"
        print("    Simulation started.")

        # 3. Collect packets over WebSocket
        print(f"\n[3] Collecting {COLLECT} GPS packets via WebSocket…")
        packets = await collect_packets(COLLECT)

        # 4. Stop simulation
        print("\n[4] Stopping simulation…")
        r = await client.post(f"{BACKEND_URL}/api/simulate/stop")
        print("    Simulation stopped.")

        # 5. Validate
        print("\n[5] Validating packets…")
        failures = []
        for p in packets:
            d = distance_deg(p["lat"], p["lon"], ORIGIN_LAT, ORIGIN_LON)
            if d > RADIUS_DEG:
                failures.append((p, d))

        if failures:
            print(f"    FAIL: {len(failures)} packet(s) out of expected radius ({RADIUS_DEG} deg).")
            for p, d in failures:
                print(f"      lat={p['lat']}  lon={p['lon']}  dist={d:.6f}")
            return False

        print(f"    PASS: all {COLLECT} packets within {RADIUS_DEG} deg of origin.")
        print(f"\n{'=' * 60}")
        print("Simulation test PASSED")
        print("=" * 60)
        return True


def main():
    # Try to start the server automatically if not already running
    server_proc = None
    try:
        httpx.get(f"{BACKEND_URL}/api/status", timeout=1)
        print("Using already-running backend.")
    except Exception:
        print("Starting backend server…")
        server_proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.server:app", "--host", "127.0.0.1", "--port", "8000"],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        time.sleep(2)

    try:
        ok = asyncio.run(run_test())
        sys.exit(0 if ok else 1)
    finally:
        if server_proc:
            server_proc.terminate()
            server_proc.wait()


if __name__ == "__main__":
    main()
