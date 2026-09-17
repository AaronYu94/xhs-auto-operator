/** Injectable clock so recency scoring, rate limits and schedules are deterministic in tests. */
export interface Clock {
  now(): Date;
  iso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  iso(): string {
    return new Date().toISOString();
  }
}

export class ManualClock implements Clock {
  private t: number;

  constructor(start: string | Date) {
    this.t = new Date(start).getTime();
    if (Number.isNaN(this.t)) throw new Error(`ManualClock: invalid start ${String(start)}`);
  }

  now(): Date {
    return new Date(this.t);
  }

  iso(): string {
    return new Date(this.t).toISOString();
  }

  set(at: string | Date): void {
    const t = new Date(at).getTime();
    if (Number.isNaN(t)) throw new Error(`ManualClock.set: invalid time ${String(at)}`);
    this.t = t;
  }

  advance(by: { days?: number; hours?: number; minutes?: number; seconds?: number; ms?: number }): void {
    this.t +=
      (by.days ?? 0) * 86_400_000 +
      (by.hours ?? 0) * 3_600_000 +
      (by.minutes ?? 0) * 60_000 +
      (by.seconds ?? 0) * 1_000 +
      (by.ms ?? 0);
  }
}
