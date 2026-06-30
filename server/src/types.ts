// Wire protocol shared between client and server.
// (Mirrored in client/src/sync/types.ts)

export type SyncActionType = "I" | "U" | "D";

/** One atomic change that happened on the server, identified by a global syncId. */
export interface SyncActionPacket {
  /** The global, monotonically increasing sync id of this action. */
  id: number;
  modelName: string;
  modelId: string;
  action: SyncActionType;
  /** Full row data after the action (null for deletions). */
  data: Record<string, unknown> | null;
}

/** A client-originated operation. Executed exclusively on the server. */
export type TransactionPayload =
  | {
      type: "create";
      modelName: string;
      modelId: string;
      data: Record<string, unknown>;
    }
  | {
      type: "update";
      modelName: string;
      modelId: string;
      changes: Record<string, unknown>;
    }
  | {
      type: "delete";
      modelName: string;
      modelId: string;
    };

// ---- client -> server messages ----

export interface TransactionBatchMessage {
  kind: "transaction_batch";
  batchId: string;
  transactions: TransactionPayload[];
}

export type ClientMessage = TransactionBatchMessage;

// ---- server -> client messages ----

export interface HandshakeMessage {
  kind: "handshake";
  lastSyncId: number;
}

export interface DeltaMessage {
  kind: "delta";
  lastSyncId: number;
  actions: SyncActionPacket[];
}

export interface TransactionAckMessage {
  kind: "transaction_ack";
  batchId: string;
  /** lastSyncId after the batch was executed. 0 if nothing was accepted. */
  lastSyncId: number;
  results: { ok: boolean; error?: string }[];
}

export type ServerMessage =
  | HandshakeMessage
  | DeltaMessage
  | TransactionAckMessage;
