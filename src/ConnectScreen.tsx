import React, { useState } from "react";
import { api } from "./api";
import { ConnectionConfig, AppMode } from "./types";

interface Props {
  onConnected: (cfg: ConnectionConfig) => void;
}

type Status = "idle" | "connecting" | "success" | "error";

export default function ConnectScreen({ onConnected }: Props) {
  const [mode, setMode] = useState<AppMode>("receiver");
  const [port, setPort] = useState("/dev/ttyUSB0");
  const [baud, setBaud] = useState(57600);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleConnect() {
    setStatus("connecting");
    setErrorMsg("");
    try {
      const res = await api.connect(port, baud);
      if (res.ok) {
        setStatus("success");
        setTimeout(() => onConnected({ port, baud, mode }), 800);
      } else {
        setStatus("error");
        setErrorMsg(res.error || "Connection failed");
      }
    } catch {
      setStatus("error");
      setErrorMsg("Could not reach backend — is the server running on this machine?");
    }
  }

  const isReceiver = mode === "receiver";

  return (
    <div style={styles.root}>
      <div style={styles.card}>
        <div style={styles.logoRow}>
          <div style={styles.dot} />
          <span style={styles.logoText}>FlexRo Path Follow</span>
        </div>

        <h1 style={styles.title}>Ground Control</h1>

        {/* Mode selector */}
        <div style={styles.modeRow}>
          <button
            style={{ ...styles.modeBtn, ...(isReceiver ? styles.modeBtnActiveBlue : {}) }}
            onClick={() => { setMode("receiver"); setStatus("idle"); }}
          >
            <span style={styles.modeIcon}>📡</span>
            <span>Receiver</span>
            <span style={styles.modeSub}>Robot side — shows ATV on map</span>
          </button>
          <button
            style={{ ...styles.modeBtn, ...(!isReceiver ? styles.modeBtnActiveYellow : {}) }}
            onClick={() => { setMode("sender"); setStatus("idle"); }}
          >
            <span style={styles.modeIcon}>🚜</span>
            <span>Sender</span>
            <span style={styles.modeSub}>ATV side — transmits GPS</span>
          </button>
        </div>

        {/* Diagram */}
        <div style={styles.diagram}>
          {isReceiver ? (
            <>
              <DiagramNode color="#f59e0b" label="ATV" sub="GPS + RFD 900x-US" />
              <DiagramArrow label="~~ radio ~~" />
              <DiagramNode color="#38bdf8" label="Robot" sub="RFD 900x-US" highlight />
              <DiagramArrow label="USB serial" />
              <DiagramNode color="#a78bfa" label="This UI" sub="Ground control" />
            </>
          ) : (
            <>
              <DiagramNode color="#f59e0b" label="ATV" sub="RFD 900x-US" highlight />
              <DiagramArrow label="USB serial" />
              <DiagramNode color="#a78bfa" label="This UI" sub="Sender control" />
              <DiagramArrow label="~~ radio ~~" />
              <DiagramNode color="#38bdf8" label="Robot" sub="RFD 900x-US" />
            </>
          )}
        </div>

        <p style={styles.subtitle}>
          {isReceiver
            ? "Connect to the RFD 900x-US on the robot. The map will stream the ATV's live position."
            : "Connect to the RFD 900x-US on the ATV. This UI will continuously transmit GPS to the robot."}
        </p>

        <label style={styles.label}>Serial Port</label>
        <input
          style={styles.input}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="/dev/ttyUSB0"
          disabled={status === "connecting"}
        />

        <label style={styles.label}>Baud Rate</label>
        <select
          style={styles.input}
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={status === "connecting"}
        >
          {[9600, 19200, 38400, 57600, 115200].map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        <button
          style={{
            ...styles.btn,
            background: status === "success" ? "#22c55e" : isReceiver ? "#3b82f6" : "#d97706",
            opacity: status === "connecting" ? 0.7 : 1,
          }}
          onClick={handleConnect}
          disabled={status === "connecting" || status === "success"}
        >
          {status === "connecting"
            ? "Connecting…"
            : status === "success"
            ? "Connected!"
            : isReceiver ? "Connect as Receiver" : "Connect as Sender"}
        </button>

        {status === "error" && (
          <div style={styles.errorBox}>
            <strong>Error:</strong> {errorMsg}
          </div>
        )}
        {status === "success" && (
          <div style={styles.successBox}>
            Connected to {port} at {baud} baud. Loading {isReceiver ? "map" : "sender"} screen…
          </div>
        )}

        <div style={styles.divider} />
        <p style={styles.simHint}>
          No hardware? Use <strong>Simulation Mode</strong> on the next screen.
        </p>
      </div>
    </div>
  );
}

function DiagramNode({ color, label, sub, highlight }: {
  color: string; label: string; sub: string; highlight?: boolean;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: 4, flex: 1,
      background: highlight ? "rgba(255,255,255,0.05)" : "transparent",
      borderRadius: 8, padding: "6px 4px",
    }}>
      <div style={{
        width: 12, height: 12, borderRadius: "50%", background: color,
        boxShadow: highlight ? `0 0 8px ${color}` : "none",
      }} />
      <span style={{ color: "#f1f5f9", fontSize: 13, fontWeight: 700 }}>{label}</span>
      <span style={{ color: "#64748b", fontSize: 10, textAlign: "center" }}>{sub}</span>
    </div>
  );
}

