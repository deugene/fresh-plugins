// One render in flight per tab (R9). A request while a run is in flight
// only marks the view dirty. When the run ends its result is still applied
// (the entry clips it to the area at that moment), so a held key keeps the
// screen moving, and then one more run draws the latest view. A run that
// ends after `alive()` turned false (an epoch change) is dropped and ends
// the loop.

export interface FlightOptions<T> {
  /** Renders the view as it is when the run starts; null for a failure the
   *  run has already handled. */
  run: () => Promise<T | null>;
  apply: (result: T) => void;
  alive: () => boolean;
  /** A run that threw. The loop stops. */
  onError: (e: unknown) => void;
}

export class SingleFlight<T> {
  private readonly opts: FlightOptions<T>;
  private running = false;
  private dirty = false;

  constructor(opts: FlightOptions<T>) {
    this.opts = opts;
  }

  get busy(): boolean {
    return this.running;
  }

  request(): void {
    if (!this.opts.alive()) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    this.loop().then(undefined, (e: unknown) => this.opts.onError(e));
  }

  /** Clears `running` as it returns, not in a later `.then`: a request made
   *  in between would only mark a finished loop dirty, and be lost. */
  private async loop(): Promise<void> {
    try {
      do {
        this.dirty = false;
        const result = await this.opts.run();
        if (!this.opts.alive()) return;
        if (result !== null) this.opts.apply(result);
      } while (this.dirty && this.opts.alive());
    } finally {
      this.running = false;
    }
  }
}
