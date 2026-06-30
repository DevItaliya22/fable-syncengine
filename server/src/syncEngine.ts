
import { prisma } from "./db.js";
import { applyTransaction, serializeRow } from "./models.js";
import type { SyncActionPacket, TransactionPayload } from "./types.js";
/**
 * Simple async mutex. All transaction batches are executed strictly one
 * after another so the SyncAction log (and therefore syncIds) forms a
 * total order over every change in the database — the heart of the
 * Linear-style sync model (OT-ish, not CRDT: the server orders everything).
 */
let chain: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => fn();
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  return result;
}

export async function getLastSyncId(): Promise<number> {
  const row = await prisma.syncAction.findFirst({
    orderBy: { syncId: "desc" },
    select: { syncId: true },
  });
  return row ? Number(row.syncId) : 0;
}

export interface BatchExecutionResult {
  results: { ok: boolean; error?: string }[];
  /** All sync actions produced by the batch, in syncId order. */
  actions: SyncActionPacket[];
  lastSyncId: number;
}

/**
 * Executes a batch of client transactions. Each transaction runs in its own
 * database transaction: applying the change to the domain table and appending
 * rows to the SyncAction log are atomic, so a syncId is never observable
 * without its corresponding data change (and vice versa).
 *
 * A failing transaction is rejected individually (the client rolls it back);
 * it does not abort the rest of the batch.
 */
export async function executeBatch(
  transactions: TransactionPayload[],
): Promise<BatchExecutionResult> {
  return runExclusive(async () => {
    const results: { ok: boolean; error?: string }[] = [];
    const packets: SyncActionPacket[] = [];

    for (const t of transactions) {
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          const applied = await applyTransaction(tx, t);
          if (!applied.ok) {
            return {
              result: { ok: false as const, error: applied.error },
              rows: [],
            };
          }

          const rows: SyncActionPacket[] = [];
          // Sequential inserts: the autoincrement guarantees increasing
          // syncIds in exactly this order.
          for (const action of applied.actions) {
            const row = await tx.syncAction.create({
              data: {
                modelName: action.modelName,
                modelId: action.modelId,
                action: action.action,
                data: action.data ? JSON.stringify(action.data) : {},
              },
            });
            rows.push({
              id: Number(row.syncId),
              modelName: action.modelName,
              modelId: action.modelId,
              action: action.action,
              data: action.data,
            });
          }
          return { result: { ok: true as const }, rows };
        });
        results.push(outcome.result);
        packets.push(...outcome.rows);
      } catch (err) {
        results.push({
          ok: false,
          error: err instanceof Error ? err.message : "internal error",
        });
      }
    }

    const lastSyncId =
      packets.length > 0
        ? packets[packets.length - 1].id
        : await getLastSyncId();
    return { results, actions: packets, lastSyncId };
  });
}

export interface BootstrapResponse {
  lastSyncId: number;
  models: Record<string, Record<string, unknown>[]>;
}

/** Full bootstrap: a consistent snapshot of every model plus the syncId it corresponds to. */
export async function getBootstrap(): Promise<BootstrapResponse> {
  return prisma.$transaction(async (tx) => {
    const [issues, comments, last] = await Promise.all([
      tx.issue.findMany({ orderBy: { createdAt: "asc" } }),
      tx.comment.findMany({ orderBy: { createdAt: "asc" } }),
      tx.syncAction.findFirst({
        orderBy: { syncId: "desc" },
        select: { syncId: true },
      }),
    ]);
    return {
      lastSyncId: last ? Number(last.syncId) : 0,
      models: {
        Issue: issues.map((r) => serializeRow(r)),
        Comment: comments.map((r) => serializeRow(r)),
      },
    };
  });
}

export interface DeltaResponse {
  lastSyncId: number;
  actions: SyncActionPacket[];
}

/** Incremental sync: every sync action after `from`, used for catch-up and gap recovery. */
export async function getDeltaSince(from: number): Promise<DeltaResponse> {
  const rows = await prisma.syncAction.findMany({
    where: { syncId: { gt: BigInt(from) } },
    orderBy: { syncId: "asc" },
  });
  const actions: SyncActionPacket[] = rows.map((row) => ({
    id: Number(row.syncId),
    modelName: row.modelName,
    modelId: row.modelId,
    action: row.action as SyncActionPacket["action"],
    data: row.action === "D" ? null : (row.data as Record<string, unknown>),
  }));
  const lastSyncId =
    actions.length > 0 ? actions[actions.length - 1].id : await getLastSyncId();
  return { lastSyncId: Math.max(lastSyncId, from), actions };
}
