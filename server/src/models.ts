import type { Prisma } from "../generated/prisma/client.js";
import type { SyncActionType, TransactionPayload } from "./types.js";

/**
 * A sync action that has been decided but not yet assigned a syncId.
 * syncIds are assigned in order when the rows are appended to the
 * SyncAction log inside the same database transaction.
 */
export interface PendingAction {
  modelName: string;
  modelId: string;
  action: SyncActionType;
  data: Record<string, unknown> | null;
}

export type ApplyResult =
  | { ok: true; actions: PendingAction[] }
  | { ok: false; error: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dates -> ISO strings so rows can be stored in the Json log and sent over the wire. */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

// ---- Field whitelists: the only thing clients are allowed to write ----

interface IssueFields {
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  sortOrder?: number;
}

function pickIssueFields(data: Record<string, unknown>): IssueFields {
  const out: IssueFields = {};
  if (typeof data.title === "string") out.title = data.title;
  if (typeof data.description === "string") out.description = data.description;
  if (typeof data.status === "string") out.status = data.status;
  if (typeof data.priority === "number") out.priority = data.priority;
  if (typeof data.sortOrder === "number") out.sortOrder = data.sortOrder;
  return out;
}

interface CommentFields {
  body?: string;
  issueId?: string;
  author?: string;
}

function pickCommentFields(data: Record<string, unknown>): CommentFields {
  const out: CommentFields = {};
  if (typeof data.body === "string") out.body = data.body;
  if (typeof data.issueId === "string") out.issueId = data.issueId;
  if (typeof data.author === "string") out.author = data.author;
  return out;
}

// ---- Transaction execution (runs inside a single database transaction) ----

/**
 * Applies one client transaction to the domain tables and returns the sync
 * actions it produced. Designed to be idempotent so cached transactions that
 * are resent after a reconnect cannot corrupt state:
 *   - create  -> upsert
 *   - update  -> no-op if the row no longer exists (a delete won, LWW)
 *   - delete  -> no-op if the row no longer exists
 *
 * Note that the produced delta may contain MORE actions than the transaction
 * itself (e.g. deleting an Issue cascades to its Comments) — this is the
 * "server side effects" property of delta packets.
 */
export async function applyTransaction(
  tx: Prisma.TransactionClient,
  t: TransactionPayload,
): Promise<ApplyResult> {
  if (!UUID_RE.test(t.modelId)) {
    return { ok: false, error: `invalid model id: ${t.modelId}` };
  }

  switch (t.modelName) {
    case "Issue":
      return applyIssue(tx, t);
    case "Comment":
      return applyComment(tx, t);
    default:
      return { ok: false, error: `unknown model: ${t.modelName}` };
  }
}

async function applyIssue(
  tx: Prisma.TransactionClient,
  t: TransactionPayload,
): Promise<ApplyResult> {
  if (t.type === "create") {
    const fields = pickIssueFields(t.data);
    const existing = await tx.issue.findUnique({ where: { id: t.modelId } });
    const row = await tx.issue.upsert({
      where: { id: t.modelId },
      create: { id: t.modelId, ...fields, title: fields.title ?? "Untitled" },
      update: { ...fields, updatedAt: new Date() },
    });
    return {
      ok: true,
      actions: [
        {
          modelName: "Issue",
          modelId: t.modelId,
          action: existing ? "U" : "I",
          data: serializeRow(row),
        },
      ],
    };
  }

  if (t.type === "update") {
    const existing = await tx.issue.findUnique({ where: { id: t.modelId } });
    if (!existing) return { ok: true, actions: [] }; // deleted concurrently, delete wins
    const fields = pickIssueFields(t.changes);
    const row = await tx.issue.update({
      where: { id: t.modelId },
      data: { ...fields, updatedAt: new Date() },
    });
    return {
      ok: true,
      actions: [
        {
          modelName: "Issue",
          modelId: t.modelId,
          action: "U",
          data: serializeRow(row),
        },
      ],
    };
  }

  // delete: cascade to comments (server-side side effect)
  const existing = await tx.issue.findUnique({ where: { id: t.modelId } });
  if (!existing) return { ok: true, actions: [] };

  const comments = await tx.comment.findMany({ where: { issueId: t.modelId } });
  await tx.comment.deleteMany({ where: { issueId: t.modelId } });
  await tx.issue.delete({ where: { id: t.modelId } });

  return {
    ok: true,
    actions: [
      ...comments.map(
        (c): PendingAction => ({
          modelName: "Comment",
          modelId: c.id,
          action: "D",
          data: null,
        }),
      ),
      { modelName: "Issue", modelId: t.modelId, action: "D", data: null },
    ],
  };
}

async function applyComment(
  tx: Prisma.TransactionClient,
  t: TransactionPayload,
): Promise<ApplyResult> {
  if (t.type === "create") {
    const fields = pickCommentFields(t.data);
    if (!fields.issueId || !UUID_RE.test(fields.issueId)) {
      return { ok: false, error: "comment requires a valid issueId" };
    }
    const issue = await tx.issue.findUnique({ where: { id: fields.issueId } });
    if (!issue) return { ok: false, error: "issue does not exist" };

    const existing = await tx.comment.findUnique({ where: { id: t.modelId } });
    const row = await tx.comment.upsert({
      where: { id: t.modelId },
      create: {
        id: t.modelId,
        body: fields.body ?? "",
        issueId: fields.issueId,
        author: fields.author ?? "anonymous",
      },
      update: { ...fields, updatedAt: new Date() },
    });
    return {
      ok: true,
      actions: [
        {
          modelName: "Comment",
          modelId: t.modelId,
          action: existing ? "U" : "I",
          data: serializeRow(row),
        },
      ],
    };
  }

  if (t.type === "update") {
    const existing = await tx.comment.findUnique({ where: { id: t.modelId } });
    if (!existing) return { ok: true, actions: [] };
    const fields = pickCommentFields(t.changes);
    // issueId is immutable after creation
    delete fields.issueId;
    const row = await tx.comment.update({
      where: { id: t.modelId },
      data: { ...fields, updatedAt: new Date() },
    });
    return {
      ok: true,
      actions: [
        {
          modelName: "Comment",
          modelId: t.modelId,
          action: "U",
          data: serializeRow(row),
        },
      ],
    };
  }

  // delete
  const existing = await tx.comment.findUnique({ where: { id: t.modelId } });
  if (!existing) return { ok: true, actions: [] };
  await tx.comment.delete({ where: { id: t.modelId } });
  return {
    ok: true,
    actions: [
      { modelName: "Comment", modelId: t.modelId, action: "D", data: null },
    ],
  };
}

export { serializeRow };
