// Editor operations per window (INV §2). Groups, panels, status, contexts
// and the cursor reset act on the active window, so an operation for
// another window waits here until that window is active. One waits per
// kind: a later one of the same kind replaces the earlier.

export class WindowQueue {
  private readonly queues = new Map<number, Map<string, () => void>>();
  private readonly active: () => number;
  private readonly onError: (e: unknown) => void;

  constructor(opts: { active: () => number; onError: (e: unknown) => void }) {
    this.active = opts.active;
    this.onError = opts.onError;
  }

  /** Runs `op` now if `windowId` is active, else when it next is. One that
   *  runs at once drops its queued twin, which is stale now. */
  run(windowId: number, kind: string, op: () => void): void {
    if (this.active() === windowId) {
      this.queues.get(windowId)?.delete(kind);
      this.call(op);
      return;
    }
    let q = this.queues.get(windowId);
    if (q === undefined) {
      q = new Map();
      this.queues.set(windowId, q);
    }
    q.delete(kind);
    q.set(kind, op);
  }

  /** Forgets the queued operations whose kind starts with `prefix`, except
   *  those `keep` names (by the rest of the kind). */
  drop(windowId: number, prefix: string, keep: (rest: string) => boolean = () => false): void {
    const q = this.queues.get(windowId);
    if (q === undefined) return;
    for (const k of [...q.keys()]) if (k.startsWith(prefix) && !keep(k.slice(prefix.length))) q.delete(k);
  }

  /** Forgets every operation queued for `windowId`: the window closed. */
  forget(windowId: number): void {
    this.queues.delete(windowId);
  }

  /** Runs the queued operations of `windowId`, in order, while it is still
   *  the active window: the `active_window_changed` that drains a queue can
   *  arrive after the user has moved on, and an operation can switch
   *  windows. The rest wait for the next switch back. One that an earlier
   *  operation dropped, or ran a newer twin of, is skipped. */
  drain(windowId: number): void {
    const q = this.queues.get(windowId);
    if (q === undefined) return;
    for (const [kind, op] of [...q]) {
      if (this.active() !== windowId) break;
      if (q.get(kind) !== op) continue;
      q.delete(kind);
      this.call(op);
    }
    if (q.size === 0 && this.queues.get(windowId) === q) this.queues.delete(windowId);
  }

  /** Kinds waiting for `windowId`, in order (for tests). */
  waiting(windowId: number): string[] {
    return [...(this.queues.get(windowId)?.keys() ?? [])];
  }

  private call(op: () => void): void {
    try {
      op();
    } catch (e) {
      this.onError(e);
    }
  }
}
