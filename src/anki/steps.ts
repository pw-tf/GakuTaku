/** Learning/relearning step arithmetic — a direct port of rslib/src/scheduler/states/steps.rs. */

const DAY = 86_400;

const toSecs = (minutes: number) => Math.trunc(minutes * 60);

function maybeRoundInDays(secs: number): number {
  return secs > DAY ? Math.round(secs / DAY) * DAY : secs;
}

export class LearningSteps {
  constructor(readonly steps: readonly number[]) {}

  private getIndex(remaining: number): number {
    const total = this.steps.length;
    return Math.min(Math.max(0, total - (remaining % 1000)), Math.max(0, total - 1));
  }

  private secsAtIndex(index: number): number | null {
    const v = this.steps[index];
    return v === undefined ? null : toSecs(v);
  }

  againDelaySecsLearn(): number | null {
    return this.secsAtIndex(0);
  }

  hardDelaySecs(remaining: number): number | null {
    const idx = this.getIndex(remaining);
    const current = this.secsAtIndex(idx) ?? (this.steps.length ? toSecs(this.steps[0]) : null);
    if (current == null) return null;
    return idx === 0 ? this.hardDelaySecsForFirstStep(current) : current;
  }

  private hardDelaySecsForFirstStep(againSecs: number): number {
    const next = this.secsAtIndex(1);
    if (next != null) return maybeRoundInDays(Math.floor((againSecs + next) / 2));
    const secs = Math.min(Math.floor((againSecs * 3) / 2), againSecs + DAY);
    return maybeRoundInDays(secs);
  }

  goodDelaySecs(remaining: number): number | null {
    return this.secsAtIndex(this.getIndex(remaining) + 1);
  }

  currentDelaySecs(remaining: number): number {
    return this.secsAtIndex(this.getIndex(remaining)) ?? 0;
  }

  remainingForGood(remaining: number): number {
    return Math.max(0, this.steps.length - (this.getIndex(remaining) + 1));
  }

  remainingForFailed(): number {
    return this.steps.length;
  }

  isEmpty(): boolean {
    return this.steps.length === 0;
  }
}
