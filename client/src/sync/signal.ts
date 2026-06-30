/**
 * Minimal observability primitive. Linear uses MobX for this; we keep the
 * same idea (models/collections are observable, views react automatically)
 * with a dependency-free signal that plugs into React via
 * `useSyncExternalStore` (see react.ts).
 */
export class Signal {
  private listeners = new Set<() => void>();
  /** Monotonic version, used as a cheap snapshot for useSyncExternalStore. */
  version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  notify(): void {
    this.version++;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
