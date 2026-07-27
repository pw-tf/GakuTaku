import type { ApkgCard, ApkgDconf, ApkgRevlog } from './apkg';
import { defaultPresetConfig, type DeckPresetConfig } from '../srs/presets';

/**
 * Pure `.apkg` → GakuTaku mappings for card user-state, revlog entries, and legacy deck options.
 * Split from importApkg.ts (which touches the DB) so `scripts/verify-srs.ts` can table-test them.
 */

/** The user-state portion of an imported card. */
export interface MappedCardState {
  /** Anki queue preserved 1:1: 0 active, -1 suspended, -2 sched-buried, -3 user-buried. */
  queue: number;
  /** Colored flag (low 3 bits of Anki `flags`). */
  flag: number;
  /** New-card position (Anki stores it in `due` while type = 0); null otherwise. */
  position: number | null;
  /** Buried cards get `buried_until` = the importer's next day rollover. */
  buried: boolean;
}

export function mapApkgCardState(c: Pick<ApkgCard, 'type' | 'queue' | 'due' | 'flags'>): MappedCardState {
  const queue = c.queue === -1 || c.queue === -2 || c.queue === -3 ? c.queue : 0;
  return {
    queue,
    flag: (c.flags ?? 0) & 0x7,
    position: c.type === 0 ? c.due : null,
    buried: queue <= -2,
  };
}

/** What to do with one revlog entry. */
export type RevlogMapping =
  | { kind: 'review'; rating: number }
  /** A manual (ease 0) entry: scheduledDays -1 = forget, N ≥ 0 = set due date. */
  | { kind: 'manual'; scheduledDays: number }
  | { kind: 'skip' };

/**
 * Anki revlog semantics: `ease` 1–4 are answers; `ease` 0 marks manual scheduling (forget when the
 * new interval is ≤ 0, set-due-date when positive) — mapped onto our rating-0 manual events so the
 * replay reproduces Anki's post-forget/post-reschedule state. Filtered-deck reviews done with
 * rescheduling disabled (type 3, factor 0) never affected scheduling and are skipped, matching what
 * Anki feeds FSRS.
 */
export function mapRevlogEntry(r: Pick<ApkgRevlog, 'ease' | 'ivl' | 'factor' | 'type'>): RevlogMapping {
  if (r.type === 3 && r.factor === 0) return { kind: 'skip' };
  if (r.ease >= 1 && r.ease <= 4) return { kind: 'review', rating: r.ease };
  if (r.ease === 0) return { kind: 'manual', scheduledDays: r.ivl > 0 ? r.ivl : -1 };
  return { kind: 'skip' };
}

/** Anki step delays are minutes; render as the most natural steps unit. */
export function stepsFromMinutes(mins: number[] | undefined): string[] | undefined {
  if (!mins?.length) return undefined;
  const steps = mins
    .filter((m) => Number.isFinite(m) && m > 0)
    .map((m) => {
      if (m < 1) return `${Math.round(m * 60)}s`;
      if (m % 1440 === 0) return `${m / 1440}d`;
      if (m % 60 === 0) return `${m / 60}h`;
      return `${Math.round(m)}m`;
    });
  return steps.length ? steps : undefined;
}

/** Map a legacy options group onto a preset (unmapped knobs keep the Anki defaults). */
export function mapDconfToPreset(d: ApkgDconf): DeckPresetConfig {
  const base = defaultPresetConfig();
  return {
    ...base,
    newPerDay: d.newPerDay != null && d.newPerDay >= 0 ? d.newPerDay : base.newPerDay,
    reviewsPerDay: d.revPerDay != null && d.revPerDay >= 0 ? d.revPerDay : base.reviewsPerDay,
    learningSteps: stepsFromMinutes(d.learnSteps) ?? base.learningSteps,
    relearningSteps: stepsFromMinutes(d.relearnSteps) ?? base.relearningSteps,
    leechThreshold: d.leechFails != null && d.leechFails >= 1 ? Math.floor(d.leechFails) : base.leechThreshold,
    // Anki lapse.leechAction: 0 = suspend (its default), 1 = tag only.
    leechAction: d.leechAction === 1 ? 'tagOnly' : 'suspend',
    buryNewSiblings: d.buryNew ?? base.buryNewSiblings,
    buryReviewSiblings: d.buryRev ?? base.buryReviewSiblings,
    // Anki new.order: 0 = random insertion, 1 = sequential (its default).
    insertionOrder: d.newOrder === 0 ? 'random' : 'sequential',
  };
}
