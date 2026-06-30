import { setSyncContext } from "./context";
import { LocalDatabase } from "./Database";
import { createModelFromData } from "./Model";
import { ObjectPool } from "./ObjectPool";
import { ModelRegistry } from "./ModelRegistry";
import { Signal } from "./signal";
import { TransactionQueue } from "./TransactionQueue";
import type {
  BootstrapResponse,
  DeltaResponse,
  ServerMessage,
  SyncActionPacket,
} from "./types";

const SERVER_URL: string =
  (import.meta.env.VITE_SYNC_SERVER_URL as string | undefined) ??
  "http://localhost:4000";
const WS_URL = SERVER_URL.replace(/^http/, "ws") + "/sync";

export type ConnectionStatus = "connecting" | "connected" | "offline";

/**
 * The SyncClient orchestrates the whole engine:
 *
 *  1. Bootstrap — full (download everything from the server) when the local
 *     database is empty or migrated; local (hydrate from IndexedDB, then
 *     catch up with /sync/delta) otherwise.
 *  2. Replay persisted transactions cached from a previous session.
 *  3. Open a WebSocket; the handshake's lastSyncId reveals missed packets,
 *     which are fetched over REST before live deltas are processed.
 *  4. Apply delta packets strictly in order (one at a time): write the
 *     confirmed state to IndexedDB, update in-memory models in the Object
 *     Pool, rebase pending transactions (LWW), advance lastSyncId and
 *     resolve transactions waiting on it.
 */
export class SyncClient {
  readonly db = new LocalDatabase();
  readonly pool = new ObjectPool();
  readonly transactionQueue: TransactionQueue;

  lastSyncId = 0;
  firstSyncId = 0;

  status: ConnectionStatus = "offline";
  readonly statusSignal = new Signal();
  readonly syncSignal = new Signal();

