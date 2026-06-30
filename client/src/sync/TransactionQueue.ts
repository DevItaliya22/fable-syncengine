import type { LocalDatabase } from "./Database";
import type { Model } from "./Model";
import type { ObjectPool } from "./ObjectPool";
import { Signal } from "./signal";
import {
  BaseTransaction,
  CreationTransaction,
  DeletionTransaction,
  deserializeAndReplay,
  UpdatingTransaction,
  type SerializedTransaction,
} from "./transactions";
import type {
  SyncActionPacket,
  TransactionAckMessage,
  TransactionBatchMessage,
} from "./types";

/**
 * Manages the lifecycle of transactions:
 *
 *   createdTransactions --(microtask commit, persisted to IndexedDB)-->
 *   queuedTransactions  --(batch send over WebSocket)-->
 *   executing batch     --(server ack)-->
 *   completedButUnsyncedTransactions --(delta with lastSyncId arrives)--> done
 *
 * Transactions created in the same event-loop tick share a batchIndex and
 * are sent to the server together. While queued/executing they are cached
 * in the `_transactions` store so a crash, refresh or lost connection never
 * loses local changes — they are replayed and resent on the next start.
 */
export class TransactionQueue {
  private createdTransactions: BaseTransaction[] = [];
  private queuedTransactions: BaseTransaction[] = [];
  private executingBatch: {
    batchId: string;
    transactions: BaseTransaction[];
  } | null = null;
  private completedButUnsyncedTransactions: BaseTransaction[] = [];

  private batchIndex = 1;
  private commitScheduled = false;

  /** Set by the SyncClient while the socket is open; null when offline. */
  private sender: ((message: TransactionBatchMessage) => void) | null = null;

  /** Notifies the UI when the number of pending transactions changes. */
  readonly signal = new Signal();

  private readonly pool: ObjectPool;
  private readonly db: LocalDatabase;

  constructor(pool: ObjectPool, db: LocalDatabase) {
    this.pool = pool;
    this.db = db;
  }

  /** Transactions not yet accepted by the server. */
  get pendingCount(): number {
    return (
      this.createdTransactions.length +
      this.queuedTransactions.length +
      (this.executingBatch?.transactions.length ?? 0)
    );
  }

  // ---- creating transactions (called via model.save() / store helpers) ----

  create(model: Model): void {
    this.pool.add(model);
    // Initial property assignments are part of the creation snapshot,
    // not separate updates.
    model.modifiedProperties.clear();
    this.enqueue(CreationTransaction.forModel(model));
  }

  update(model: Model): void {
    const transaction = UpdatingTransaction.forModel(model);
    if (Object.keys(transaction.changeSnapshot).length === 0) return;
    this.enqueue(transaction);
  }

  delete(model: Model): void {
    const transaction = DeletionTransaction.forModel(model);
    this.pool.remove(model.id);
    this.enqueue(transaction);
  }

  private enqueue(transaction: BaseTransaction): void {
    transaction.batchIndex = this.batchIndex;
    this.createdTransactions.push(transaction);
    this.signal.notify();
    if (!this.commitScheduled) {
      this.commitScheduled = true;
      queueMicrotask(() => this.commitCreatedTransactions());
    }
  }

  /** Moves created -> queued, persists them, bumps the batchIndex. */
  private commitCreatedTransactions(): void {
    this.commitScheduled = false;
    if (this.createdTransactions.length === 0) return;
    const committed = this.createdTransactions;
    this.createdTransactions = [];
    this.batchIndex++;

    for (const transaction of committed) {
      this.queuedTransactions.push(transaction);
      void this.db
        .putTransaction(transaction.serialize())
        .catch((err) =>
          console.error("[sync] failed to cache transaction", err),
        );
    }
    this.signal.notify();
    this.maybeSendNextBatch();
  }

  // ---- sending ----

  setSender(sender: ((message: TransactionBatchMessage) => void) | null): void {
    this.sender = sender;
    if (sender) this.maybeSendNextBatch();
  }

  private maybeSendNextBatch(): void {
    if (
      !this.sender ||
      this.executingBatch ||
      this.queuedTransactions.length === 0
    )
      return;

    // A batch = the longest prefix of the queue sharing a batchIndex.
    const headIndex = this.queuedTransactions[0].batchIndex;
    let count = 0;
    while (
      count < this.queuedTransactions.length &&
      this.queuedTransactions[count].batchIndex === headIndex
    ) {
      count++;
    }
    const transactions = this.queuedTransactions.splice(0, count);
    const batchId = crypto.randomUUID();
    this.executingBatch = { batchId, transactions };
    this.signal.notify();

    this.sender({
      kind: "transaction_batch",
      batchId,
      transactions: transactions.map((t) => t.payload()),
    });
  }

