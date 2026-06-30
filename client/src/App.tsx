// Opt this file out of the React Compiler: components here read properties
// straight off mutable Model instances (re-rendered via signals), which the
// compiler's memoization cannot see through — same caveat as MobX.
"use no memo";

import { useEffect, useMemo, useRef, useState } from "react";
import { Comment } from "./models/Comment";
import {
  ISSUE_STATUSES,
  Issue,
  PRIORITIES,
  type IssueStatus,
} from "./models/Issue";
import { bootstrapSync, store } from "./store";
import { useCollection, useModel, useSignal } from "./sync/react";
import "./App.css";

const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
  canceled: "Canceled",
};

const AUTHOR_KEY = "sync_demo_author";
function getAuthor(): string {
  let author = localStorage.getItem(AUTHOR_KEY);
  if (!author) {
    const names = [
      "ada",
      "linus",
      "grace",
      "alan",
      "margaret",
      "dennis",
      "barbara",
      "ken",
    ];
    author = `${names[Math.floor(Math.random() * names.length)]}-${Math.floor(Math.random() * 90 + 10)}`;
    localStorage.setItem(AUTHOR_KEY, author);
  }
  return author;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bootstrapSync().then(
      () => setReady(true),
      (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  if (error) {
    return (
      <div className="boot-screen">
        <h1>Couldn't bootstrap</h1>
        <p>{error}</p>
        <p className="hint">Is the sync server running on port 4000?</p>
        <button onClick={() => location.reload()}>Retry</button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="boot-screen">
        <div className="spinner" />
        <p className="hint">Bootstrapping local database…</p>
      </div>
    );
  }

  return <Tracker />;
}

function Tracker() {
  const issues = useCollection<Issue>(store.pool, "Issue");
  const sorted = useMemo(
    () => [...issues].sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1)),
    [issues],
  );

  return (
    <div className="tracker">
      <Header />
      <Composer />
      <main className="issue-list">
        {sorted.length === 0 ? (
          <div className="empty">
            No issues yet. Create one — it syncs everywhere, instantly.
          </div>
        ) : (
          sorted.map((issue) => <IssueRow key={issue.id} issue={issue} />)
        )}
      </main>
    </div>
  );
}

function Header() {
  const client = store.client;
  useSignal(client.statusSignal);
  useSignal(client.syncSignal);
  useSignal(client.transactionQueue.signal);

  const status = client.status;
  const pending = client.transactionQueue.pendingCount;

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">◮</span> SyncTracker
        <span className="author">you are “{getAuthor()}”</span>
      </div>
      <div className="sync-state">
        {pending > 0 && <span className="pending">{pending} unsynced</span>}
        <span
          className="sync-id"
          title="lastSyncId — the database version this client is synced to"
        >
          sync #{client.lastSyncId}
        </span>
        <span className={`status status-${status}`}>
          <span className="dot" />
          {status === "connected"
            ? "Live"
            : status === "connecting"
              ? "Connecting…"
              : "Offline"}
        </span>
        <button
          className="offline-toggle"
          onClick={() =>
            client.setIntentionallyOffline(!client.intentionallyOffline)
          }
          title="Simulate losing the connection. Edits made offline are cached and resent."
        >
          {client.intentionallyOffline ? "Go online" : "Go offline"}
        </button>
      </div>
    </header>
  );
}

function Composer() {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(0);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    store.createIssue({ title: trimmed, priority });
    setTitle("");
  };

  return (
    <div className="composer">
      <input
        value={title}
        placeholder="What needs to be done?"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <select
        value={priority}
        onChange={(e) => setPriority(Number(e.target.value))}
      >
        {PRIORITIES.map((label, i) => (
          <option key={label} value={i}>
            {label}
          </option>
        ))}
      </select>
      <button className="primary" onClick={submit} disabled={!title.trim()}>
        Add issue
      </button>
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  useModel(issue);
  // Re-render the comment count when comments are added/removed anywhere.
  useSignal(store.pool.signalFor("Comment"));
  const [editing, setEditing] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const commentCount = issue.comments.length;

  return (
    <div className={`issue-row status-bg-${issue.status}`}>
      <div className="issue-main">
        <select
          className="priority"
          value={issue.priority}
          onChange={(e) => {
            issue.priority = Number(e.target.value);
            issue.save();
          }}
        >
          {PRIORITIES.map((label, i) => (
            <option key={label} value={i}>
              {i === 0 ? "—" : label}
            </option>
          ))}
        </select>

        {editing ? (
          <TitleEditor issue={issue} onDone={() => setEditing(false)} />
        ) : (
          <span
            className={`title ${issue.status === "done" || issue.status === "canceled" ? "muted" : ""}`}
            onClick={() => setEditing(true)}
            title="Click to edit"
          >
            {issue.title || "Untitled"}
          </span>
        )}

        <select
          className={`status-select s-${issue.status}`}
          value={issue.status}
          onChange={(e) => {
            issue.status = e.target.value as IssueStatus;
            issue.save();
          }}
        >
          {ISSUE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <button className="ghost" onClick={() => setShowComments((v) => !v)}>
          💬 {commentCount > 0 ? commentCount : ""}
        </button>
        <button
          className="ghost danger"
          onClick={() => issue.delete()}
          title="Delete issue"
        >
          ✕
        </button>
      </div>
      {showComments && <CommentsPanel issue={issue} />}
    </div>
  );
}

function TitleEditor({ issue, onDone }: { issue: Issue; onDone: () => void }) {
  const [value, setValue] = useState(issue.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== issue.title) {
      issue.title = trimmed;
      issue.save();
    }
    onDone();
  };

  return (
    <input
      ref={inputRef}
      className="title-editor"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

function CommentsPanel({ issue }: { issue: Issue }) {
  useSignal(store.pool.signalFor("Comment"));
  const [body, setBody] = useState("");

  const comments = [...issue.comments].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1,
  );

  const submit = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    store.createComment(issue, trimmed, getAuthor());
    setBody("");
  };

  return (
    <div className="comments">
      {comments.map((comment) => (
        <CommentRow key={comment.id} comment={comment} />
      ))}
      <div className="comment-composer">
        <input
          value={body}
          placeholder="Leave a comment…"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="primary" onClick={submit} disabled={!body.trim()}>
          Comment
        </button>
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: Comment }) {
  useModel(comment);
  return (
    <div className="comment">
      <span className="comment-author">{comment.author}</span>
      <span className="comment-body">{comment.body}</span>
      <button className="ghost danger" onClick={() => comment.delete()}>
        ✕
      </button>
    </div>
  );
}
