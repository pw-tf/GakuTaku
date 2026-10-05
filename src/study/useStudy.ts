import { useCallback, useEffect, useRef, useState } from 'react';
import { col } from '../anki/appCollection';
import type { AnswerUndo, StudyCard } from '../anki/collection';
import type { CardQueues, Counts, EntryKind } from '../anki/queue';
import { asSeconds, intervalKind, maybeAsDays } from '../anki/states';
import { compareAnswer, renderCard, typeAnswerExpected, type RenderedCard } from '../anki/template';
import { answerButtonTimeCollapsible } from '../anki/timespan';
import type { Rating } from '../anki/types';
import { playAudio, stopAudio } from './audio';

/**
 * A study session over Anki's queue (src/anki/queue.ts): shows cards in Anki's order, answers them
 * through the ported scheduler, keeps the new/learning/review counts the way Anki does, and
 * supports undo of answers. Learning cards that come due while studying appear automatically.
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

  /** Load the next card from the queue (or the "done" state). */
  const showNext = useCallback(async () => {
    const q = queues.current;
    if (!q) return;
    const nowMs = Date.now();
    const t = await col.timing(nowMs);
    if (t.today !== q.today) {
      // The study day rolled over while studying: rebuild, as Anki does.
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
    const study = await col.studyCard(entry.id, nowMs);
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
  }, [deckId]);

  // Build the queue on mount / deck change.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        learnAhead.current = (await col.config()).learnAheadSecs;
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
        const snapshot = queues.current.snapshot();
        const nowMs = Date.now();
        const { undo, card } = await col.answer(s.card, rating, nowMs - shownAt.current, nowMs);
        undoStack.current.push({ undo, snapshot });
        if (undoStack.current.length > 30) undoStack.current.shift();
        reviewed.current++;
        const t = await col.timing(nowMs);
        queues.current.pop(card.id);
        queues.current.requeueLearning(card, t.nextDayAt);
        queues.current.updateLearningCutoffAndCount(t.now);
        // Siblings buried by this answer leave the session too.
        if (undo.buriedSiblings.length) queues.current.remove(new Set(undo.buriedSiblings.map((b) => b.id)));
        await showNext();
      } catch (e) {
        setState((st) => ({ ...st, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        busy.current = false;
      }
    },
    [state, showNext],
  );

  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    if (!entry || busy.current) return;
    busy.current = true;
    try {
      await col.undoAnswer(entry.undo);
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
