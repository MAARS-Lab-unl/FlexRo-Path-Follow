import React, { useState } from "react";
import { api } from "./api";

interface Props {
  onSent: (lat: number, lon: number) => void;
  connected: boolean;
  simRunning: boolean;
  onSimStart: (lat: number, lon: number, interval: number) => void;
  onSimStop: () => void;
  onClearTrail: () => void;
}

export default function CoordPanel({ onSent, connected, simRunning, onSimStart, onSimStop, onClearTrail }: Props) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [intervalSec, setIntervalSec] = useState(1);
  const [geoLoading, setGeoLoading] = useState(false);
  const [sendStatus, setSendStatus] = useState<"idle" | "ok" | "err">("idle");

  function loadCurrentLocation() {
    if (!navigator.geolocation) return;
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(7));
        setLon(pos.coords.longitude.toFixed(7));
        setGeoLoading(false);
      },
      () => setGeoLoading(false)
    );
  }

  async function handleSend() {
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);
    if (isNaN(latN) || isNaN(lonN)) return;
    const res = await api.send(latN, lonN);
    setSendStatus(res.ok ? "ok" : "err");
    if (res.ok) onSent(latN, lonN);
    setTimeout(() => setSendStatus("idle"), 1500);
  }

  function handleSimToggle() {
    const latN = parseFloat(lat) || 32.7767;
    const lonN = parseFloat(lon) || -96.797;
    if (simRunning) {
      onSimStop();
    } else {
      onSimStart(latN, lonN, intervalSec);
    }
  }

  return (
    <div style={styles.panel}>
      {/* ── ATV origin section ── */}
      <h3 style={styles.heading}>ATV Start Position</h3>
      <p style={styles.hint}>
        Seed coordinates for simulation or manual send. Leave blank to use the live ATV signal.
      </p>

      <button style={styles.geoBtn} onClick={loadCurrentLocation} disabled={geoLoading}>
        {geoLoading ? "Locating…" : "Use My Current Location"}
      </button>

      <label style={styles.label}>Latitude</label>
      <input
        style={styles.input}
        value={lat}
        onChange={(e) => setLat(e.target.value)}
        placeholder="e.g. 32.7767"
        type="number"
        step="any"
      />

      <label style={styles.label}>Longitude</label>
      <input
        style={styles.input}
        value={lon}
        onChange={(e) => setLon(e.target.value)}
        placeholder="e.g. -96.7970"
        type="number"
        step="any"
      />

      {/* Manual send — useful for overriding ATV target */}
      <button
        style={{
          ...styles.btn,
          background: sendStatus === "ok" ? "#22c55e" : sendStatus === "err" ? "#ef4444" : "#3b82f6",
          opacity: !connected ? 0.5 : 1,
        }}
        onClick={handleSend}
        disabled={!connected}
        title={!connected ? "Not connected to robot receiver" : "Send this position over the radio"}
      >
        {sendStatus === "ok" ? "Sent!" : sendStatus === "err" ? "Failed" : "Send to Robot Radio"}
      </button>

      <div style={styles.divider} />

      {/* ── Simulation section ── */}
      <h3 style={styles.heading}>Simulate ATV</h3>
      <p style={styles.hint}>
        Replay a circular ATV path from the coordinates above.
      </p>

      <label style={styles.label}>Update Interval (s)</label>
      <input
        style={styles.input}
        type="number"
        min={0.2}
        step={0.1}
        value={intervalSec}
        onChange={(e) => setIntervalSec(Number(e.target.value))}
        disabled={simRunning}
      />

      <button
        style={{
          ...styles.btn,
          background: simRunning ? "#f59e0b" : "#8b5cf6",
        }}
        onClick={handleSimToggle}
      >
        {simRunning ? "Stop Simulation" : "Start Simulation"}
      </button>

      {simRunning && (
        <div style={styles.badge}>Simulating ATV movement…</div>
      )}

      <div style={styles.divider} />

      {/* ── Map controls ── */}
      <h3 style={styles.heading}>Map</h3>
      <button style={{ ...styles.btn, background: "#334155" }} onClick={onClearTrail}>
        Clear ATV Trail
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 248,
    background: "#1e293b",
    padding: "18px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflowY: "auto",
    flexShrink: 0,
    borderRight: "1px solid #334155",
  },
  heading: { color: "#f1f5f9", fontSize: 13, fontWeight: 700, margin: "6px 0 2px", textTransform: "uppercase", letterSpacing: 0.5 },
  hint: { color: "#64748b", fontSize: 11, margin: "0 0 4px", lineHeight: 1.5 },
  label: { color: "#94a3b8", fontSize: 12, fontWeight: 600 },
  input: {
    background: "#0f172a",
    color: "#f1f5f9",
    border: "1px solid #334155",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 13,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  geoBtn: {
    background: "#0f172a",
    color: "#38bdf8",
    border: "1px solid #0284c7",
    borderRadius: 6,
    padding: "8px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
  },
  btn: {
    padding: "9px",
    borderRadius: 6,
    border: "none",
    color: "#fff",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    marginTop: 2,
  },
  divider: { borderTop: "1px solid #334155", margin: "10px 0 4px" },
  badge: {
    background: "#422006",
    color: "#fde68a",
    borderRadius: 6,
    padding: "7px 10px",
    fontSize: 11,
    textAlign: "center",
  },
};
