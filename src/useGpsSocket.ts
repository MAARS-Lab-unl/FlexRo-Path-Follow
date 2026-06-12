import { useEffect, useRef, useCallback } from "react";
import { GpsPacket } from "./types";

const WS_URL = process.env.REACT_APP_WS_URL || "ws://localhost:8000/ws/gps";

export function useGpsSocket(onPacket: (p: GpsPacket) => void, enabled: boolean) {
  const wsRef = useRef<WebSocket | null>(null);
  const onPacketRef = useRef(onPacket);
  onPacketRef.current = onPacket;

  const connect = useCallback(() => {
    if (wsRef.current) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as GpsPacket;
        if (data.type === "gps") onPacketRef.current(data);
      } catch {}
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (enabled) setTimeout(connect, 2000); // auto-reconnect
    };

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 15000);

    ws.onclose = () => {
      clearInterval(ping);
      wsRef.current = null;
      if (enabled) setTimeout(connect, 2000);
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      wsRef.current?.close();
      wsRef.current = null;
    }
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, connect]);
}