  /** Connection dropped: whatever was in flight goes back to the queue front. */
  onDisconnected(): void {
    this.sender = null;
    if (this.executingBatch) {
      // Safe to resend later: the server executes transactions idempotently.
      this.queuedTransactions.unshift(...this.executingBatch.transactions);
      this.executingBatch = null;
      this.signal.notify();
    }
  }

  // ---- server responses ----

  handleAck(message: TransactionAckMessage, lastSyncIdSeen: number): void {
    if (!this.executingBatch || this.executingBatch.batchId !== message.batchId)
      return;
    const { transactions } = this.executingBatch;
    this.executingBatch = null;

    transactions.forEach((transaction, i) => {
      const result = message.results[i];
      if (result && !result.ok) {
        console.warn(
          `[sync] transaction rejected (${transaction.type} ${transaction.modelName}): ${result.error}`,
        );
        transaction.rollback(this.pool);
      } else if (message.lastSyncId > lastSyncIdSeen) {
        // Accepted, but the matching delta packet hasn't been applied yet.
        transaction.syncIdNeededForCompletion = message.lastSyncId;
        this.completedButUnsyncedTransactions.push(transaction);
      }
      // Either way the server has decided: drop the cached copy.
      void this.db
        .deleteTransaction(transaction.id)
        .catch((err) =>
          console.error("[sync] failed to clear cached transaction", err),
        );
    });

    this.signal.notify();
    this.maybeSendNextBatch();
  }

  // ---- delta integration ----

  /**
   * A delta inserted a model with this id. If we still hold a queued
   * CreationTransaction for the same UUID it is now redundant (or a
   * collision) and gets cancelled.
   */
  modelUpserted(modelId: string): void {
    const matches = (t: BaseTransaction) =>
      t.type === "create" && t.modelId === modelId;
    for (const t of [
      ...this.createdTransactions,
      ...this.queuedTransactions,
    ].filter(matches)) {
      void this.db.deleteTransaction(t.id).catch(() => undefined);
    }
    this.createdTransactions = this.createdTransactions.filter(
      (t) => !matches(t),
    );
    this.queuedTransactions = this.queuedTransactions.filter(
      (t) => !matches(t),
    );
    this.signal.notify();
  }

  /**
   * Rebase pending UpdatingTransactions on top of an incoming sync action
   * for the same model (last-writer-wins conflict resolution).
   */
  rebaseForAction(action: SyncActionPacket): void {
    if ((action.action !== "U" && action.action !== "I") || !action.data)
      return;
    const pending = [
      ...this.createdTransactions,
      ...this.queuedTransactions,
      ...(this.executingBatch?.transactions ?? []),
    ];
    for (const transaction of pending) {
      if (
        transaction instanceof UpdatingTransaction &&
        transaction.modelId === action.modelId
      ) {
        transaction.rebase(this.pool, action.data);
      }
    }
  }

  /** Completes transactions whose acked syncId has now been seen in a delta. */
  progressSyncWaiters(lastSyncId: number): void {
    const before = this.completedButUnsyncedTransactions.length;
    this.completedButUnsyncedTransactions =
      this.completedButUnsyncedTransactions.filter(
        (t) => (t.syncIdNeededForCompletion ?? 0) > lastSyncId,
      );
    if (this.completedButUnsyncedTransactions.length !== before)
      this.signal.notify();
  }

  // ---- persistence across restarts ----

  /**
   * Loads transactions cached in IndexedDB from a previous session, replays
   * their effects onto the freshly hydrated in-memory models and queues them
   * to be sent.
   */
  loadPersisted(records: SerializedTransaction[]): void {
    for (const record of records) {
      const transaction = deserializeAndReplay(record, this.pool);
      if (!transaction) {
        void this.db.deleteTransaction(record.id).catch(() => undefined);
        continue;
      }
      transaction.batchIndex = this.batchIndex;
      this.queuedTransactions.push(transaction);
    }
    if (records.length > 0) {
      this.batchIndex++;
      this.signal.notify();
    }
  }
}
