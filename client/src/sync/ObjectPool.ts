import type { Model } from "./Model";
import { Signal } from "./signal";

/**
 * The Object Pool: one big map of UUID -> hydrated model instance.
 * Every part of the app retrieves models from here; collections per model
 * are observable so list views update automatically when models are
 * added/removed (individual model edits notify via model.changeSignal).
 */
export class ObjectPool {
  /** uuid -> model (Linear calls this `modelLookup` on the SyncClient). */
  private modelLookup = new Map<string, Model>();
  /** modelName -> set of live models of that type. */
  private byModel = new Map<string, Set<Model>>();
  /** modelName -> signal notified when that collection changes. */
  private collectionSignals = new Map<string, Signal>();

  signalFor(modelName: string): Signal {
    let signal = this.collectionSignals.get(modelName);
    if (!signal) {
      signal = new Signal();
      this.collectionSignals.set(modelName, signal);
    }
    return signal;
  }

  get(id: string): Model | undefined {
    return this.modelLookup.get(id);
  }

  add(model: Model): void {
    const existing = this.modelLookup.get(model.id);
    if (existing === model) return;
    this.modelLookup.set(model.id, model);
    let set = this.byModel.get(model.modelName);
    if (!set) {
      set = new Set();
      this.byModel.set(model.modelName, set);
    }
    if (existing) set.delete(existing);
    set.add(model);
    this.signalFor(model.modelName).notify();
  }

  remove(id: string): Model | undefined {
    const model = this.modelLookup.get(id);
    if (!model) return undefined;
    this.modelLookup.delete(id);
    this.byModel.get(model.modelName)?.delete(model);
    this.signalFor(model.modelName).notify();
    return model;
  }

  getAll(modelName: string): Model[] {
    return [...(this.byModel.get(modelName) ?? [])];
  }

  size(): number {
    return this.modelLookup.size;
  }
}
