import { useCallback, useEffect, useRef, useState } from 'react';
import { col } from '../anki/appCollection';
import type { AnswerUndo, CardsSnapshot, StudyCard } from '../anki/collection';
import type { CardQueues, Counts, EntryKind } from '../anki/queue';
import { asSeconds, intervalKind, maybeAsDays } from '../anki/states';
import { compareAnswer, renderCard, typeAnswerExpected, type RenderedCard } from '../anki/template';
import { answerButtonTimeCollapsible } from '../anki/timespan';
import { timingAt } from '../anki/timing';
import { defaultCollectionConfig, type CollectionConfig, type Rating } from '../anki/types';
import { setStudying } from '../db/useLive';
import { playAudio, stopAudio } from './audio';

/**
 * A study session over Anki's queue (src/anki/queue.ts): shows cards in Anki's order, answers them
 * through the ported scheduler, keeps the new/learning/review counts the way Anki does, and
 * supports undo of answers. Learning cards that come due while studying appear automatically.
 *
 * To keep answering snappy, an answer is worked out in memory and the next card (prefetched while
 * the current one was on screen) is shown straight away; the answer is saved in the background, in
 * order, and undo waits for it.
 */

export interface StudyState {
  loading: boolean;
  error: string | null;
  /** The card being shown, or null when there's nothing to study right now. */
  card: StudyCard | null;
  kind: EntryKind | null;
  rendered: RenderedCard | null;
  /** Question HTML (with the type box), or the answer HTML once revealed. */
  html: string;
  shown: boolean;
  counts: Counts;
  /** Labels for the four buttons ("<10m", "3d", …). */
  buttonLabels: string[];
  /** When nothing is due *yet*: the earliest learning card's due time (unix secs). */
  nextLearningAt: number | null;
  reviewedCount: number;
  canUndo: boolean;
  /** What Undo would undo ("Answer", "Bury", …). */
  undoLabel: string | null;
  /** When the current card was shown (epoch ms), for the answer timer. */
  shownAt: number;
  /** Bumped when the current card's content changes (e.g. after an edit). */
  version: number;
}

type UndoEntry =
  | { kind: 'answer'; label: string; undo: AnswerUndo; snapshot: ReturnType<CardQueues['snapshot']> }
  | { kind: 'action'; label: string; cards: CardsSnapshot; snapshot: ReturnType<CardQueues['snapshot']> };

const TYPE_MARKER = /\[\[type:[^\]]+\]\]/g;
const TYPE_INPUT = '<input type="text" id="typeans" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">';

/** The question side, with Anki's type-in box. */
const questionHtml = (r: RenderedCard) => r.question.replace(TYPE_MARKER, TYPE_INPUT);