  /** UI toggle for demoing offline mode. */
  intentionallyOffline = false;

  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes delta processing so packets are applied fully, in order. */
  private applyChain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.transactionQueue = new TransactionQueue(this.pool, this.db);
    setSyncContext({
      pool: this.pool,
      transactionQueue: this.transactionQueue,
    });
  }

  // ---- bootstrapping ----

  async bootstrap(): Promise<void> {
    await this.db.open();

    const storedLastSyncId = await this.db.getMeta<number>("lastSyncId");
    if (storedLastSyncId === undefined) {
      await this.fullBootstrap();
    } else {
      await this.localBootstrap(storedLastSyncId);
    }

    // Replay transactions cached from a previous session on top of the
    // hydrated state; they'll be resent once the socket is open.
    const persisted = await this.db.getAllTransactions();
    this.transactionQueue.loadPersisted(persisted);

    this.connect();
  }

  /** Download a full snapshot from the server and persist it locally. */
  private async fullBootstrap(): Promise<void> {
    const res = await fetch(`${SERVER_URL}/sync/bootstrap`);
    if (!res.ok) throw new Error(`bootstrap failed: HTTP ${res.status}`);
    const body = (await res.json()) as BootstrapResponse;

    await this.db.writeBootstrap(body.models, body.lastSyncId);
    this.lastSyncId = body.lastSyncId;
    this.firstSyncId = body.lastSyncId;

    for (const [modelName, rows] of Object.entries(body.models)) {
      if (!ModelRegistry.hasModel(modelName)) continue;
      for (const row of rows) {
        this.pool.add(createModelFromData(modelName, row));
      }
    }
    this.syncSignal.notify();
  }

  /** Hydrate from IndexedDB, then catch up on missed deltas over REST. */
  private async localBootstrap(storedLastSyncId: number): Promise<void> {
    this.lastSyncId = storedLastSyncId;
    this.firstSyncId =
      (await this.db.getMeta<number>("firstSyncId")) ?? storedLastSyncId;

    for (const modelName of ModelRegistry.modelsWithLoadStrategy("instant")) {
      const rows = await this.db.getAllModelData(modelName);
      for (const row of rows) {
        this.pool.add(createModelFromData(modelName, row));
      }
    }
    this.syncSignal.notify();

    try {
      await this.catchUp();
    } catch {
      // Offline start is fine: we serve local data and catch up on connect.
    }
  }

  /** Fetches and applies every sync action after our lastSyncId. */
  private async catchUp(): Promise<void> {
    const res = await fetch(`${SERVER_URL}/sync/delta?from=${this.lastSyncId}`);
    if (!res.ok) throw new Error(`delta fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as DeltaResponse;
    if (body.actions.length > 0 || body.lastSyncId > this.lastSyncId) {
      await this.applyDelta(body.actions, body.lastSyncId);
    }
  }

  // ---- connection management ----

  connect(): void {
    if (this.intentionallyOffline) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.setStatus("connecting");

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(message);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.transactionQueue.onDisconnected();
      this.setStatus("offline");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  /** Demo helper: simulate losing/regaining the connection. */
  setIntentionallyOffline(offline: boolean): void {
    this.intentionallyOffline = offline;
    if (offline) {
      this.ws?.close();
    } else {
      this.reconnectDelay = 1000;
      this.connect();
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyOffline || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusSignal.notify();
  }

  // ---- message handling ----

  private handleMessage(message: ServerMessage): void {
    switch (message.kind) {
      case "handshake": {
        // Catch up on anything we missed while disconnected, THEN start
        // sending cached/pending transactions.
        this.enqueueApply(async () => {
          if (message.lastSyncId > this.lastSyncId) {
            const res = await fetch(
              `${SERVER_URL}/sync/delta?from=${this.lastSyncId}`,
            );
            if (res.ok) {
              const body = (await res.json()) as DeltaResponse;
              await this.applyActionsInternal(body.actions, body.lastSyncId);
            }
          }
          this.reconnectDelay = 1000;
          this.setStatus("connected");
          const ws = this.ws;
          this.transactionQueue.setSender((batch) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(batch));
            }
          });
        });
        break;
      }
      case "delta": {
        void this.applyDelta(message.actions, message.lastSyncId);
        break;
      }
      case "transaction_ack": {
        // Process under the same lock as deltas so completion checks see a
        // consistent lastSyncId.
        this.enqueueApply(async () => {
          this.transactionQueue.handleAck(message, this.lastSyncId);
        });
        break;
      }
    }
  }

  // ---- applying deltas ----

  private enqueueApply<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn();
    const result = this.applyChain.then(run, run);
    this.applyChain = result.catch((err) => {
      console.error("[sync] failed to apply delta", err);
    });
    return result;
  }

  applyDelta(actions: SyncActionPacket[], lastSyncId: number): Promise<void> {
    return this.enqueueApply(async () => {
      // Gap detection: if the packet starts beyond lastSyncId + 1 we missed
      // something — recover the full range over REST instead.
      const fresh = actions.filter((a) => a.id > this.lastSyncId);
      if (fresh.length > 0 && fresh[0].id > this.lastSyncId + 1) {
        const res = await fetch(
          `${SERVER_URL}/sync/delta?from=${this.lastSyncId}`,
        );
        if (res.ok) {
          const body = (await res.json()) as DeltaResponse;
          await this.applyActionsInternal(body.actions, body.lastSyncId);
          return;
        }
      }
      await this.applyActionsInternal(fresh, lastSyncId);
    });
  }

  /** Must only run inside the apply chain. */
  private async applyActionsInternal(
    actions: SyncActionPacket[],
    lastSyncId: number,
  ): Promise<void> {
    const fresh = actions.filter(
      (a) => a.id > this.lastSyncId && ModelRegistry.hasModel(a.modelName),
    );
    if (fresh.length === 0 && lastSyncId <= this.lastSyncId) return;

    // 1. Persist confirmed state + new lastSyncId atomically to IndexedDB.
    await this.db.applyActions(fresh, Math.max(lastSyncId, this.lastSyncId));

    // 2. Update in-memory models in the Object Pool.
    for (const action of fresh) {
      if (action.action === "D") {
        this.pool.remove(action.modelId);
        continue;
      }
      if (!action.data) continue;

      if (action.action === "I") {
        // Cancel any pending CreationTransaction for the same UUID.
        this.transactionQueue.modelUpserted(action.modelId);
      }

      const existing = this.pool.get(action.modelId);
      if (existing) {
        existing.updateFromData(action.data);
      } else {
        this.pool.add(createModelFromData(action.modelName, action.data));
      }

      // 3. Rebase pending local updates on top of the new server state
      //    (last-writer-wins: local pending values stay applied in memory,
      //    rollback targets become the fresh server values).
      this.transactionQueue.rebaseForAction(action);
    }

    // 4. Advance the local sync position.
    if (lastSyncId > this.lastSyncId) {
      this.lastSyncId = lastSyncId;
    }
    this.syncSignal.notify();

    // 5. Complete transactions that were waiting for this lastSyncId.
    this.transactionQueue.progressSyncWaiters(this.lastSyncId);
  }
}
