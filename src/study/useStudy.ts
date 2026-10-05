import { useCallback, useEffect, useRef, useState } from 'react';
import { col } from '../anki/appCollection';
import type { AnswerUndo, StudyCard } from '../anki/collection';
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
  /** Bumped when the current card's content changes (e.g. after an edit). */
  version: number;
}

interface UndoEntry {
  undo: AnswerUndo;
  snapshot: ReturnType<CardQueues['snapshot']>;
}

const EMPTY_COUNTS: Counts = { new: 0, learning: 0, review: 0 };

export function useStudy(deckId: number) {
  const [state, setState] = useState<StudyState>({
    loading: true, error: null, card: null, kind: null, rendered: null, html: '', shown: false, counts: EMPTY_COUNTS,
    buttonLabels: [], nextLearningAt: null, reviewedCount: 0, canUndo: false, version: 0,
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
  /** Answers being saved, in order. */
  const pendingWrites = useRef<Promise<unknown>>(Promise.resolve());
  /** The card expected after the current one, loaded in the background. */
  const prefetch = useRef<{ id: number; promise: Promise<StudyCard | null> } | null>(null);
  /** Queues of cards changed this session, newer than any prefetched copy of them. */
  const knownQueue = useRef(new Map<number, number>());

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
      setState((s) => ({ ...s, loading: false, card: null, kind: null, rendered: null, html: '', shown: false, counts, nextLearningAt: queues.current!.nextLearningDue(), canUndo: undoStack.current.length > 0, reviewedCount: reviewed.current }));
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
    const html = rendered.question.replace(/\[\[type:[^\]]+\]\]/g, '<input type="text" id="typeans" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">');
    setState((s) => ({
      ...s, loading: false, error: null, card: study, kind: entry.kind, rendered, html, shown: false, counts, buttonLabels,
      nextLearningAt: null, canUndo: undoStack.current.length > 0, reviewedCount: reviewed.current, version: s.version + 1,
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
      let html = s.rendered.answer;
      if (/\[\[type:/.test(html)) {
        html = html.replace(/\[\[type:[^\]]+\]\]/g, (marker) =>
          compareAnswer(typeAnswerExpected(marker, s.card!.notetype, s.card!.note.flds, s.card!.prepared.card.ord), typed.current.trim()),
        );
      }
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
              undoStack.current.push({ undo, snapshot });
              if (undoStack.current.length > 30) undoStack.current.shift();
              setState((st) => ({ ...st, canUndo: true }));
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
      await col.undoAnswer(entry.undo);
      // Anything loaded ahead may now be out of date.
      prefetch.current = null;
      knownQueue.current.clear();
      queues.current?.restore(entry.snapshot);
      reviewed.current = Math.max(0, reviewed.current - 1);
      await showNext();
    } finally {
      busy.current = false;
    }
  }, [showNext]);

  /** After an action removed cards (bury/suspend/forget/delete/set due): drop them and continue. */
  const removeFromSession = useCallback(
    async (ids: number[]) => {
      queues.current?.remove(new Set(ids));
      await showNext();
    },
    [showNext],
  );

  /** Re-render the current card (after editing its note or changing its flag). */
  const refreshCurrent = useCallback(async () => {
    const s = state;
    if (!s.card) return;
    const study = await col.studyCard(s.card.prepared.card.id);
    if (!study) return removeFromSession([s.card.prepared.card.id]);
    const rendered = renderCard({ notetype: study.notetype, flds: study.note.flds, ord: study.prepared.card.ord, tags: study.note.tags, deckName: study.deck.name, flags: study.prepared.card.flags, cardId: study.prepared.card.id });
    setState((st) => ({
      ...st, card: study, rendered,
      html: st.shown ? rendered.answer : rendered.question.replace(/\[\[type:[^\]]+\]\]/g, '<input type="text" id="typeans">'),
      version: st.version + 1,
    }));
  }, [state, removeFromSession]);

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

  return { state, reveal, answer, undo, removeFromSession, refreshCurrent, setTyped, replay, playRef };
}