/** The answer side, with the typed answer compared against the expected one. */
function answerHtml(r: RenderedCard, card: StudyCard, typed: string): string {
  if (!/\[\[type:/.test(r.answer)) return r.answer;
  return r.answer.replace(TYPE_MARKER, (marker) => compareAnswer(typeAnswerExpected(marker, card.notetype, card.note.flds, card.prepared.card.ord), typed.trim()));
}

const EMPTY_COUNTS: Counts = { new: 0, learning: 0, review: 0 };

export function useStudy(deckId: number) {
  const [state, setState] = useState<StudyState>({
    loading: true, error: null, card: null, kind: null, rendered: null, html: '', shown: false, counts: EMPTY_COUNTS,
    buttonLabels: [], nextLearningAt: null, reviewedCount: 0, canUndo: false, undoLabel: null, shownAt: Date.now(), version: 0,
  });
  const queues = useRef<CardQueues | null>(null);
  const undoStack = useRef<UndoEntry[]>([]);
  const shownAt = useRef(Date.now());
  const typed = useRef('');
  const learnAhead = useRef(1200);
  const busy = useRef(false);
  const reviewed = useRef(0);
  const autoplay = useRef(true);
  const colConfig = useRef<CollectionConfig>(defaultCollectionConfig());
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Answers being saved, in order. */
  const pendingWrites = useRef<Promise<unknown>>(Promise.resolve());
  /** The card expected after the current one, loaded in the background. */
  const prefetch = useRef<{ id: number; promise: Promise<StudyCard | null> } | null>(null);
  /** Queues of cards changed this session, newer than any prefetched copy of them. */
  const knownQueue = useRef(new Map<number, number>());

  const undoInfo = () => {
    const top = undoStack.current[undoStack.current.length - 1];
    return { canUndo: !!top, undoLabel: top?.label ?? null };
  };

  /** Load the next card from the queue (or the "done" state). `fresh` skips the prefetch for that card. */
  const showNext = useCallback(async (fresh?: number): Promise<void> => {
    const q = queues.current;
    if (!q) return;
    const nowMs = Date.now();
    const t = timingAt(nowMs, colConfig.current.rollover);
    if (t.today !== q.today) {
      // The study day rolled over while studying: rebuild, as Anki does.
      await pendingWrites.current;
      prefetch.current = null;
      queues.current = await col.buildQueues(deckId, nowMs);
      return showNext();
    }
    const counts = queues.current!.getCounts(t.now);
    const entry = queues.current!.next(t.now);
    if (!entry) {
      stopAudio();
      setState((s) => ({ ...s, loading: false, card: null, kind: null, rendered: null, html: '', shown: false, counts, nextLearningAt: queues.current!.nextLearningDue(), ...undoInfo(), reviewedCount: reviewed.current }));
      return;
    }
    const pre = prefetch.current;
    prefetch.current = null;
    let study = pre && pre.id === entry.id && entry.id !== fresh ? await pre.promise : null;
    if (study) {
      const known = knownQueue.current;
      study = col.reprepare({ ...study, siblings: study.siblings.map((sib) => (known.has(sib.id) ? { ...sib, queue: known.get(sib.id)! } : sib)) }, nowMs);
    } else study = await col.studyCard(entry.id, nowMs);
    if (!study) {
      // Deleted meanwhile — drop it and move on.
      queues.current!.pop(entry.id);
      return showNext();
    }
    const deckName = study.deck.name;
    const rendered = renderCard({ notetype: study.notetype, flds: study.note.flds, ord: study.prepared.card.ord, tags: study.note.tags, deckName, flags: study.prepared.card.flags, cardId: study.prepared.card.id });
    const rollover = t.nextDayAt - t.now;
    const states = study.prepared.states;
    const buttonLabels = [states.again, states.hard, states.good, states.easy].map((s) =>
      answerButtonTimeCollapsible(asSeconds(maybeAsDays(intervalKind(s), rollover)), learnAhead.current),
    );
    typed.current = '';
    shownAt.current = Date.now();
    autoplay.current = !study.config.disableAutoplay;
    const html = questionHtml(rendered);
    setState((s) => ({
      ...s, loading: false, error: null, card: study, kind: entry.kind, rendered, html, shown: false, counts, buttonLabels,
      nextLearningAt: null, ...undoInfo(), reviewedCount: reviewed.current, shownAt: shownAt.current, version: s.version + 1,
    }));
    if (autoplay.current) void playAudio(rendered.questionAv);

    // Load the card that should follow this one while this one is studied.
    const qs = queues.current!;
    const snap = qs.snapshot();
    qs.pop(entry.id);
    const following = qs.next(t.now);
    qs.restore(snap);
    if (following && following.id !== entry.id) prefetch.current = { id: following.id, promise: col.studyCard(following.id).catch(() => null) };
  }, [deckId]);

  // Build the queue on mount / deck change.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        colConfig.current = await col.config();
        learnAhead.current = colConfig.current.learnAheadSecs;
        const q = await col.buildQueues(deckId);
        if (!alive) return;
        queues.current = q;
        undoStack.current = [];
        reviewed.current = 0;
        await showNext();
      } catch (e) {
        if (alive) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      alive = false;
      stopAudio();
    };
  }, [deckId, showNext]);

  // Hold back deck-list recounts while studying (see setStudying).
  useEffect(() => {
    setStudying(true);
    return () => setStudying(false);
  }, []);

  // While waiting on a learning card, wake up when it comes due (minus the learn-ahead window).
  useEffect(() => {
    if (state.card || !state.nextLearningAt) return;
    const wait = Math.max(1000, (state.nextLearningAt - learnAhead.current) * 1000 - Date.now() + 500);
    const id = setTimeout(() => {
      queues.current?.updateLearningCutoffAndCount(Math.floor(Date.now() / 1000));
      void showNext();
    }, Math.min(wait, 60_000));
    return () => clearTimeout(id);
  }, [state.card, state.nextLearningAt, showNext]);

  const reveal = useCallback(() => {
    setState((s) => {
      if (!s.card || !s.rendered || s.shown) return s;
      const html = answerHtml(s.rendered, s.card, typed.current);
      if (autoplay.current) void playAudio(s.rendered.answerAv);
      return { ...s, shown: true, html, version: s.version + 1 };
    });
  }, []);

  const answer = useCallback(
    async (rating: Rating) => {
      const s = state;
      if (!s.card || !s.shown || busy.current || !queues.current) return;
      busy.current = true;
      try {
        stopAudio();
        const q = queues.current;
        const snapshot = q.snapshot();
        const nowMs = Date.now();
        const plan = col.planAnswer(s.card, rating, nowMs - shownAt.current, nowMs);
        const t = timingAt(nowMs, colConfig.current.rollover);
        q.pop(plan.card.id);
        q.requeueLearning(plan.card, t.nextDayAt);
        q.updateLearningCutoffAndCount(t.now);
        // Siblings buried by this answer leave the session too.
        if (plan.bury.length) q.remove(new Set(plan.bury.map((b) => b.id)));
        knownQueue.current.set(plan.card.id, plan.card.queue);
        for (const b of plan.bury) knownQueue.current.set(b.id, -2);
        reviewed.current++;

        // Save in the background, in order; undo waits for it.
        pendingWrites.current = pendingWrites.current
          .then(() => col.commitAnswer(plan))
          .then(
            ({ undo }) => {
              pushUndo({ kind: 'answer', label: 'Answer', undo, snapshot });
            },
            (e: unknown) => setState((st) => ({ ...st, error: `Couldn’t save that answer: ${e instanceof Error ? e.message : String(e)}` })),
          );
        await showNext(plan.card.id);
      } catch (e) {
        setState((st) => ({ ...st, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        busy.current = false;
      }
    },
    [state, showNext],
  );

  const undo = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await pendingWrites.current;
      const entry = undoStack.current.pop();
      if (!entry) return;
      if (entry.kind === 'answer') {
        await col.undoAnswer(entry.undo);
        reviewed.current = Math.max(0, reviewed.current - 1);
      } else {
        await col.restoreSnapshot(entry.cards);
      }
      // Anything loaded ahead may now be out of date.
      prefetch.current = null;
      knownQueue.current.clear();
      queues.current?.restore(entry.snapshot);
      await showNext();
    } finally {
      busy.current = false;
    }
  }, [showNext]);

  function pushUndo(entry: UndoEntry) {
    undoStack.current.push(entry);
    if (undoStack.current.length > 30) undoStack.current.shift();
    setState((st) => ({ ...st, ...undoInfo() }));
  }

  /**
   * A card action that can be undone (bury, suspend, flag, mark, forget, set due, delete): the
   * affected cards (and notes) are remembered first. Cards in `leave` drop out of this session;
   * otherwise the current card is reloaded to show the change. Resolves to an error message if the
   * action failed (nothing is then recorded for undo).
   */
  const perform = useCallback(
    async (label: string, action: () => Promise<unknown>, opts: { cids: number[]; nids?: number[]; leave?: number[] }): Promise<string | undefined> => {
      if (busy.current || !queues.current) return undefined;
      busy.current = true;
      try {
        await pendingWrites.current;
        const cards = await col.snapshot(opts.cids, opts.nids);
        const snapshot = queues.current.snapshot();
        await action();
        pushUndo({ kind: 'action', label, cards, snapshot });
        prefetch.current = null;
        knownQueue.current.clear();
        if (opts.leave?.length) {
          queues.current.remove(new Set(opts.leave));
          await showNext();
        } else {
          await reloadCurrent();
        }
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        busy.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showNext],
  );

  /** After an action removed cards (bury/suspend/forget/delete/set due): drop them and continue. */
  const removeFromSession = useCallback(
    async (ids: number[]) => {
      queues.current?.remove(new Set(ids));
      await showNext();
    },
    [showNext],
  );

  /** Re-render the current card (after editing its note or changing its flag). */
  const refreshCurrent = useCallback(() => reloadCurrent(), []);

  /** Reload the current card from the database, keeping the side shown and its timing. */
  async function reloadCurrent(): Promise<void> {
    const cur = stateRef.current.card;
    if (!cur) return;
    const study = await col.studyCard(cur.prepared.card.id);
    if (!study) {
      queues.current?.remove(new Set([cur.prepared.card.id]));
      return showNext();
    }
    const rendered = renderCard({ notetype: study.notetype, flds: study.note.flds, ord: study.prepared.card.ord, tags: study.note.tags, deckName: study.deck.name, flags: study.prepared.card.flags, cardId: study.prepared.card.id });
    setState((st) => ({
      ...st, card: study, rendered,
      html: st.shown ? answerHtml(rendered, study, typed.current) : questionHtml(rendered),
      version: st.version + 1,
    }));
  }

  const setTyped = useCallback((v: string) => {
    typed.current = v;
  }, []);

  const replay = useCallback(() => {
    const s = state;
    if (!s.rendered) return;
    void playAudio(s.shown ? [...s.rendered.questionAv, ...s.rendered.answerAv] : s.rendered.questionAv);
  }, [state]);

  const playRef = useCallback(
    (ref: string) => {
      const r = state.rendered;
      if (!r) return;
      const [side, idx] = ref.split(':');
      const tag = (side === 'q' ? r.questionAv : r.answerAv)[Number(idx)];
      if (tag) void playAudio([tag]);
    },
    [state.rendered],
  );

  return { state, reveal, answer, undo, perform, removeFromSession, refreshCurrent, setTyped, replay, playRef };
}
