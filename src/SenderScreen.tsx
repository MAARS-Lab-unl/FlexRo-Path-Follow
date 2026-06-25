import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  GoogleMap,
  useJsApiLoader,
  Marker,
  Polyline,
  InfoWindow,
} from "@react-google-maps/api";
import { api } from "./api";
import { ConnectionConfig } from "./types";
import { haversineMeters, formatDistance } from "./geoUtils";

const WS_BASE = process.env.REACT_APP_WS_URL || "ws://localhost:8000/ws/gps";
const WS_TX_URL    = WS_BASE.replace("/ws/gps", "/ws/tx");
const WS_ROBOT_URL = WS_BASE.replace("/ws/gps", "/ws/robot");
const WS_MAV_URL   = WS_BASE.replace("/ws/gps", "/ws/mav");

const MAP_CONTAINER_STYLE = { width: "100%", height: "100%" };
const DEFAULT_CENTER = { lat: 32.7767, lng: -96.797 };
const MAX_TRAIL = 300;

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
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY || "",
  });

  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [intervalSec, setIntervalSec] = useState(1.0);
  const [transmitting, setTransmitting] = useState(false);
  const [logs, setLogs] = useState<TxLog[]>([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [totalSent, setTotalSent] = useState(0);

  // Map state
  const [atvPos, setAtvPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [trail, setTrail] = useState<google.maps.LatLngLiteral[]>([]);
  // Robot position received back over radio
  const [robotPos, setRobotPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [robotDeviceId, setRobotDeviceId] = useState("ROBOT");
  const [showRobotInfo, setShowRobotInfo] = useState(false);
  // MAVLink / Cube Orange GPS state
  const [mavConnected, setMavConnected] = useState(false);
  const [mavFixType, setMavFixType] = useState(0);
  const [mavSatellites, setMavSatellites] = useState(0);
  const [atvHeading, setAtvHeading] = useState<number>(0);
  const [speedMps, setSpeedMps] = useState<number>(0);
  const mavWsRef = useRef<WebSocket | null>(null);

  const mapRef = useRef<google.maps.Map | null>(null);
  const firstFix = useRef(false);

  const logEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const robotWsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const connectWs = useCallback(() => {
    const ws = new WebSocket(WS_TX_URL);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as TxLog;
        setTotalSent(data.count);
        // Use live MAVLink coords for the log entry if available
        setLogs((prev) => {
          const next = [...prev, data];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
        // Don't update trail/map from TX log — MAVLink WebSocket drives the map
      } catch {}
    };
    ws.onclose = () => { wsRef.current = null; };
  }, []);

  useEffect(() => {
    connectWs();
    return () => { wsRef.current?.close(); };
  }, [connectWs]);

  // Robot GPS coming back over radio
  useEffect(() => {
    const ws = new WebSocket(WS_ROBOT_URL);
    robotWsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "robot_gps") {
          setRobotPos({ lat: data.lat, lng: data.lon });
          setRobotDeviceId(data.device_id || "ROBOT");
        }
      } catch {}
    };
    ws.onclose = () => { robotWsRef.current = null; };
    return () => ws.close();
  }, []);

  // MAVLink GPS WebSocket — live GPS from Cube Orange
  useEffect(() => {
    if (!connection.mavPort) return;  // Only connect if MAVLink was configured
    // Trigger backend to connect to Cube Orange
    api.mavlinkConnect(connection.mavPort, connection.mavBaud ?? 115200).then((r) => {
      if (r.ok) setMavConnected(true);
    });
    const ws = new WebSocket(WS_MAV_URL);
    mavWsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "mav_gps") {
          setMavFixType(data.fix_type ?? 0);
          setMavSatellites(data.satellites ?? 0);
          setMavConnected(true);
          // Auto-fill coordinates if not already transmitting
          if (data.lat && data.lon) {
            setLat(data.lat.toFixed(7));
            setLon(data.lon.toFixed(7));
            const pos = { lat: data.lat, lng: data.lon };
            // Use COG from GPS if available, else compute from last two positions
            if (data.speed_mps != null) setSpeedMps(data.speed_mps);
          if (data.cog != null) {
              setAtvHeading(data.cog);
            } else {
              setAtvPos((prev) => {
                if (prev) {
                  const dx = data.lon - prev.lng;
                  const dy = data.lat - prev.lat;
                  if (Math.abs(dx) > 1e-7 || Math.abs(dy) > 1e-7) {
                    const computed = (Math.atan2(dx, dy) * 180) / Math.PI;
                    setAtvHeading((computed + 360) % 360);
                  }
                }
                return prev;
              });
            }
            setAtvPos(pos);
            setTrail((prev) => {
              const next = [...prev, pos];
              return next.length > MAX_TRAIL ? next.slice(next.length - MAX_TRAIL) : next;
            });
            if (mapRef.current) {
              if (!firstFix.current) {
                mapRef.current.panTo(pos);
                mapRef.current.setZoom(17);
                firstFix.current = true;
              } else {
                mapRef.current.panTo(pos);
              }
            }
          }
        }
      } catch {}
    };
    ws.onclose = () => { mavWsRef.current = null; };
    return () => {
      ws.close();
      api.mavlinkDisconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore state on mount (page refresh)
  useEffect(() => {
    api.status().then((s) => {
      if (s.tx_lat) setLat(String(s.tx_lat));
      if (s.tx_lon) setLon(String(s.tx_lon));
      if (s.tx_interval) setIntervalSec(s.tx_interval);
      if (s.tx_running) setTransmitting(true);
      if (s.tx_count) setTotalSent(s.tx_count);
      if (s.mav_connected) setMavConnected(true);
      if (s.mav_fix_type) setMavFixType(s.mav_fix_type);
      if (s.mav_satellites) setMavSatellites(s.mav_satellites);
      // Restore map position
      if (s.tx_lat && s.tx_lon) {
        const pos = { lat: s.tx_lat, lng: s.tx_lon };
        setAtvPos(pos);
        setTrail([pos]);
      }
    });
  }, []);

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
      const res = await api.transmitStart(latN, lonN, intervalSec);
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
        <div style={styles.devicePill}>{connection.deviceId}</div>
        <span style={styles.connPill}>
          <span style={styles.greenDot} />
          {connection.port} @ {connection.baud}
        </span>
        {connection.mavPort && (
          mavConnected ? (
            <span style={styles.mavPill}>
              🛰 Cube Orange · Fix {mavFixType} · {mavSatellites} sats
            </span>
          ) : (
            <span style={styles.mavWaitPill}>🛰 Connecting to Cube Orange…</span>
          )
        )}
        {transmitting && (
          <span style={styles.txPill}>
            <span style={styles.pulseDot} />
            TX ACTIVE — {totalSent} packets sent
          </span>
        )}
        {robotPos ? (
          <span style={styles.pairedPill}>
            ✓ Robot paired · {robotDeviceId}
            {atvPos && ` · ${formatDistance(haversineMeters(atvPos.lat, atvPos.lng, robotPos.lat, robotPos.lng))}`}
          </span>
        ) : (
          <span style={styles.waitingPill}>Waiting for robot GPS…</span>
        )}
        <button style={styles.discBtn} onClick={handleDisconnect}>Disconnect</button>
      </div>

      {/* Body: panel | map | log */}
      <div style={styles.body}>

        {/* Left — controls */}
        <div style={styles.panel}>
          <h3 style={styles.heading}>ATV GPS Position</h3>
          {connection.mavPort ? (
            <div style={{
              ...styles.mavCard,
              borderColor: mavConnected ? (mavFixType >= 3 ? "#22c55e" : "#f59e0b") : "#334155",
            }}>
              <div style={styles.mavCardTitle}>Cube Orange</div>
              {mavConnected ? (
                <>
                  <div style={styles.mavStat}>
                    <span style={{ color: mavFixType >= 3 ? "#22c55e" : "#f59e0b" }}>
                      {mavFixType >= 3 ? "✓ 3D Fix" : mavFixType >= 2 ? "⚠ 2D Fix" : "✗ No Fix"}
                    </span>
                    <span style={{ color: "#64748b" }}>{mavSatellites} sats</span>
                  </div>
                  <div style={{ color: "#64748b", fontSize: 10 }}>
                    GPS auto-fills below. Edit manually to override.
                  </div>
                </>
              ) : (
                <div style={{ color: "#64748b", fontSize: 11 }}>Connecting to {connection.mavPort}…</div>
              )}
            </div>
          ) : (
            <p style={styles.hint}>
              Set coordinates to transmit over RFD 900x-US to the robot.
            </p>
          )}

          {!connection.mavPort && (
            <button style={styles.geoBtn} onClick={loadCurrentLocation} disabled={geoLoading}>
              {geoLoading ? "Locating…" : "Use My Current Location"}
            </button>
          )}

          <label style={styles.label}>Latitude</label>
          <input
            style={styles.input} value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="e.g. 32.7767" type="number" step="any"
            disabled={transmitting}
          />

          <label style={styles.label}>Longitude</label>
          <input
            style={styles.input} value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="e.g. -96.7970" type="number" step="any"
            disabled={transmitting}
          />

          <label style={styles.label}>Interval (seconds)</label>
          <input
            style={styles.input} type="number" min={0.1} step={0.1}
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            disabled={transmitting}
          />

          {connection.mavPort && !transmitting && mavFixType < 3 && (
            <div style={{ color: "#f59e0b", fontSize: 11, textAlign: "center", padding: "4px 0" }}>
              Waiting for GPS fix ({mavFixType < 1 ? "no signal" : mavFixType === 1 ? "no fix" : "2D fix"})…
            </div>
          )}
          <button
            style={{
              ...styles.txBtn,
              background: transmitting ? "#dc2626" : "#16a34a",
              opacity: (!transmitting && connection.mavPort && mavFixType < 3) ? 0.4 : 1,
              cursor: (!transmitting && connection.mavPort && mavFixType < 3) ? "not-allowed" : "pointer",
            }}
            onClick={handleToggle}
            disabled={!transmitting && !!connection.mavPort && mavFixType < 3}
          >
            {transmitting ? "⏹ Stop Transmitting" : "▶ Start Transmitting"}
          </button>

          {transmitting && (
            <div style={styles.activeBadge}>
              Transmitting every {intervalSec}s
            </div>
          )}
        </div>

        {/* Center — map */}
        <div style={styles.mapWrap}>
          {!isLoaded ? (
            <div style={styles.loading}>Loading Google Maps…</div>
          ) : (
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              center={atvPos ?? DEFAULT_CENTER}
              zoom={atvPos ? 17 : 4}
              options={{ mapTypeId: "hybrid", fullscreenControl: true, mapTypeControl: true }}
              onLoad={(map) => { mapRef.current = map; }}
            >
              {trail.length > 1 && (
                <Polyline
                  path={trail}
                  options={{ strokeColor: "#f59e0b", strokeOpacity: 0.9, strokeWeight: 3 }}
                />
              )}
              {atvPos && (
                <Marker
                  position={atvPos}
                  title="ATV position"
                  icon={{
                    path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                    scale: 6,
                    fillColor: "#f59e0b",
                    fillOpacity: 1,
                    strokeColor: "#fff",
                    strokeWeight: 1.5,
                    rotation: atvHeading,
                  }}
                />
              )}

              {/* Distance line ATV ↔ Robot */}
              {atvPos && robotPos && (
                <Polyline
                  path={[atvPos, robotPos]}
                  options={{ strokeColor: "#a78bfa", strokeOpacity: 0.6, strokeWeight: 1.5, strokeDashArray: "6 4" } as any}
                />
              )}

              {/* Robot marker — blue circle */}
              {robotPos && (
                <Marker
                  position={robotPos}
                  onClick={() => setShowRobotInfo((v) => !v)}
                  title={`Robot: ${robotDeviceId}`}
                  icon={{
                    path: window.google.maps.SymbolPath.CIRCLE,
                    scale: 8,
                    fillColor: "#38bdf8",
                    fillOpacity: 1,
                    strokeColor: "#fff",
                    strokeWeight: 2,
                  }}
                >
                  {showRobotInfo && (
                    <InfoWindow onCloseClick={() => setShowRobotInfo(false)}>
                      <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                        <strong>{robotDeviceId} (Robot)</strong><br />
                        Lat: {robotPos.lat.toFixed(7)}<br />
                        Lng: {robotPos.lng.toFixed(7)}
                        {atvPos && <><br />Distance to ATV: {formatDistance(haversineMeters(robotPos.lat, robotPos.lng, atvPos.lat, atvPos.lng))}</>}
                      </div>
                    </InfoWindow>
                  )}
                </Marker>
              )}
            </GoogleMap>
          )}
          {isLoaded && !atvPos && (
            <div style={styles.noFixOverlay}>
              <div style={styles.noFixBox}>
                <div style={styles.pulse} />
                <div>
                  <div style={{ color: "#f1f5f9", fontWeight: 700, marginBottom: 4 }}>
                    No position yet
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13 }}>
                    Enter coordinates and click Start Transmitting.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Speedometer — top-right corner of map */}
        <div style={{
          position: "absolute", top: 12, right: 12, zIndex: 10,
          background: "rgba(255,255,255,0.92)", backdropFilter: "blur(6px)",
          border: "1px solid #cbd5e1", borderRadius: 12,
          padding: "10px 16px", textAlign: "center", minWidth: 90,
        }}>
          <div style={{ color: "#0f172a", fontSize: 32, fontWeight: 800, fontFamily: "monospace", lineHeight: 1 }}>
            {(speedMps * 3.6).toFixed(1)}
          </div>
          <div style={{ color: "#475569", fontSize: 11, marginTop: 2 }}>km/h</div>
          <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 4 }}>
            {speedMps.toFixed(2)} m/s
          </div>
        </div>

        {/* Right — TX log pinned to bottom-right corner */}
        <div style={{
          position: "absolute", bottom: 0, right: 0,
          width: 260, height: "50%",
          display: "flex", flexDirection: "column",
          background: "#0f172a",
          borderLeft: "1px solid #334155", borderTop: "1px solid #334155",
          zIndex: 10,
        }}>
          <div style={styles.logHeader}>
            <span style={styles.logTitle}>TX Log</span>
            <button style={styles.clearBtn} onClick={() => setLogs([])}>Clear</button>
          </div>
          <div style={styles.logBody}>
            {logs.length === 0 && (
              <div style={styles.logEmpty}>No packets yet.</div>
            )}
            {logs.map((l, i) => (
              <div key={i} style={{ ...styles.logRow, opacity: i === logs.length - 1 ? 1 : 0.65 }}>
                <span style={styles.logTime}>{new Date(l.time).toLocaleTimeString()}</span>
                <span style={l.sent ? styles.logOk : styles.logErr}>{l.sent ? "✓" : "✗"}</span>
                <span style={styles.logCoord}>{l.lat.toFixed(5)}, {l.lon.toFixed(5)}</span>
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
  root: { display: "flex", flexDirection: "column", height: "100vh", background: "#0f172a", fontFamily: "'Segoe UI', system-ui, sans-serif" },
  topBar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#1e293b", padding: "10px 18px", borderBottom: "1px solid #334155", flexShrink: 0 },
  topTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 15 },
  modePill: { background: "#422006", color: "#fde68a", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 },
  devicePill: { background: "#1e3a5f", color: "#93c5fd", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700, fontFamily: "monospace" },
  connPill: { background: "#052e16", color: "#86efac", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  greenDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block" },
  txPill: { background: "#052e16", color: "#4ade80", borderRadius: 20, padding: "3px 12px", fontSize: 12, fontFamily: "monospace", flex: 1, display: "flex", alignItems: "center", gap: 6 },
  pulseDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", flexShrink: 0, animation: "pulse 1.2s infinite" },
  pairedPill: { background: "#052e16", color: "#4ade80", borderRadius: 20, padding: "3px 12px", fontSize: 12, fontFamily: "monospace" },
  waitingPill: { color: "#475569", fontSize: 12, fontStyle: "italic" },
  mavPill: { background: "#1e1b4b", color: "#a5b4fc", borderRadius: 20, padding: "3px 12px", fontSize: 12, fontFamily: "monospace" },
  mavWaitPill: { color: "#475569", fontSize: 12, fontStyle: "italic" },
  mavCard: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 4 },
  mavCardTitle: { color: "#a78bfa", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.5 },
  mavStat: { display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600 },
  discBtn: { marginLeft: "auto", background: "#7f1d1d", color: "#fca5a5", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13 },
  body: { display: "flex", flex: 1, overflow: "hidden", position: "relative" },
  panel: { width: 240, background: "#1e293b", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", flexShrink: 0, borderRight: "1px solid #334155" },
  heading: { color: "#f1f5f9", fontSize: 11, fontWeight: 700, margin: "6px 0 2px", textTransform: "uppercase", letterSpacing: 0.5 },
  hint: { color: "#64748b", fontSize: 11, margin: 0, lineHeight: 1.5 },
  label: { color: "#94a3b8", fontSize: 12, fontWeight: 600 },
  input: { background: "#0f172a", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 6, padding: "7px 10px", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" },
  geoBtn: { background: "#0f172a", color: "#38bdf8", border: "1px solid #0284c7", borderRadius: 6, padding: "7px", fontSize: 12, cursor: "pointer", fontWeight: 600 },
  txBtn: { padding: "10px", borderRadius: 6, border: "none", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", marginTop: 4 },
  activeBadge: { background: "#052e16", color: "#86efac", borderRadius: 6, padding: "7px 10px", fontSize: 11, textAlign: "center" },
  mapWrap: { flex: 1, position: "relative" },
  loading: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", fontSize: 16 },
  noFixOverlay: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,0.6)", backdropFilter: "blur(4px)", pointerEvents: "none" },
  noFixBox: { background: "#1e293b", borderRadius: 12, padding: "24px 28px", maxWidth: 320, display: "flex", gap: 14, alignItems: "flex-start", pointerEvents: "auto" },
  pulse: { width: 14, height: 14, borderRadius: "50%", background: "#f59e0b", flexShrink: 0, marginTop: 3, animation: "pulse 1.5s infinite" },
  logPanel: { display: "none" },
  logHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #334155", flexShrink: 0, background: "#1e293b" },
  logTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 13 },
  clearBtn: { background: "#334155", color: "#94a3b8", border: "none", borderRadius: 5, padding: "3px 8px", cursor: "pointer", fontSize: 11 },
  logBody: { flex: 1, overflowY: "auto", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 2 },
  logEmpty: { color: "#475569", fontSize: 12, marginTop: 16, textAlign: "center" },
  logRow: { display: "flex", alignItems: "center", gap: 6, fontFamily: "monospace", fontSize: 11, padding: "3px 0", borderBottom: "1px solid #1e293b" },
  logTime: { color: "#64748b", flexShrink: 0 },
  logOk: { color: "#22c55e", fontWeight: 700, flexShrink: 0 },
  logErr: { color: "#ef4444", fontWeight: 700, flexShrink: 0 },
  logCoord: { color: "#f59e0b", flex: 1 },
  logCount: { color: "#475569", flexShrink: 0 },
  logErrMsg: { color: "#fca5a5", fontSize: 10 },
};
