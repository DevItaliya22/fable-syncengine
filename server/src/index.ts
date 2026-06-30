import "dotenv/config";
import http from "node:http";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  executeBatch,
  getBootstrap,
  getDeltaSince,
  getLastSyncId,
} from "./syncEngine.js";
import type { ClientMessage, DeltaMessage, ServerMessage } from "./types.js";

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

/**
 * Full bootstrap: the client downloads a consistent snapshot of all models
 * and the lastSyncId that snapshot corresponds to.
 */
app.get("/sync/bootstrap", async (_req, res) => {
  try {
    res.json(await getBootstrap());
  } catch (err) {
    console.error("[bootstrap] failed", err);
    res.status(500).json({ error: "bootstrap failed" });
  }
});

/**
 * Incremental sync / gap recovery: all sync actions with syncId > from.
 * Used for local bootstrap catch-up and when a client detects missed packets.
 */
app.get("/sync/delta", async (req, res) => {
  const from = Number(req.query.from ?? 0);
  if (!Number.isFinite(from) || from < 0) {
    res.status(400).json({ error: "invalid 'from'" });
    return;
  }
  try {
    res.json(await getDeltaSince(from));
  } catch (err) {
    console.error("[delta] failed", err);
    res.status(500).json({ error: "delta failed" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/sync" });

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Delta packets go to ALL connected clients, including the mutator. */
function broadcast(message: DeltaMessage) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on("connection", async (socket) => {
  console.log(`[ws] client connected (${wss.clients.size} total)`);

  // Handshake: tell the client the current lastSyncId so it can detect
  // missed deltas and catch up over REST before processing live packets.
  try {
    send(socket, { kind: "handshake", lastSyncId: await getLastSyncId() });
  } catch (err) {
    console.error("[ws] handshake failed", err);
    socket.close();
    return;
  }

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (message.kind !== "transaction_batch") return;
    if (
      !Array.isArray(message.transactions) ||
      typeof message.batchId !== "string"
    )
      return;

    try {
      const { results, actions, lastSyncId } = await executeBatch(
        message.transactions,
      );

      // 1. broadcast the resulting delta packet to everyone
      if (actions.length > 0) {
        broadcast({ kind: "delta", lastSyncId, actions });
      }
      // 2. ack the mutator so it can complete/rollback its transactions
      send(socket, {
        kind: "transaction_ack",
        batchId: message.batchId,
        lastSyncId,
        results,
      });
    } catch (err) {
      console.error("[ws] batch execution failed", err);
      send(socket, {
        kind: "transaction_ack",
        batchId: message.batchId,
        lastSyncId: 0,
        results: message.transactions.map(() => ({
          ok: false,
          error: "internal error",
        })),
      });
    }
  });

  socket.on("close", () => {
    console.log(`[ws] client disconnected (${wss.clients.size} total)`);
  });
  socket.on("error", (err) => {
    console.error("[ws] socket error", err);
  });
});

// Heartbeat: drop dead connections so broadcasts don't pile up.
const aliveSockets = new WeakSet<WebSocket>();
wss.on("connection", (socket) => {
  aliveSockets.add(socket);
  socket.on("pong", () => aliveSockets.add(socket));
});
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!aliveSockets.has(client)) {
      client.terminate();
      continue;
    }
    aliveSockets.delete(client);
    client.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`sync server listening on http://localhost:${PORT}`);
  console.log(`  REST  GET /sync/bootstrap | GET /sync/delta?from=N`);
  console.log(`  WS    ws://localhost:${PORT}/sync`);
});
