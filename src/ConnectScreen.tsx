import React, { useState, useEffect } from "react";
import { api } from "./api";
import { ConnectionConfig, AppMode } from "./types";

interface Props {
  onConnected: (cfg: ConnectionConfig & { mavPort?: string; mavBaud?: number }) => void;
}

type Status = "idle" | "connecting" | "success" | "error";

interface PortInfo {
  port: string;
  description: string;
  manufacturer: string;
  type: "rfd" | "cube" | "serial";
}

export default function ConnectScreen({ onConnected }: Props) {
  const [mode, setMode] = useState<AppMode>("receiver");
  const [port, setPort] = useState("/dev/ttyUSB0");
  const [baud, setBaud] = useState(57600);
  const [deviceId, setDeviceId] = useState("");
  const [mavPort, setMavPort] = useState("COM7");
  const [mavBaud, setMavBaud] = useState(115200);
  const [useMavlink, setUseMavlink] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [scanningPorts, setScanningPorts] = useState(false);

  const defaultDeviceId = mode === "sender" ? "ATV-1" : "ROBOT-1";
  const finalDeviceId = deviceId.trim() || defaultDeviceId;

  async function scanPorts() {
    setScanningPorts(true);
    try {
      const res = await api.ports();
      const list: PortInfo[] = res.ports || [];
      setPorts(list);
      // Auto-fill best guesses
      const rfd = list.find((p) => p.type === "rfd");
      const cube = list.find((p) => p.type === "cube");
      if (rfd) setPort(rfd.port);
      if (cube) {
        setMavPort(cube.port);
        if (mode === "sender") setUseMavlink(true);
      }
    } catch {
      // silently ignore if backend not up yet
    } finally {
      setScanningPorts(false);
    }
  }

  useEffect(() => {
    scanPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setStatus("connecting");
    setErrorMsg("");
    try {
      const res = await api.connect(port, baud, finalDeviceId);
      if (!res.ok) {
        setStatus("error");
        setErrorMsg(res.error || "Connection failed");
        return;
      }
      setStatus("success");
      setTimeout(
        () =>
          onConnected({
            port,
            baud,
            mode,
            deviceId: finalDeviceId,
            mavPort: useMavlink ? mavPort : undefined,
            mavBaud: useMavlink ? mavBaud : undefined,
          }),
        800
      );
    } catch {
      setStatus("error");
      setErrorMsg("Could not reach backend — is the server running on this machine?");
    }
  }

  const isReceiver = mode === "receiver";
  const senderReady = isReceiver || !useMavlink || mavPort.trim().length > 0;
  const rfdPorts = ports.filter((p) => p.type === "rfd");
  const cubePorts = ports.filter((p) => p.type === "cube");
  const otherPorts = ports.filter((p) => p.type === "serial");

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
            <span style={styles.modeSub}>Robot side</span>
          </button>
          <button
            style={{ ...styles.modeBtn, ...(!isReceiver ? styles.modeBtnActiveYellow : {}) }}
            onClick={() => { setMode("sender"); setStatus("idle"); }}
          >
            <span style={styles.modeIcon}>🚜</span>
            <span>Sender</span>
            <span style={styles.modeSub}>ATV side</span>
          </button>
        </div>

        {/* Diagram */}
        <div style={styles.diagram}>
          {isReceiver ? (
            <>
              <DiagramNode color="#f59e0b" label="ATV" sub="GPS + RFD 900x-US" />
              <DiagramArrow label="~~ radio ~~" />
              <DiagramNode color="#38bdf8" label="Robot" sub="RFD 900x-US" highlight />
              <DiagramArrow label="USB" />
              <DiagramNode color="#a78bfa" label="This UI" sub="Ground control" />
            </>
          ) : (
            <>
              <DiagramNode color="#f59e0b" label="Cube Orange" sub="MAVLink GPS" highlight />
              <DiagramArrow label="USB" />
              <DiagramNode color="#a78bfa" label="This UI" sub="Sender" highlight />
              <DiagramArrow label="~~ RFD radio ~~" />
              <DiagramNode color="#38bdf8" label="Robot" sub="RFD 900x-US" />
            </>
          )}
        </div>

        <p style={styles.subtitle}>
          {isReceiver
            ? "Connect to the RFD 900x-US on the robot. The map will stream the ATV's live position."
            : "Connect to the RFD 900x-US on the ATV. Optionally connect Cube Orange for live GPS."}
        </p>

        {/* Port scanner */}
        <div style={styles.scanRow}>
          <span style={styles.label}>Detected USB ports</span>
          <button style={styles.scanBtn} onClick={scanPorts} disabled={scanningPorts}>
            {scanningPorts ? "Scanning…" : "Rescan"}
          </button>
        </div>
        {ports.length > 0 ? (
          <div style={styles.portList}>
            {rfdPorts.map((p) => (
              <PortChip key={p.port} port={p} tag="RFD" tagColor="#f59e0b"
                onSelect={() => setPort(p.port)} selected={port === p.port} />
            ))}
            {cubePorts.map((p) => (
              <PortChip key={p.port} port={p} tag="Cube" tagColor="#a78bfa"
                onSelect={() => { setMavPort(p.port); if (mode === "sender") setUseMavlink(true); }}
                selected={mavPort === p.port} />
            ))}
            {otherPorts.map((p) => (
              <PortChip key={p.port} port={p} tag="Serial" tagColor="#64748b"
                onSelect={() => setPort(p.port)} selected={port === p.port} />
            ))}
          </div>
        ) : (
          <div style={styles.noPortsHint}>
            {scanningPorts ? "Scanning…" : "No USB serial ports found. Connect hardware and rescan."}
          </div>
        )}

        <label style={styles.label}>Device ID</label>
        <input
          style={styles.input}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          placeholder={defaultDeviceId}
          disabled={status === "connecting"}
        />

        <label style={styles.label}>RFD 900x-US Serial Port</label>
        <input
          style={styles.input}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="/dev/ttyUSB0"
          disabled={status === "connecting"}
        />

        <label style={styles.label}>RFD Baud Rate</label>
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

        {/* Cube Orange / MAVLink section — sender only */}
        {!isReceiver && (
          <div style={styles.mavSection}>
            <div style={styles.mavHeader}>
              <span style={styles.mavTitle}>Cube Orange GPS (MAVLink)</span>
              <label style={styles.toggle}>
                <input
                  type="checkbox"
                  checked={useMavlink}
                  onChange={(e) => setUseMavlink(e.target.checked)}
                />
                <span style={{ marginLeft: 6 }}>{useMavlink ? "Enabled" : "Disabled"}</span>
              </label>
            </div>
            {useMavlink && (
              <>
                <label style={styles.label}>Cube Orange Port</label>
                <input
                  style={styles.input}
                  value={mavPort}
                  onChange={(e) => setMavPort(e.target.value)}
                  placeholder="COM7 or /dev/ttyACM0"
                  disabled={status === "connecting"}
                />
                <label style={styles.label}>MAVLink Baud Rate</label>
                <select
                  style={styles.input}
                  value={mavBaud}
                  onChange={(e) => setMavBaud(Number(e.target.value))}
                  disabled={status === "connecting"}
                >
                  {[57600, 115200].map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <p style={styles.mavHint}>
                  Live GPS will be read from Cube Orange and transmitted over the RFD radio to the robot.
                </p>
              </>
            )}
          </div>
        )}

        <button
          style={{
            ...styles.btn,
            background: status === "success" ? "#22c55e" : isReceiver ? "#3b82f6" : "#d97706",
            opacity: (status === "connecting" || !senderReady) ? 0.4 : 1,
          }}
          onClick={handleConnect}
          disabled={status === "connecting" || status === "success" || !senderReady}
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

function PortChip({ port, tag, tagColor, onSelect, selected }: {
  port: PortInfo; tag: string; tagColor: string; onSelect: () => void; selected: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: selected ? "rgba(255,255,255,0.06)" : "#0f172a",
        border: `1px solid ${selected ? tagColor : "#334155"}`,
        borderRadius: 8, padding: "7px 10px", cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      <span style={{
        background: tagColor, color: "#000", fontSize: 10, fontWeight: 700,
        borderRadius: 4, padding: "1px 5px",
      }}>{tag}</span>
      <span style={{ color: "#f1f5f9", fontSize: 12, fontWeight: 600 }}>{port.port}</span>
      <span style={{ color: "#64748b", fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {port.description}
      </span>
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
    background: "#1e293b", borderRadius: 16, padding: "36px 44px", width: 480,
    boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
    display: "flex", flexDirection: "column", gap: 8,
    maxHeight: "95vh", overflowY: "auto",
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
  scanRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  scanBtn: {
    background: "#334155", color: "#94a3b8", border: "none", borderRadius: 6,
    padding: "4px 10px", fontSize: 12, cursor: "pointer",
  },
  portList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 4 },
  noPortsHint: { color: "#475569", fontSize: 12, padding: "6px 0" },
  label: { color: "#cbd5e1", fontSize: 13, fontWeight: 600, marginTop: 8 },
  input: {
    background: "#0f172a", color: "#f1f5f9", border: "1px solid #334155",
    borderRadius: 8, padding: "10px 14px", fontSize: 14, outline: "none", marginTop: 4,
  },
  mavSection: {
    background: "#0f172a", border: "1px solid #7c3aed44", borderRadius: 10,
    padding: "12px 14px", marginTop: 12, display: "flex", flexDirection: "column", gap: 4,
  },
  mavHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  mavTitle: { color: "#a78bfa", fontSize: 13, fontWeight: 700 },
  toggle: { display: "flex", alignItems: "center", color: "#94a3b8", fontSize: 12, cursor: "pointer" },
  mavHint: { color: "#64748b", fontSize: 11, margin: "6px 0 0" },
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
