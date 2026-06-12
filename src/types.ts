export interface GpsPacket {
  type: "gps";
  receive_time_utc: string;
  lat: number;
  lon: number;
  timestamp_utc?: string;
  source: string;
  raw?: string;
}

export type AppMode = "receiver" | "sender";
export type AppScreen = "connect" | "map" | "sender";

export interface ConnectionConfig {
  port: string;
  baud: number;
  mode: AppMode;
}
