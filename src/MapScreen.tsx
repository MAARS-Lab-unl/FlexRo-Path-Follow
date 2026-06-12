import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  GoogleMap,
  useJsApiLoader,
  Marker,
  Polyline,
  InfoWindow,
} from "@react-google-maps/api";
import { GpsPacket, ConnectionConfig } from "./types";
import { useGpsSocket } from "./useGpsSocket";
import { api } from "./api";
import { haversineMeters, formatDistance, bearingDeg } from "./geoUtils";

const MAP_CONTAINER_STYLE = { width: "100%", height: "100%" };
const DEFAULT_CENTER = { lat: 32.7767, lng: -96.797 };
const MAX_TRAIL = 300;

interface Props {
  connection: ConnectionConfig;
  onDisconnect: () => void;
}

export default function MapScreen({ connection, onDisconnect }: Props) {
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY || "",
  });

  // ATV state
  const [atvPos, setAtvPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [atvTrail, setAtvTrail] = useState<google.maps.LatLngLiteral[]>([]);
  const [lastPacket, setLastPacket] = useState<GpsPacket | null>(null);
  const [showAtvInfo, setShowAtvInfo] = useState(false);
  const [packetCount, setPacketCount] = useState(0);
  const [pairedDeviceId, setPairedDeviceId] = useState("");

  // Robot self-position (from browser geolocation)
  const [robotPos, setRobotPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [showRobotInfo, setShowRobotInfo] = useState(false);

  // Simulation
  const [simRunning, setSimRunning] = useState(false);

  // RX log
  const [rxLogs, setRxLogs] = useState<GpsPacket[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const mapRef = useRef<google.maps.Map | null>(null);
  const firstFix = useRef(false);

  // Get robot's own position and push to backend for radio transmit back to ATV
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setRobotPos({ lat, lng });
        api.robotPosition(lat, lng);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
    // Start robot transmit loop automatically when receiver connects
    api.robotTransmitStart(1.0);
    return () => {
      navigator.geolocation.clearWatch(watch);
      api.robotTransmitStop();
    };
  }, []);

  const onPacket = useCallback((p: GpsPacket) => {
    const pos = { lat: p.lat, lng: p.lon };
    setAtvPos(pos);
    setLastPacket(p);
    setPacketCount((n) => n + 1);
    if (p.device_id) setPairedDeviceId(p.device_id);
    setAtvTrail((prev) => {
      const next = [...prev, pos];
      return next.length > MAX_TRAIL ? next.slice(next.length - MAX_TRAIL) : next;
    });
    setRxLogs((prev) => {
      const next = [...prev, p];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
    setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    if (!firstFix.current && mapRef.current) {
      mapRef.current.panTo(pos);
      mapRef.current.setZoom(17);
      firstFix.current = true;
    } else if (mapRef.current) {
      mapRef.current.panTo(pos);
    }
  }, []);

  useGpsSocket(onPacket, true);

  async function handleDisconnect() {
    if (simRunning) await api.simulateStop();
    await api.disconnect();
    onDisconnect();
  }

  async function handleSimToggle() {
    if (simRunning) {
      await api.simulateStop();
      setSimRunning(false);
    } else {
      const seedLat = robotPos?.lat ?? 32.7767;
      const seedLon = robotPos?.lng ?? -96.797;
      const res = await api.simulateStart(seedLat, seedLon, 1.0);
      if (res.ok) setSimRunning(true);
    }
  }

  if (loadError) {
    return (
      <div style={styles.root}>
        <div style={styles.errBanner}>
          Google Maps failed to load — check <code>REACT_APP_GOOGLE_MAPS_API_KEY</code> in <code>.env</code>
        </div>
      </div>
    );
  }

  const elapsed = lastPacket ? new Date(lastPacket.receive_time_utc).toLocaleTimeString() : null;
  const paired = !!atvPos;

  const distance =
    atvPos && robotPos
      ? haversineMeters(robotPos.lat, robotPos.lng, atvPos.lat, atvPos.lng)
      : null;

  const bearing =
    atvPos && robotPos
      ? bearingDeg(robotPos.lat, robotPos.lng, atvPos.lat, atvPos.lng)
      : null;

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <span style={styles.topTitle}>FlexRo Path Follow</span>
        <div style={styles.modePill}>📡 Robot Receiver</div>
        <div style={styles.devicePill}>{connection.deviceId}</div>
        <span style={styles.connPill}>
          <span style={styles.greenDot} />
          {connection.port} @ {connection.baud}
        </span>
        {simRunning && <div style={styles.simPill}>SIMULATION</div>}
        {paired ? (
          <span style={styles.pairedPill}>
            ✓ Paired · {pairedDeviceId} · {packetCount} fixes
            {distance !== null && <> · {formatDistance(distance)}</>}
            {bearing !== null && <> · {Math.round(bearing)}°</>}
          </span>
        ) : (
          <span style={styles.waitingPill}>Waiting for ATV GPS…</span>
        )}
        <button style={styles.discBtn} onClick={handleDisconnect}>Disconnect</button>
      </div>

      {/* Body: panel | map | rx log */}
      <div style={styles.body}>

        {/* Left panel — simplified */}
        <div style={styles.panel}>
          {/* Pairing status card */}
          <h3 style={styles.heading}>Pairing Status</h3>
          <div style={{ ...styles.statusCard, borderColor: paired ? "#22c55e" : "#334155" }}>
            <div style={styles.statusRow}>
              <span style={styles.statusLabel}>ATV</span>
              <span style={{ ...styles.statusVal, color: paired ? "#f59e0b" : "#475569" }}>
                {paired ? pairedDeviceId : "Not paired"}
              </span>
            </div>
            <div style={styles.statusRow}>
              <span style={styles.statusLabel}>Robot</span>
              <span style={{ ...styles.statusVal, color: "#38bdf8" }}>{connection.deviceId}</span>
            </div>
            {distance !== null && (
              <div style={styles.statusRow}>
                <span style={styles.statusLabel}>Distance</span>
                <span style={{ ...styles.statusVal, color: "#f1f5f9" }}>{formatDistance(distance)}</span>
              </div>
            )}
            {bearing !== null && (
              <div style={styles.statusRow}>
                <span style={styles.statusLabel}>Bearing</span>
                <span style={{ ...styles.statusVal, color: "#f1f5f9" }}>{Math.round(bearing)}°</span>
              </div>
            )}
            {atvPos && (
              <div style={styles.statusRow}>
                <span style={styles.statusLabel}>ATV coords</span>
                <span style={{ ...styles.statusVal, color: "#f59e0b", fontSize: 10 }}>
                  {atvPos.lat.toFixed(5)}, {atvPos.lng.toFixed(5)}
                </span>
              </div>
            )}
            {robotPos && (
              <div style={styles.statusRow}>
                <span style={styles.statusLabel}>Robot coords</span>
                <span style={{ ...styles.statusVal, color: "#38bdf8", fontSize: 10 }}>
                  {robotPos.lat.toFixed(5)}, {robotPos.lng.toFixed(5)}
                </span>
              </div>
            )}
          </div>

          <div style={styles.divider} />

          {/* Simulation */}
          <h3 style={styles.heading}>Simulate ATV</h3>
          <p style={styles.hint}>Simulates ATV moving in a circle from robot's current position.</p>
          <button
            style={{ ...styles.btn, background: simRunning ? "#f59e0b" : "#8b5cf6" }}
            onClick={handleSimToggle}
          >
            {simRunning ? "Stop Simulation" : "Start Simulation"}
          </button>
          {simRunning && <div style={styles.badge}>Simulating ATV movement…</div>}

          <div style={styles.divider} />

          {/* Map controls */}
          <h3 style={styles.heading}>Map</h3>
          <button style={{ ...styles.btn, background: "#334155" }} onClick={() => {
            setAtvTrail([]); setPacketCount(0); setRxLogs([]);
          }}>
            Clear ATV Trail
          </button>
        </div>

        {/* Map */}
        <div style={styles.mapWrap}>
          {!isLoaded ? (
            <div style={styles.loading}>Loading Google Maps…</div>
          ) : (
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              center={atvPos ?? robotPos ?? DEFAULT_CENTER}
              zoom={atvPos ? 17 : 4}
              options={{ mapTypeId: "hybrid", fullscreenControl: true, mapTypeControl: true }}
              onLoad={(map) => { mapRef.current = map; }}
            >
              {/* ATV trail */}
              {atvTrail.length > 1 && (
                <Polyline
                  path={atvTrail}
                  options={{ strokeColor: "#f59e0b", strokeOpacity: 0.9, strokeWeight: 3 }}
                />
              )}

              {/* Distance line between robot and ATV */}
              {atvPos && robotPos && (
                <Polyline
                  path={[robotPos, atvPos]}
                  options={{ strokeColor: "#a78bfa", strokeOpacity: 0.6, strokeWeight: 1.5, strokeDashArray: "6 4" } as any}
                />
              )}

              {/* ATV marker */}
              {atvPos && (
                <Marker
                  position={atvPos}
                  onClick={() => setShowAtvInfo((v) => !v)}
                  title={`ATV: ${pairedDeviceId}`}
                  icon={{
                    path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                    scale: 6,
                    fillColor: "#f59e0b",
                    fillOpacity: 1,
                    strokeColor: "#fff",
                    strokeWeight: 1.5,
                  }}
                >
                  {showAtvInfo && lastPacket && (
                    <InfoWindow onCloseClick={() => setShowAtvInfo(false)}>
                      <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                        <strong>{pairedDeviceId} (ATV)</strong><br />
                        Lat: {lastPacket.lat.toFixed(7)}<br />
                        Lon: {lastPacket.lon.toFixed(7)}<br />
                        Fixes: {packetCount}<br />
                        Time: {elapsed}
                        {distance !== null && <><br />Distance: {formatDistance(distance)}</>}
                      </div>
                    </InfoWindow>
                  )}
                </Marker>
              )}

              {/* Robot marker */}
              {robotPos && (
                <Marker
                  position={robotPos}
                  onClick={() => setShowRobotInfo((v) => !v)}
                  title={`Robot: ${connection.deviceId}`}
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
                        <strong>{connection.deviceId} (Robot)</strong><br />
                        Lat: {robotPos.lat.toFixed(7)}<br />
                        Lng: {robotPos.lng.toFixed(7)}
                        {distance !== null && <><br />Distance to ATV: {formatDistance(distance)}</>}
                        {bearing !== null && <><br />Bearing to ATV: {Math.round(bearing)}°</>}
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
                  <div style={{ color: "#f1f5f9", fontWeight: 700, marginBottom: 6 }}>
                    Waiting for ATV GPS signal
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13 }}>
                    Connected as <strong style={{ color: "#38bdf8" }}>{connection.deviceId}</strong>. Waiting for ATV to broadcast over the RFD 900x-US link.
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>
                    No hardware? Click <strong style={{ color: "#a78bfa" }}>Start Simulation</strong> in the left panel.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RX log */}
        <div style={styles.logPanel}>
          <div style={styles.logHeader}>
            <span style={styles.logTitle}>RX Log</span>
            <button style={styles.clearBtn} onClick={() => setRxLogs([])}>Clear</button>
          </div>
          <div style={styles.logBody}>
            {rxLogs.length === 0 && (
              <div style={styles.logEmpty}>No packets received yet.</div>
            )}
            {rxLogs.map((p, i) => (
              <div key={i} style={{ ...styles.logRow, opacity: i === rxLogs.length - 1 ? 1 : 0.65 }}>
                <span style={styles.logTime}>{new Date(p.receive_time_utc).toLocaleTimeString()}</span>
                <span style={styles.logOk}>✓</span>
                <span style={styles.logCoord}>{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</span>
                <span style={styles.logSrc}>{p.device_id || p.source}</span>
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
  topBar: { display: "flex", alignItems: "center", gap: 8, background: "#1e293b", padding: "10px 18px", borderBottom: "1px solid #334155", flexShrink: 0, flexWrap: "wrap" },
  topTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 15 },
  modePill: { background: "#0c4a6e", color: "#7dd3fc", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 },
  devicePill: { background: "#1e3a5f", color: "#93c5fd", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700, fontFamily: "monospace" },
  connPill: { background: "#052e16", color: "#86efac", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  greenDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block" },
  simPill: { background: "#422006", color: "#fde68a", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 800, letterSpacing: 1 },
  pairedPill: { background: "#052e16", color: "#4ade80", borderRadius: 20, padding: "3px 12px", fontSize: 12, fontFamily: "monospace", flex: 1 },
  waitingPill: { color: "#475569", fontSize: 12, fontStyle: "italic", flex: 1 },
  discBtn: { marginLeft: "auto", background: "#7f1d1d", color: "#fca5a5", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13 },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  panel: { width: 240, background: "#1e293b", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", flexShrink: 0, borderRight: "1px solid #334155" },
  heading: { color: "#f1f5f9", fontSize: 11, fontWeight: 700, margin: "6px 0 2px", textTransform: "uppercase", letterSpacing: 0.5 },
  hint: { color: "#64748b", fontSize: 11, margin: 0, lineHeight: 1.5 },
  statusCard: { background: "#0f172a", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6, border: "1px solid #334155" },
  statusRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  statusLabel: { color: "#64748b", fontSize: 11 },
  statusVal: { fontSize: 12, fontWeight: 600, fontFamily: "monospace" },
  divider: { borderTop: "1px solid #334155", margin: "6px 0 2px" },
  btn: { padding: "9px", borderRadius: 6, border: "none", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  badge: { background: "#422006", color: "#fde68a", borderRadius: 6, padding: "7px 10px", fontSize: 11, textAlign: "center" },
  mapWrap: { flex: 1, position: "relative" },
  loading: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", fontSize: 16 },
  errBanner: { background: "#450a0a", color: "#fca5a5", padding: 24, borderRadius: 8, margin: 40, fontSize: 15 },
  noFixOverlay: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,0.65)", backdropFilter: "blur(4px)", pointerEvents: "none" },
  noFixBox: { background: "#1e293b", borderRadius: 12, padding: "28px 32px", maxWidth: 380, display: "flex", gap: 16, alignItems: "flex-start", pointerEvents: "auto" },
  pulse: { width: 16, height: 16, borderRadius: "50%", background: "#38bdf8", flexShrink: 0, marginTop: 3, animation: "pulse 1.5s infinite" },
  logPanel: { width: 240, display: "flex", flexDirection: "column", overflow: "hidden", borderLeft: "1px solid #334155", flexShrink: 0 },
  logHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #334155", flexShrink: 0, background: "#1e293b" },
  logTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 13 },
  clearBtn: { background: "#334155", color: "#94a3b8", border: "none", borderRadius: 5, padding: "3px 8px", cursor: "pointer", fontSize: 11 },
  logBody: { flex: 1, overflowY: "auto", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 2 },
  logEmpty: { color: "#475569", fontSize: 12, marginTop: 16, textAlign: "center" },
  logRow: { display: "flex", alignItems: "center", gap: 6, fontFamily: "monospace", fontSize: 11, padding: "3px 0", borderBottom: "1px solid #1e293b" },
  logTime: { color: "#64748b", flexShrink: 0 },
  logOk: { color: "#22c55e", fontWeight: 700, flexShrink: 0 },
  logCoord: { color: "#38bdf8", flex: 1 },
  logSrc: { color: "#475569", fontSize: 10, flexShrink: 0 },
};
