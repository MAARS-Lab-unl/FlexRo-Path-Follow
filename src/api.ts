const BASE = process.env.REACT_APP_BACKEND_URL || "http://localhost:8000";

async function post(path: string, body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const api = {
  connect: (port: string, baud: number, device_id: string) => post("/api/connect", { port, baud, device_id }),
  disconnect: () => post("/api/disconnect"),
  status: () => fetch(`${BASE}/api/status`).then((r) => r.json()),
  send: (lat: number, lon: number) => post("/api/send", { lat, lon }),
  transmitStart: (lat: number, lon: number, interval: number) =>
    post("/api/transmit/start", { lat, lon, interval }),
  transmitStop: () => post("/api/transmit/stop"),
  simulateStart: (lat: number, lon: number, interval: number) =>
    post("/api/simulate/start", { lat, lon, interval }),
  simulateStop: () => post("/api/simulate/stop"),
  robotPosition: (lat: number, lon: number) =>
    post("/api/robot/position", { lat, lon }),
  robotTransmitStart: (interval: number) =>
    post("/api/robot/transmit/start", { interval }),
  robotTransmitStop: () => post("/api/robot/transmit/stop"),
};
