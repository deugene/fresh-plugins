// When to run the next `git status`: a pure state machine over an injected
// clock (R8, R9, R11). One run at a time; after each run, a quiet gap of at
// least 3x its duration, so git is busy no more than 25% of wall time. The
// gap is capped at a minute, so a run that spans a laptop sleep (a wall-clock
// duration of hours) cannot push the next refresh hours out.

/** Delay before an urgent run, so a burst of events costs one run. */
const URGENT_DELAY_MS = 100;
/** Shortest gap between background polls. */
const POLL_MS = 2000;
/** Gap after a run, as a multiple of its duration. */
const GAP_FACTOR = 3;
/** Longest gap after a run, whatever its duration. */
const MAX_GAP_MS = 60_000;

export class Scheduler {
  private inFlight = false;
  /** Earliest time an urgent request may run, or null when none is pending. */
  private urgentAt: number | null = null;
  private lastEnd: number | null = null;
  private lastDuration = 0;
  /** No polling (volume mode, or before git has been found). Urgent
   *  requests still run. */
  private pollingOn = true;

  setPolling(on: boolean): void {
    this.pollingOn = on;
  }

  /** Something the user did may have changed the status. */
  requestUrgent(now: number): void {
    this.sync(now);
    const at = now + URGENT_DELAY_MS;
    this.urgentAt = this.urgentAt === null ? at : Math.min(this.urgentAt, at);
  }

  /** The wall clock stepped back (a clock change, a VM resume): times
   *  recorded before the step are in the future, and would hold every run
   *  back until the clock caught up with them. Treat them as now. */
  private sync(now: number): void {
    if (this.lastEnd !== null && this.lastEnd > now) this.lastEnd = now;
    if (this.urgentAt !== null && this.urgentAt > now + URGENT_DELAY_MS) this.urgentAt = now + URGENT_DELAY_MS;
  }

  /** Forget pending work (no section, nothing to refresh). */
  cancel(): void {
    this.urgentAt = null;
  }

  private gap(): number {
    return Math.min(GAP_FACTOR * this.lastDuration, MAX_GAP_MS);
  }

  /** Absolute time the next run is due, or null when nothing is due (a run
   *  is in flight, or nothing is pending and polling is off). */
  nextDue(): number | null {
    if (this.inFlight) return null;
    const settled = this.lastEnd === null ? -Infinity : this.lastEnd + this.gap();
    const urgent = this.urgentAt === null ? null : Math.max(this.urgentAt, settled);
    const poll =
      this.pollingOn && this.lastEnd !== null ? this.lastEnd + Math.max(POLL_MS, this.gap()) : null;
    if (urgent === null) return poll;
    if (poll === null) return urgent;
    return Math.min(urgent, poll);
  }

  /** Begin a run if one is due. Returns whether the caller should run git. */
  tryStart(now: number): boolean {
    this.sync(now);
    const due = this.nextDue();
    if (due === null || now < due) return false;
    this.inFlight = true;
    // Every request made before this run starts is answered by it.
    this.urgentAt = null;
    return true;
  }

  /** The run started by `tryStart` settled at `now` after `durationMs` —
   *  for a timed-out run, the time until it really settled. */
  finish(now: number, durationMs: number): void {
    this.inFlight = false;
    this.lastEnd = now;
    this.lastDuration = Math.max(0, durationMs);
  }
}

/** The single host timer that drives the scheduler: re-armed for the next
 *  due time and never more than one outstanding. */
export class SingleTimer {
  private id: number | null = null;
  private at: number | null = null;
  private readonly set: (ms: number) => number;
  private readonly clear: (id: number) => void;

  constructor(set: (ms: number) => number, clear: (id: number) => void) {
    this.set = set;
    this.clear = clear;
  }

  /** Arm for `due` (absolute), or disarm when `due` is null. */
  arm(due: number | null, now: number): void {
    if (due === this.at && this.id !== null) return;
    if (this.id !== null) this.clear(this.id);
    this.id = null;
    this.at = due;
    if (due === null) return;
    this.id = this.set(Math.max(0, due - now));
  }

  /** The timer fired: it is no longer armed. */
  fired(): void {
    this.id = null;
    this.at = null;
  }
}
