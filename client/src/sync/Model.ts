import { getSyncContext } from "./context";
import {
  ModelRegistry,
  type ModelConstructor,
  type ModelRegistration,
} from "./ModelRegistry";
import { Signal } from "./signal";

/**
 * Base class for all synced models.
 *
 * Property values live in `__data`; registered properties are exposed as
 * getters/setters on the prototype (see `registerModel` below). Setting a
 * property immediately updates the in-memory model AND records the old value
 * in `modifiedProperties`, so a later `save()` can package the change into
 * an UpdatingTransaction. Local changes NEVER write to IndexedDB directly —
 * the local database is only updated when the server confirms the change
 * via a delta packet.
 */
export abstract class Model {
  static modelName: string;

  id: string = crypto.randomUUID();

  /** Backing storage for registered properties. */
  __data: Record<string, unknown> = {};

  /** propertyName -> old value, recorded between mutations and save(). */
  modifiedProperties = new Map<string, { original: unknown }>();

  /** Notifies React (and anything else) when this model changes. */
  readonly changeSignal = new Signal();

  /** When true, property writes skip change tracking (hydration, deltas, rollbacks). */
  private __silent = false;

  constructor() {
    const meta = ModelRegistry.getMetadata(this.modelName);
    for (const [name, prop] of Object.entries(meta.properties)) {
      if (prop.defaultValue !== undefined) {
        this.__data[name] =
          typeof prop.defaultValue === "function"
            ? prop.defaultValue()
            : prop.defaultValue;
      }
    }
  }

  get modelName(): string {
    return (this.constructor as typeof Model).modelName;
  }

  /** Called by the property setters (the observability helper). */
  propertyChanged(name: string, oldValue: unknown): void {
    if (this.__silent) return;
    this.markPropertyChanged(name, oldValue);
  }

  markPropertyChanged(name: string, oldValue: unknown): void {
    // Only the value before the FIRST unsaved change is the "original".
    if (!this.modifiedProperties.has(name)) {
      this.modifiedProperties.set(name, { original: oldValue });
    }
  }

  /** Snapshot of unsaved changes: property -> { original, updated }. */
  changeSnapshot(): Record<string, { original: unknown; updated: unknown }> {
    const snapshot: Record<string, { original: unknown; updated: unknown }> =
      {};
    for (const [name, { original }] of this.modifiedProperties) {
      snapshot[name] = { original, updated: this.__data[name] };
    }
    return snapshot;
  }

  /**
   * Packages unsaved changes into an UpdatingTransaction and enqueues it.
   * The in-memory model was already updated when the properties were set.
   */
  save(): void {
    if (this.modifiedProperties.size === 0) return;
    getSyncContext().transactionQueue.update(this);
    this.modifiedProperties.clear();
  }

  /** Enqueues a DeletionTransaction and removes the model from the Object Pool. */
  delete(): void {
    getSyncContext().transactionQueue.delete(this);
  }

  /**
   * Hydrates the model from raw data (bootstrap rows, IndexedDB rows or
   * delta packets) without triggering change tracking.
   */
  updateFromData(data: Record<string, unknown>): void {
    const meta = ModelRegistry.getMetadata(this.modelName);
    this.__silent = true;
    try {
      if (typeof data.id === "string") this.id = data.id;
      for (const name of Object.keys(meta.properties)) {
        if (name in data) {
          this.__data[name] = data[name];
        }
      }
    } finally {
      this.__silent = false;
    }
    this.changeSignal.notify();
  }

  /** Writes a single property without change tracking (used by rollback/rebase). */
  setSilently(name: string, value: unknown): void {
    this.__silent = true;
    try {
      this.__data[name] = value;
    } finally {
      this.__silent = false;
    }
    this.changeSignal.notify();
  }

  /** Serializes persisted properties for transport / IndexedDB. */
  serializePersisted(): Record<string, unknown> {
    const meta = ModelRegistry.getMetadata(this.modelName);
    const out: Record<string, unknown> = { id: this.id };
    for (const [name, prop] of Object.entries(meta.properties)) {
      if (prop.persisted && this.__data[name] !== undefined) {
        out[name] = this.__data[name];
      }
    }
    return out;
  }
}

/**
 * Registers a model class and its metadata in the ModelRegistry, and defines
 * observable accessors for every property on the prototype (the equivalent
 * of Linear's `@ClientModel` / `@Property` decorators plus the `M1`
 * observability helper, written as an explicit call).
 */
export function registerModel(
  ctor: ModelConstructor,
  registration: ModelRegistration,
): void {
  (ctor as unknown as typeof Model).modelName = registration.name;
  ModelRegistry.registerModel(ctor, registration);

  for (const name of Object.keys(registration.properties)) {
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      enumerable: false,
      get(this: Model) {
        return this.__data[name];
      },
      set(this: Model, value: unknown) {
        const oldValue = this.__data[name];
        if (oldValue === value) return;
        this.propertyChanged(name, oldValue);
        this.__data[name] = value;
        this.changeSignal.notify();
      },
    });
  }

  // Reference collections resolve through the Object Pool (one-to-many),
  // e.g. issue.comments -> all Comment models whose issueId === issue.id.
  for (const [name, coll] of Object.entries(
    registration.referenceCollections ?? {},
  )) {
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      enumerable: false,
      get(this: Model) {
        const { pool } = getSyncContext();
        return pool
          .getAll(coll.referencedModel)
          .filter((m) => m.__data[coll.foreignKey] === this.id);
      },
    });
  }
}

/** Constructs and hydrates a model instance from raw data. */
export function createModelFromData(
  modelName: string,
  data: Record<string, unknown>,
): Model {
  const ctor = ModelRegistry.getConstructor(modelName);
  const model = new ctor();
  model.updateFromData(data);
  return model;
}
