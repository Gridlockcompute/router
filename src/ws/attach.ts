import type { Server } from "node:http";
import type { ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { workerHub } from "./hub.js";

export function attachWebSocketServer(server: ServerType): void {
  const wss = new WebSocketServer({ noServer: true });
  const httpServer = server as unknown as Server;

  wss.on("connection", (ws) => {
    console.log("[ws] client connected");
    workerHub.attach(ws);
    ws.send(JSON.stringify({ type: "connected", path: "/v1/ws" }));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/v1/ws")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  console.log("[ws] WebSocket server on /v1/ws");
}
