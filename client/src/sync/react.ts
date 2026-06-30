import { useMemo, useSyncExternalStore } from "react";
import type { Model } from "./Model";
import type { ObjectPool } from "./ObjectPool";
import type { Signal } from "./signal";

/** Subscribes a component to a signal; re-renders whenever it notifies. */
export function useSignal(signal: Signal): number {
  return useSyncExternalStore(signal.subscribe, () => signal.version);
}

/** Re-renders when any property of the model changes. */
export function useModel(model: Model): void {
  useSignal(model.changeSignal);
}

/** Live collection of all models of a type in the Object Pool. */
export function useCollection<T extends Model>(
  pool: ObjectPool,
  modelName: string,
): T[] {
  const version = useSignal(pool.signalFor(modelName));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the pool read
  return useMemo(
    () => pool.getAll(modelName) as T[],
    [pool, modelName, version],
  );
}
