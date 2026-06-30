import { ModelRegistry } from "./ModelRegistry";
import type { SyncActionPacket } from "./types";
import type { SerializedTransaction } from "./transactions";

const DB_NAME = "lse_workspace";
const SCHEMA_HASH_KEY = "lse_schema_hash";
const META_STORE = "_meta";
const TRANSACTIONS_STORE = "_transactions";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab holds it open; best effort
  });
}

/**
 * The local database: one IndexedDB object store per model, plus
 *   - `_meta`:        lastSyncId / firstSyncId and other bookkeeping
 *   - `_transactions`: cached transactions not yet accepted by the server
 *                      (resent after restart/reconnect)
 *
 * Model stores hold only server-confirmed state: they are written
 * exclusively from bootstrap data and delta packets, never from local edits.
 *
 * Migration: if the ModelRegistry schemaHash differs from the stored one,
 * the whole database is rebuilt and a fresh full bootstrap follows.
 */
export class LocalDatabase {
  private db!: IDBDatabase;

  async open(): Promise<void> {
    const schemaHash = ModelRegistry.schemaHash;
    const storedHash = localStorage.getItem(SCHEMA_HASH_KEY);
    if (storedHash !== null && storedHash !== schemaHash) {
      await deleteDatabase(DB_NAME);
    }
    localStorage.setItem(SCHEMA_HASH_KEY, schemaHash);

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const modelName of ModelRegistry.allModelNames()) {
          if (!db.objectStoreNames.contains(modelName)) {
            const store = db.createObjectStore(modelName, { keyPath: "id" });
            const meta = ModelRegistry.getMetadata(modelName);
            for (const [prop, propMeta] of Object.entries(meta.properties)) {
              if (propMeta.indexed) store.createIndex(prop, prop);
            }
          }
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(TRANSACTIONS_STORE)) {
          db.createObjectStore(TRANSACTIONS_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- metadata ----

  async getMeta<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const row = await requestToPromise(tx.objectStore(META_STORE).get(key));
    return row ? ((row as { key: string; value: T }).value as T) : undefined;
  }

  async putMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key, value });
    await txDone(tx);
  }

  // ---- model data (server-confirmed state only) ----

  async getAllModelData(modelName: string): Promise<Record<string, unknown>[]> {
    const tx = this.db.transaction(modelName, "readonly");
    return (await requestToPromise(
      tx.objectStore(modelName).getAll(),
    )) as Record<string, unknown>[];
  }

  /** Bulk write used by full bootstrap. Also records lastSyncId atomically. */
  async writeBootstrap(
    models: Record<string, Record<string, unknown>[]>,
    lastSyncId: number,
  ): Promise<void> {
    const storeNames = [
      ...Object.keys(models).filter((name) => ModelRegistry.hasModel(name)),
      META_STORE,
    ];
    const tx = this.db.transaction(storeNames, "readwrite");
    for (const [modelName, rows] of Object.entries(models)) {
      if (!ModelRegistry.hasModel(modelName)) continue;
      const store = tx.objectStore(modelName);
      store.clear();
      for (const row of rows) store.put(row);
    }
    tx.objectStore(META_STORE).put({ key: "lastSyncId", value: lastSyncId });
    tx.objectStore(META_STORE).put({ key: "firstSyncId", value: lastSyncId });
    await txDone(tx);
  }

  /**
   * Applies a delta packet's sync actions and the new lastSyncId in ONE
   * IndexedDB transaction, so the local database can never hold data
   * without the matching sync position.
   */
  async applyActions(
    actions: SyncActionPacket[],
    lastSyncId: number,
  ): Promise<void> {
    const involved = new Set<string>([META_STORE]);
    for (const action of actions) {
      if (ModelRegistry.hasModel(action.modelName))
        involved.add(action.modelName);
    }
    const tx = this.db.transaction([...involved], "readwrite");
    for (const action of actions) {
      if (!ModelRegistry.hasModel(action.modelName)) continue;
      const store = tx.objectStore(action.modelName);
      if (action.action === "D") {
        store.delete(action.modelId);
      } else if (action.data) {
        store.put(action.data);
      }
    }
    tx.objectStore(META_STORE).put({ key: "lastSyncId", value: lastSyncId });
    await txDone(tx);
  }

  // ---- cached transactions ----

  async putTransaction(record: SerializedTransaction): Promise<void> {
    const tx = this.db.transaction(TRANSACTIONS_STORE, "readwrite");
    tx.objectStore(TRANSACTIONS_STORE).put(record);
    await txDone(tx);
  }

  async deleteTransaction(id: string): Promise<void> {
    const tx = this.db.transaction(TRANSACTIONS_STORE, "readwrite");
    tx.objectStore(TRANSACTIONS_STORE).delete(id);
    await txDone(tx);
  }

  async getAllTransactions(): Promise<SerializedTransaction[]> {
    const tx = this.db.transaction(TRANSACTIONS_STORE, "readonly");
    const rows = (await requestToPromise(
      tx.objectStore(TRANSACTIONS_STORE).getAll(),
    )) as SerializedTransaction[];
    return rows.sort((a, b) => a.seq - b.seq);
  }
}
