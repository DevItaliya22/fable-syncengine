import type { ObjectPool } from "./ObjectPool";
import type { TransactionQueue } from "./TransactionQueue";

/**
 * Late-bound singletons. Models need access to the TransactionQueue
 * (issue.save() -> queue.update(issue)) and the queue needs models;
 * binding them through this tiny module avoids circular imports.
 */
export interface SyncContext {
  pool: ObjectPool;
  transactionQueue: TransactionQueue;
}

let context: SyncContext | null = null;

export function setSyncContext(ctx: SyncContext): void {
  context = ctx;
}

export function getSyncContext(): SyncContext {
  if (!context) {
    throw new Error(
      "Sync engine not bootstrapped yet — call bootstrapSync() first",
    );
  }
  return context;
}
