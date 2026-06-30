import { Comment } from "./models/Comment";
import { Issue, type IssueStatus } from "./models/Issue";
import { SyncClient } from "./sync/SyncClient";

/**
 * App-facing facade over the sync engine. Components talk to this store
 * (and to models directly: `issue.title = "..."; issue.save()`), never to
 * the WebSocket or IndexedDB.
 */
export class SyncedStore {
  readonly client = new SyncClient();

  get pool() {
    return this.client.pool;
  }

  createIssue(input: {
    title: string;
    status?: IssueStatus;
    priority?: number;
  }): Issue {
    const issue = new Issue();
    issue.title = input.title;
    if (input.status) issue.status = input.status;
    if (input.priority !== undefined) issue.priority = input.priority;
    issue.sortOrder = Date.now();
    this.client.transactionQueue.create(issue);
    return issue;
  }

  createComment(issue: Issue, body: string, author: string): Comment {
    const comment = new Comment();
    comment.body = body;
    comment.issueId = issue.id;
    comment.author = author;
    this.client.transactionQueue.create(comment);
    return comment;
  }
}

export const store = new SyncedStore();

let bootstrapPromise: Promise<SyncedStore> | null = null;

/** Idempotent engine startup (safe under React StrictMode double-invocation). */
export function bootstrapSync(): Promise<SyncedStore> {
  if (!bootstrapPromise) {
    bootstrapPromise = store.client.bootstrap().then(() => store);
  }
  return bootstrapPromise;
}
