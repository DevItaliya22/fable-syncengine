import { createModelFromData, type Model } from "./Model";
import type { ObjectPool } from "./ObjectPool";
import type { TransactionPayload } from "./types";

export type TransactionType = "create" | "update" | "delete";

/** Shape persisted to the `_transactions` IndexedDB store. */
export interface SerializedTransaction {
  id: string;
  type: TransactionType;
  modelName: string;
  modelId: string;
  /** Replay order across restarts. */
  seq: number;
  batchIndex: number;
  /** create: full persisted snapshot of the new model. */
  data?: Record<string, unknown>;
  /** update: propertyName -> updated value. */
  changes?: Record<string, unknown>;
}

let seqCounter = Date.now();
function nextSeq(): number {
  return ++seqCounter;
}

/**
 * Transactions encapsulate operations on models. They execute exclusively on
 * the server and are reversible on the client (rollback) in case of
 * rejection. While pending, they are cached in IndexedDB so they survive
 * restarts and reconnects.
 */
export abstract class BaseTransaction {
  /** Mutable so deserialized transactions keep their persisted identity. */
  id: string = crypto.randomUUID();
  seq: number = nextSeq();
  abstract readonly type: TransactionType;

  /** Transactions sharing a batchIndex are sent to the server together. */
  batchIndex = 0;

  /**
   * Set when the server acks the transaction: the syncId whose delta packet
   * must arrive before the transaction counts as fully synced.
   */
  syncIdNeededForCompletion: number | null = null;

  readonly modelName: string;
  readonly modelId: string;

  constructor(modelName: string, modelId: string) {
    this.modelName = modelName;
    this.modelId = modelId;
  }

  abstract payload(): TransactionPayload;
  abstract serialize(): SerializedTransaction;
  /** Reverts the optimistic in-memory effect of this transaction. */
  abstract rollback(pool: ObjectPool): void;
}

export class CreationTransaction extends BaseTransaction {
  readonly type = "create" as const;

  /** Snapshot of the model's persisted data at creation time. */
  readonly data: Record<string, unknown>;

  constructor(
    modelName: string,
    modelId: string,
    data: Record<string, unknown>,
  ) {
    super(modelName, modelId);
    this.data = data;
  }

  static forModel(model: Model): CreationTransaction {
    return new CreationTransaction(
      model.modelName,
      model.id,
      model.serializePersisted(),
    );
  }

  payload(): TransactionPayload {
    return {
      type: "create",
      modelName: this.modelName,
      modelId: this.modelId,
      data: this.data,
    };
  }

  serialize(): SerializedTransaction {
    return {
      id: this.id,
      type: this.type,
      modelName: this.modelName,
      modelId: this.modelId,
      seq: this.seq,
      batchIndex: this.batchIndex,
      data: this.data,
    };
  }

  rollback(pool: ObjectPool): void {
    pool.remove(this.modelId);
  }
}

export class UpdatingTransaction extends BaseTransaction {
  readonly type = "update" as const;

  /** propertyName -> { original (pre-change value), updated (new value) }. */
  readonly changeSnapshot: Record<
    string,
    { original: unknown; updated: unknown }
  >;

  constructor(
    modelName: string,
    modelId: string,
    changeSnapshot: Record<string, { original: unknown; updated: unknown }>,
  ) {
    super(modelName, modelId);
    this.changeSnapshot = changeSnapshot;
  }

  static forModel(model: Model): UpdatingTransaction {
    return new UpdatingTransaction(
      model.modelName,
      model.id,
      model.changeSnapshot(),
    );
  }

  payload(): TransactionPayload {
    const changes: Record<string, unknown> = {};
    for (const [name, change] of Object.entries(this.changeSnapshot)) {
      changes[name] = change.updated;
    }
    return {
      type: "update",
      modelName: this.modelName,
      modelId: this.modelId,
      changes,
    };
  }