function DiagramArrow({ label }: { label: string }) {
  return (
    <div style={{ color: "#334155", fontSize: 10, flexShrink: 0, padding: "0 2px", textAlign: "center", marginTop: 8 }}>
      {label}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  card: {
    background: "#1e293b", borderRadius: 16, padding: "36px 44px", width: 460,
    boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
    display: "flex", flexDirection: "column", gap: 8,
  },
  logoRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  dot: { width: 10, height: 10, borderRadius: "50%", background: "#38bdf8" },
  logoText: { color: "#38bdf8", fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" },
  title: { color: "#f1f5f9", margin: 0, fontSize: 24, fontWeight: 700 },
  modeRow: { display: "flex", gap: 10, margin: "8px 0" },
  modeBtn: {
    flex: 1, background: "#0f172a", border: "2px solid #334155", borderRadius: 10,
    padding: "12px 8px", cursor: "pointer",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    color: "#64748b", fontSize: 14, fontWeight: 700, transition: "all 0.15s",
  },
  modeBtnActiveBlue: { border: "2px solid #3b82f6", color: "#f1f5f9", background: "#1e3a5f" },
  modeBtnActiveYellow: { border: "2px solid #d97706", color: "#f1f5f9", background: "#422006" },
  modeIcon: { fontSize: 22 },
  modeSub: { color: "#64748b", fontSize: 10, fontWeight: 400 },
  diagram: {
    display: "flex", alignItems: "center",
    background: "#0f172a", borderRadius: 10, padding: "12px 8px", marginBottom: 4,
  },
  subtitle: { color: "#94a3b8", margin: "4px 0 8px", fontSize: 13, lineHeight: 1.6 },
  label: { color: "#cbd5e1", fontSize: 13, fontWeight: 600, marginTop: 8 },
  input: {
    background: "#0f172a", color: "#f1f5f9", border: "1px solid #334155",
    borderRadius: 8, padding: "10px 14px", fontSize: 14, outline: "none", marginTop: 4,
  },
  btn: {
    marginTop: 20, padding: "12px 0", borderRadius: 8, border: "none",
    color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer",
  },
  errorBox: {
    background: "#450a0a", color: "#fca5a5",
    borderRadius: 8, padding: "10px 14px", fontSize: 13, marginTop: 8,
  },
  successBox: {
    background: "#052e16", color: "#86efac",
    borderRadius: 8, padding: "10px 14px", fontSize: 13, marginTop: 8,
  },
  divider: { borderTop: "1px solid #334155", margin: "16px 0 8px" },
  simHint: { color: "#64748b", fontSize: 12, textAlign: "center", margin: 0 },
};
