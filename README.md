# SyncEngine — a Linear-style sync engine

A working implementation of the architecture described in
[`reverse-linear-sync-engine`](./reverse-linear-sync-engine/SUMMARY.md): models +
metadata in a **ModelRegistry**, hydrated instances in an **Object Pool**, local
persistence in **IndexedDB**, client mutations packaged as **transactions**, a
server that executes them in a **total order** (global `syncId`) and broadcasts
**delta packets** over WebSocket to every connected client.

The demo app is a small issue tracker (issues + comments). Open it in two
browser windows: changes made in one appear in the other in real time, survive
refreshes (local bootstrap from IndexedDB), and edits made offline are cached
and resent on reconnect.

```
┌─────────────────────────── client ───────────────────────────┐
│  ModelRegistry ── metadata (properties, references, hash)    │
│  Model         ── observable props, save() → transaction     │
│  ObjectPool    ── uuid → hydrated model instances            │
│  IndexedDB     ── server-confirmed state + cached txns       │
│  TransactionQueue ── created → queued → executing → synced   │
│  SyncClient    ── bootstrap, WS deltas, rebase, lastSyncId   │
└──────────────┬───────────────────────────────▲───────────────┘
               │ transactions (WS)             │ delta packets (WS, broadcast)
┌──────────────▼───────────────────────────────┴───────────────┐
│  server: executes txns serially, appends to SyncAction log   │
│  (autoincrement = global syncId), Postgres via Prisma        │
└───────────────────────────────────────────────────────────────┘
```

## How the sync works (not pull/push polling)

- **Full bootstrap** (first run): `GET /sync/bootstrap` returns a snapshot of
  all models plus the `lastSyncId` it corresponds to. Everything is written to
  IndexedDB, then hydrated into the Object Pool.
- **Local bootstrap** (every run after): models load from IndexedDB instantly,
  then the client catches up with `GET /sync/delta?from=<lastSyncId>`.
- **Mutations**: `issue.title = "x"; issue.save()` updates memory immediately,
  records old values, and enqueues an `UpdatingTransaction`. Transactions are
  cached in the `_transactions` IndexedDB store, batched per microtask, and
  sent over the WebSocket. Local edits **never** write to the model tables in
  IndexedDB — only server-confirmed deltas do.
- **Delta packets**: the server executes a transaction, appends sync actions to
  the log (each gets the next global `syncId`), and broadcasts them to _all_
  clients including the mutator. Clients apply actions atomically to IndexedDB,
  update in-memory models, **rebase** pending local updates (last-writer-wins),
  advance `lastSyncId`, and complete transactions waiting on that id.
- **Gap recovery**: if a delta's first syncId is beyond `lastSyncId + 1`, the
  client refetches the missing range over REST before continuing.
- **Offline**: the WS handshake reports the server's `lastSyncId`; after
  catching up, cached transactions are resent (server execution is idempotent,
  so resends are safe). Try the "Go offline" button in the header.
- **Conflicts**: the server orders all transactions (total order — OT-flavored,
  like Linear, rather than CRDT). Concurrent updates resolve last-writer-wins;
  update-after-delete resolves to the delete.

## Running it

```bash
# 1. database (local Prisma Postgres)
cd server
npm install
npx prisma dev          # leave running; prints the DATABASE_URL if you need it
npx prisma db push      # in another terminal: create tables
npx prisma generate     # generate the client into server/generated/prisma

# 2. sync server
npm run dev             # http://localhost:4000 (REST + WS)

# 3. client
cd ../client
npm install
npm run dev             # http://localhost:5173
```

Open http://localhost:5173 in **two windows** side by side and play.

> The client needs no extra dependencies — observability is a tiny built-in
> signal system (Linear uses MobX for the same job) and IndexedDB is used raw.
> Set `VITE_SYNC_SERVER_URL` if the server isn't on `localhost:4000`.

## Repo layout

| Path                                  | What                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `server/src/syncEngine.ts`            | serial transaction execution + SyncAction log (syncId) |
| `server/src/models.ts`                | server-side model handlers (idempotent, cascades)      |
| `server/src/index.ts`                 | REST (`/sync/bootstrap`, `/sync/delta`) + WS (`/sync`) |
| `client/src/sync/ModelRegistry.ts`    | model/property metadata + schema hash                  |
| `client/src/sync/Model.ts`            | base model, observable accessors, change tracking      |
| `client/src/sync/ObjectPool.ts`       | uuid → model instance map                              |
| `client/src/sync/Database.ts`         | IndexedDB stores, atomic delta application             |
| `client/src/sync/transactions.ts`     | create/update/delete txns, rollback, rebase            |
| `client/src/sync/TransactionQueue.ts` | batching, caching, ack handling                        |
| `client/src/sync/SyncClient.ts`       | bootstrap, WS connection, delta application            |
| `client/src/models/`                  | `Issue`, `Comment` model definitions                   |
| `client/src/App.tsx`                  | the issue tracker UI                                   |
