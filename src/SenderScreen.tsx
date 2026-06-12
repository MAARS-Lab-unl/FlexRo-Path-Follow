import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api";
import { ConnectionConfig } from "./types";

const WS_TX_URL = (process.env.REACT_APP_WS_URL || "ws://localhost:8000/ws/gps")
  .replace("/ws/gps", "/ws/tx");

interface TxLog {
  time: string;
  lat: number;
  lon: number;
  sent: boolean;
  count: number;
  error?: string;
}

interface Props {
  connection: ConnectionConfig;
  onDisconnect: () => void;
}

export default function SenderScreen({ connection, onDisconnect }: Props) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [interval, setIntervalSec] = useState(1.0);
  const [transmitting, setTransmitting] = useState(false);
  const [logs, setLogs] = useState<TxLog[]>([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [totalSent, setTotalSent] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // TX WebSocket — streams outgoing packet confirmations
  const connectWs = useCallback(() => {
    const ws = new WebSocket(WS_TX_URL);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as TxLog;
        setTotalSent(data.count);
        setLogs((prev) => {
          const next = [...prev, data];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      } catch {}
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    connectWs();
    return () => { wsRef.current?.close(); };
  }, [connectWs]);

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

  async function handleToggle() {
    if (transmitting) {
      await api.transmitStop();
      setTransmitting(false);
    } else {
      const latN = parseFloat(lat);
      const lonN = parseFloat(lon);
      if (isNaN(latN) || isNaN(lonN)) {
        alert("Enter valid lat/lon before transmitting.");
        return;
      }
      const res = await api.transmitStart(latN, lonN, interval);
      if (res.ok) setTransmitting(true);
    }
  }

  async function handleDisconnect() {
    if (transmitting) await api.transmitStop();
    await api.disconnect();
    onDisconnect();
  }

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <span style={styles.topTitle}>FlexRo Path Follow</span>
        <div style={styles.modePill}>🚜 ATV Sender</div>
        <span style={styles.connPill}>
          <span style={styles.greenDot} />
          {connection.port} @ {connection.baud}
        </span>
        {transmitting && (
          <span style={styles.txPill}>TX ACTIVE — {totalSent} packets sent</span>
        )}
        <button style={styles.discBtn} onClick={handleDisconnect}>Disconnect</button>
      </div>

      <div style={styles.body}>
        {/* Left — controls */}
        <div style={styles.panel}>
          <h3 style={styles.heading}>ATV GPS Position</h3>
          <p style={styles.hint}>
            Set the ATV's starting coordinates. The backend will transmit this
            position over the RFD 900x-US to the robot continuously.
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
            disabled={transmitting}
          />

          <label style={styles.label}>Longitude</label>
          <input
            style={styles.input}
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="e.g. -96.7970"
            type="number"
            step="any"
            disabled={transmitting}
          />

          <label style={styles.label}>Transmit Interval (s)</label>
          <input
            style={styles.input}
            type="number"
            min={0.1}
            step={0.1}
            value={interval}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            disabled={transmitting}
          />

          <button
            style={{
              ...styles.txBtn,
              background: transmitting ? "#dc2626" : "#16a34a",
            }}
            onClick={handleToggle}
          >
            {transmitting ? "⏹ Stop Transmitting" : "▶ Start Transmitting"}
          </button>

          {transmitting && (
            <div style={styles.activeBadge}>
              <span style={styles.pulseDot} />
              Transmitting every {interval}s
            </div>
          )}

          <div style={styles.divider} />

          {/* Receiver instructions */}
          <h3 style={styles.heading}>Receiver Side Setup</h3>
          <div style={styles.instructionBox}>
            <p style={styles.instrStep}><strong>1.</strong> On the receiver computer, run:</p>
            <code style={styles.code}>
              .venv/bin/uvicorn backend.server:app --host 0.0.0.0 --port 8000
            </code>
            <p style={styles.instrStep}><strong>2.</strong> Open the UI, select <strong>Receiver</strong> mode, enter the serial port, click Connect.</p>
            <p style={styles.instrStep}><strong>3.</strong> The map will show this ATV's position as packets arrive over the radio link.</p>
          </div>
        </div>

        {/* Right — TX log */}
        <div style={styles.logPanel}>
          <div style={styles.logHeader}>
            <span style={styles.logTitle}>Transmit Log</span>
            <button style={styles.clearBtn} onClick={() => setLogs([])}>Clear</button>
          </div>
          <div style={styles.logBody}>
            {logs.length === 0 && (
              <div style={styles.logEmpty}>
                No packets transmitted yet. Start transmitting to see the log.
              </div>
            )}
            {logs.map((l, i) => (
              <div key={i} style={{ ...styles.logRow, opacity: i === logs.length - 1 ? 1 : 0.7 }}>
                <span style={styles.logTime}>
                  {new Date(l.time).toLocaleTimeString()}
                </span>
                <span style={l.sent ? styles.logOk : styles.logErr}>
                  {l.sent ? "✓" : "✗"}
                </span>
                <span style={styles.logCoord}>
                  {l.lat.toFixed(6)}, {l.lon.toFixed(6)}
                </span>
                <span style={styles.logCount}>#{l.count}</span>
                {l.error && <span style={styles.logErrMsg}>{l.error}</span>}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex", flexDirection: "column", height: "100vh",
    background: "#0f172a", fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  topBar: {
    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
    background: "#1e293b", padding: "10px 18px",
    borderBottom: "1px solid #334155", flexShrink: 0,
  },
  topTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 15, marginRight: 4 },
  modePill: {
    background: "#422006", color: "#fde68a",
    borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700,
  },
  connPill: {
    background: "#052e16", color: "#86efac",
    borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 600,
    display: "flex", alignItems: "center", gap: 6,
  },
  greenDot: {
    width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block",
  },
  txPill: {
    background: "#052e16", color: "#4ade80",
    borderRadius: 20, padding: "3px 12px", fontSize: 12, fontFamily: "monospace", flex: 1,
  },
  discBtn: {
    marginLeft: "auto", background: "#7f1d1d", color: "#fca5a5",
    border: "none", borderRadius: 6, padding: "6px 14px",
    cursor: "pointer", fontWeight: 600, fontSize: 13,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  panel: {
    width: 300, background: "#1e293b", padding: "20px 18px",
    display: "flex", flexDirection: "column", gap: 7,
    overflowY: "auto", flexShrink: 0, borderRight: "1px solid #334155",
  },
  heading: {
    color: "#f1f5f9", fontSize: 12, fontWeight: 700, margin: "6px 0 2px",
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  hint: { color: "#64748b", fontSize: 11, margin: 0, lineHeight: 1.5 },
  label: { color: "#94a3b8", fontSize: 12, fontWeight: 600 },
  input: {
    background: "#0f172a", color: "#f1f5f9", border: "1px solid #334155",
    borderRadius: 6, padding: "8px 10px", fontSize: 13, outline: "none",
    width: "100%", boxSizing: "border-box",
  },
  geoBtn: {
    background: "#0f172a", color: "#38bdf8", border: "1px solid #0284c7",
    borderRadius: 6, padding: "8px", fontSize: 12, cursor: "pointer", fontWeight: 600,
  },
  txBtn: {
    padding: "11px", borderRadius: 6, border: "none",
    color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", marginTop: 6,
  },
  activeBadge: {
    background: "#052e16", color: "#86efac",
    borderRadius: 6, padding: "8px 10px", fontSize: 12,
    display: "flex", alignItems: "center", gap: 8,
  },
  pulseDot: {
    width: 8, height: 8, borderRadius: "50%", background: "#22c55e",
    animation: "pulse 1.2s infinite", flexShrink: 0,
  },
  divider: { borderTop: "1px solid #334155", margin: "10px 0 4px" },
  instructionBox: {
    background: "#0f172a", borderRadius: 8, padding: "12px 14px",
    display: "flex", flexDirection: "column", gap: 6,
  },
  instrStep: { color: "#94a3b8", fontSize: 12, margin: 0, lineHeight: 1.5 },
  code: {
    background: "#1e293b", color: "#38bdf8", borderRadius: 4,
    padding: "6px 8px", fontSize: 11, fontFamily: "monospace",
    wordBreak: "break-all",
  },
  logPanel: {
    flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
  },
  logHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 18px", borderBottom: "1px solid #334155", flexShrink: 0,
  },
  logTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 14 },
  clearBtn: {
    background: "#334155", color: "#94a3b8", border: "none",
    borderRadius: 5, padding: "4px 10px", cursor: "pointer", fontSize: 12,
  },
  logBody: { flex: 1, overflowY: "auto", padding: "8px 18px", display: "flex", flexDirection: "column", gap: 3 },
  logEmpty: { color: "#475569", fontSize: 13, marginTop: 20, textAlign: "center" },
  logRow: {
    display: "flex", alignItems: "center", gap: 10,
    fontFamily: "monospace", fontSize: 12,
    padding: "4px 0", borderBottom: "1px solid #1e293b",
  },
  logTime: { color: "#64748b", flexShrink: 0 },
  logOk: { color: "#22c55e", fontWeight: 700, flexShrink: 0 },
  logErr: { color: "#ef4444", fontWeight: 700, flexShrink: 0 },
  logCoord: { color: "#f59e0b", flex: 1 },
  logCount: { color: "#475569", flexShrink: 0 },
  logErrMsg: { color: "#fca5a5", fontSize: 11 },
};
