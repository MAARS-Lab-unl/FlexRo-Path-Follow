import React, { useState, useCallback, useRef } from "react";
import {
  GoogleMap,
  useJsApiLoader,
  Marker,
  Polyline,
  InfoWindow,
} from "@react-google-maps/api";
import { GpsPacket, ConnectionConfig } from "./types";
import { useGpsSocket } from "./useGpsSocket";
import CoordPanel from "./CoordPanel";
import { api } from "./api";

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

  // ATV position (what the receiver picks up from the radio)
  const [atvPos, setAtvPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [atvTrail, setAtvTrail] = useState<google.maps.LatLngLiteral[]>([]);
  const [lastPacket, setLastPacket] = useState<GpsPacket | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [packetCount, setPacketCount] = useState(0);
  const mapRef = useRef<google.maps.Map | null>(null);
  const firstFix = useRef(false);

  const onPacket = useCallback((p: GpsPacket) => {
    const pos = { lat: p.lat, lng: p.lon };
    setAtvPos(pos);
    setLastPacket(p);
    setPacketCount((n) => n + 1);
    setAtvTrail((prev) => {
      const next = [...prev, pos];
      return next.length > MAX_TRAIL ? next.slice(next.length - MAX_TRAIL) : next;
    });
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

  async function handleSimStart(lat: number, lon: number, interval: number) {
    const res = await api.simulateStart(lat, lon, interval);
    if (res.ok) setSimRunning(true);
  }

  async function handleSimStop() {
    await api.simulateStop();
    setSimRunning(false);
  }

  function handleClearTrail() {
    setAtvTrail([]);
    setPacketCount(0);
  }

  if (loadError) {
    return (
      <div style={styles.root}>
        <div style={styles.errBanner}>
          Google Maps failed to load — check <code>REACT_APP_GOOGLE_MAPS_API_KEY</code> in <code>frontend/.env</code>
        </div>
      </div>
    );
  }

  const elapsed = lastPacket
    ? new Date(lastPacket.receive_time_utc).toLocaleTimeString()
    : null;

  return (
    <div style={styles.root}>
      {/* ── Top bar ── */}
      <div style={styles.topBar}>
        <span style={styles.topTitle}>FlexRo Path Follow</span>

        <div style={styles.connPill}>
          <span style={styles.greenDot} />
          Robot receiver: {connection.port} @ {connection.baud}
        </div>

        {simRunning && (
          <div style={styles.simPill}>SIMULATION</div>
        )}

        {atvPos ? (
          <span style={styles.coordPill}>
            ATV &nbsp;
            {lastPacket!.lat.toFixed(6)}, {lastPacket!.lon.toFixed(6)}
            &nbsp;·&nbsp; {packetCount} fixes &nbsp;·&nbsp; {elapsed}
          </span>
        ) : (
          <span style={styles.waitingPill}>Waiting for ATV GPS…</span>
        )}

        <button style={styles.discBtn} onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>

      {/* ── Body ── */}
      <div style={styles.body}>
        <CoordPanel
          connected={true}
          simRunning={simRunning}
          onSent={(lat, lon) =>
            onPacket({
              type: "gps",
              receive_time_utc: new Date().toISOString(),
              lat,
              lon,
              source: "manual",
            })
          }
          onSimStart={handleSimStart}
          onSimStop={handleSimStop}
          onClearTrail={handleClearTrail}
        />

        <div style={styles.mapWrap}>
          {!isLoaded ? (
            <div style={styles.loading}>Loading Google Maps…</div>
          ) : (
            <GoogleMap
              mapContainerStyle={MAP_CONTAINER_STYLE}
              center={atvPos ?? DEFAULT_CENTER}
              zoom={atvPos ? 17 : 4}
              options={{
                mapTypeId: "hybrid",
                fullscreenControl: true,
                mapTypeControl: true,
              }}
              onLoad={(map) => { mapRef.current = map; }}
            >
              {/* ATV path trail */}
              {atvTrail.length > 1 && (
                <Polyline
                  path={atvTrail}
                  options={{
                    strokeColor: "#f59e0b",
                    strokeOpacity: 0.9,
                    strokeWeight: 3,
                  }}
                />
              )}

              {/* ATV marker (source of GPS signal) */}
              {atvPos && (
                <Marker
                  position={atvPos}
                  onClick={() => setShowInfo((v) => !v)}
                  title="ATV (GPS source)"
                  icon={{
                    path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                    scale: 6,
                    fillColor: "#f59e0b",
                    fillOpacity: 1,
                    strokeColor: "#fff",
                    strokeWeight: 1.5,
                  }}
                >
                  {showInfo && lastPacket && (
                    <InfoWindow onCloseClick={() => setShowInfo(false)}>
                      <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                        <strong>ATV GPS Fix</strong><br />
                        Lat: {lastPacket.lat.toFixed(7)}<br />
                        Lon: {lastPacket.lon.toFixed(7)}<br />
                        Source: {lastPacket.source}<br />
                        Fixes received: {packetCount}<br />
                        Time: {elapsed}
                      </div>
                    </InfoWindow>
                  )}
                </Marker>
              )}
            </GoogleMap>
          )}

          {/* No-fix overlay */}
          {isLoaded && !atvPos && (
            <div style={styles.noFixOverlay}>
              <div style={styles.noFixBox}>
                <div style={styles.pulse} />
                <div>
                  <div style={{ color: "#f1f5f9", fontWeight: 700, marginBottom: 6 }}>
                    Waiting for ATV GPS signal
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13 }}>
                    The robot receiver is connected. Waiting for the ATV to
                    broadcast its position over the RFD 900x-US radio link.
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>
                    No hardware? Start <strong style={{ color: "#a78bfa" }}>Simulation Mode</strong> in the panel on the left.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#0f172a",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#1e293b",
    padding: "10px 18px",
    borderBottom: "1px solid #334155",
    flexShrink: 0,
    flexWrap: "wrap",
  },
  topTitle: { color: "#f1f5f9", fontWeight: 700, fontSize: 15, marginRight: 4 },
  connPill: {
    background: "#052e16",
    color: "#86efac",
    borderRadius: 20,
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  greenDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#22c55e",
    display: "inline-block",
  },
  simPill: {
    background: "#422006",
    color: "#fde68a",
    borderRadius: 20,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 1,
  },
  coordPill: {
    background: "#0f172a",
    color: "#f59e0b",
    borderRadius: 20,
    padding: "3px 12px",
    fontSize: 12,
    fontFamily: "monospace",
    flex: 1,
  },
  waitingPill: {
    color: "#475569",
    fontSize: 12,
    fontStyle: "italic",
    flex: 1,
  },
  discBtn: {
    marginLeft: "auto",
    background: "#7f1d1d",
    color: "#fca5a5",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  mapWrap: { flex: 1, position: "relative" },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#94a3b8",
    fontSize: 16,
  },
  errBanner: {
    background: "#450a0a",
    color: "#fca5a5",
    padding: 24,
    borderRadius: 8,
    margin: 40,
    fontSize: 15,
  },
  noFixOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(15,23,42,0.65)",
    backdropFilter: "blur(4px)",
    pointerEvents: "none",
  },
  noFixBox: {
    background: "#1e293b",
    borderRadius: 12,
    padding: "28px 32px",
    maxWidth: 380,
    display: "flex",
    gap: 16,
    alignItems: "flex-start",
    pointerEvents: "auto",
  },
  pulse: {
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "#38bdf8",
    flexShrink: 0,
    marginTop: 3,
    animation: "pulse 1.5s infinite",
  },
};
