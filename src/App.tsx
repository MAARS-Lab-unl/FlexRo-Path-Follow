import React, { useState } from "react";
import ConnectScreen from "./ConnectScreen";
import MapScreen from "./MapScreen";
import SenderScreen from "./SenderScreen";
import { ConnectionConfig } from "./types";

export default function App() {
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);

  if (!connection) {
    return <ConnectScreen onConnected={setConnection} />;
  }

  if (connection.mode === "sender") {
    return <SenderScreen connection={connection} onDisconnect={() => setConnection(null)} />;
  }

  return <MapScreen connection={connection} onDisconnect={() => setConnection(null)} />;
}