  serialize(): SerializedTransaction {
    const changes: Record<string, unknown> = {};
    for (const [name, change] of Object.entries(this.changeSnapshot)) {
      changes[name] = change.updated;
    }
    return {
      id: this.id,
      type: this.type,
      modelName: this.modelName,
      modelId: this.modelId,
      seq: this.seq,
      batchIndex: this.batchIndex,
      changes,
    };
  }

  /** Rejected by the server: restore the original values. */
  rollback(pool: ObjectPool): void {
    const model = pool.get(this.modelId);
    if (!model) return;
    for (const [name, change] of Object.entries(this.changeSnapshot)) {
      model.setSilently(name, change.original);
    }
  }

  /**
   * Rebase against an incoming delta for the same model (last-writer-wins):
   * the delta's values become the new `original` (what rollback would
   * restore), while our pending change stays applied on top in memory.
   */
  rebase(pool: ObjectPool, data: Record<string, unknown>): void {
    const model = pool.get(this.modelId);
    for (const [name, change] of Object.entries(this.changeSnapshot)) {
      if (name in data) {
        change.original = data[name];
      }
      // Keep the local pending value visible (LWW: our write is newer).
      if (model && model.__data[name] !== change.updated) {
        model.setSilently(name, change.updated);
      }
    }
  }
}

export class DeletionTransaction extends BaseTransaction {
  readonly type = "delete" as const;

  /** Snapshot used to resurrect the model if the server rejects the delete. */
  readonly snapshot: Record<string, unknown>;

  constructor(
    modelName: string,
    modelId: string,
    snapshot: Record<string, unknown>,
  ) {
    super(modelName, modelId);
    this.snapshot = snapshot;
  }

  static forModel(model: Model): DeletionTransaction {
    return new DeletionTransaction(
      model.modelName,
      model.id,
      model.serializePersisted(),
    );
  }

  payload(): TransactionPayload {
    return { type: "delete", modelName: this.modelName, modelId: this.modelId };
  }

  serialize(): SerializedTransaction {
    return {
      id: this.id,
      type: this.type,
      modelName: this.modelName,
      modelId: this.modelId,
      seq: this.seq,
      batchIndex: this.batchIndex,
      data: this.snapshot,
    };
  }

  rollback(pool: ObjectPool): void {
    if (pool.get(this.modelId)) return;
    pool.add(createModelFromData(this.modelName, this.snapshot));
  }
}

export type Transaction =
  | CreationTransaction
  | UpdatingTransaction
  | DeletionTransaction;

/**
 * Rebuilds a transaction from its serialized form after a restart and
 * REPLAYS its effect onto the in-memory models (the local database only
 * contains server-confirmed state, so pending local changes must be
 * re-applied on top).
 */
export function deserializeAndReplay(
  record: SerializedTransaction,
  pool: ObjectPool,
): Transaction | null {
  const transaction = ((): Transaction | null => {
    if (record.type === "create") {
      const data = record.data ?? {};
      if (!pool.get(record.modelId)) {
        pool.add(createModelFromData(record.modelName, data));
      }
      return new CreationTransaction(record.modelName, record.modelId, data);
    }

    if (record.type === "update") {
      const model = pool.get(record.modelId);
      if (!model) return null; // model is gone (deleted on the server meanwhile)
      const snapshot: Record<string, { original: unknown; updated: unknown }> =
        {};
      for (const [name, updated] of Object.entries(record.changes ?? {})) {
        snapshot[name] = { original: model.__data[name], updated };
        model.setSilently(name, updated);
      }
      return new UpdatingTransaction(
        record.modelName,
        record.modelId,
        snapshot,
      );
    }

    // delete
    pool.remove(record.modelId);
    return new DeletionTransaction(
      record.modelName,
      record.modelId,
      record.data ?? {},
    );
  })();

  if (transaction) {
    // Keep the persisted identity so the cached row can be cleared on ack.
    transaction.id = record.id;
    transaction.seq = record.seq;
  }
  return transaction;
}
