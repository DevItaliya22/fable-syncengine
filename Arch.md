Here's the current architecture — server opened up, client collapsed to a box.

```mermaid
flowchart TB
    subgraph CLIENTS["clients (× N tabs)"]
        C1["client
        (ModelRegistry · ObjectPool · IndexedDB · TransactionQueue · SyncClient)"]
    end

    subgraph SERVER["server  ·  src/index.ts  (one Node process, port 4000)"]
        direction TB

        subgraph HTTP["Express REST"]
            BOOT["GET /sync/bootstrap
            full snapshot of all models
            + lastSyncId (consistent read)"]
            DELTA["GET /sync/delta?from=N
            sync actions where syncId > N
            (catch-up & gap recovery)"]
        end

        subgraph WS["WebSocket  /sync  (ws)"]
            HS["on connect:
            send handshake { lastSyncId }"]
            RECV["on message:
            transaction_batch { batchId, txns[] }"]
            ACK["ack → mutator only
            { batchId, lastSyncId, results[] }"]
            BCAST["broadcast delta → ALL clients
            (incl. mutator)
            { lastSyncId, actions[] }"]
        end

        subgraph ENGINE["syncEngine.ts"]
            MUTEX["runExclusive()
            global async mutex —
            batches execute strictly serially
            ⇒ total order, exec order = broadcast order"]
            EXEC["executeBatch()
            per txn: prisma.$transaction
            (one failure ≠ batch failure)"]
        end

        subgraph MODELS["models.ts — applyTransaction()"]
            WL["field whitelists + uuid checks"]
            IDEM["idempotent ops:
            create→upsert · update/delete
            on missing row → no-op (LWW)"]
            CASC["side effects:
            Issue delete ⇒ cascade
            Comment deletes into delta"]
        end

        PRISMA["Prisma client + @prisma/adapter-pg
        (db.ts decodes prisma+postgres:// → postgres://)"]
    end

    subgraph PG["Postgres (npx prisma dev)"]
        DOM["domain tables
        Issue · Comment"]
        LOG["SyncAction log (append-only)
        syncId BIGINT autoincrement = global total order
        lastSyncId = max(syncId)"]
    end

    C1 -- "1· full bootstrap (first run)" --> BOOT
    C1 -- "2· catch-up after offline" --> DELTA
    C1 == "3· transaction_batch (WS)" ==> RECV
    HS -. "lastSyncId → client detects missed deltas" .-> C1

    RECV --> MUTEX --> EXEC --> WL
    WL --> IDEM --> CASC
    MODELS --> PRISMA
    PRISMA -- "write row" --> DOM
    PRISMA -- "append actions (same db txn — atomic)" --> LOG

    EXEC --> BCAST
    EXEC --> ACK
    BCAST == "4· delta packets (WS)" ==> C1
    ACK -- "5· complete / rollback txns" --> C1

    BOOT --- PRISMA
    DELTA --- PRISMA
```

Key invariants baked into the picture:

- **One door for writes**: every mutation enters as a transaction over WS, goes through the mutex, and exits as numbered sync actions. REST is read-only.
- **Atomicity at the log**: the domain-table write and the `SyncAction` append happen in the same Postgres transaction — a `syncId` can never exist without its data change, or vice versa.
- **Total order**: the mutex + autoincrement means delta packets leave the server in exactly `syncId` order, so the client's only job is "apply in order, refetch if I see a gap".
- **The mutator learns twice**: once via the broadcast delta (data) and once via the ack (transaction completion) — matching the doc's `completedButUnsyncedTransactions` flow.

And per the earlier optimization discussion: the mutex + in-handler broadcast pair is the part you'd replace with concurrent execution + a committed-log tailer; the rest of the diagram survives that change untouched.