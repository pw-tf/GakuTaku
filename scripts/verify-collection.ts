/**
 * Scenario tests for the collection layer (src/anki/collection.ts) on a real in-memory SQLite DB,
 * ported from Anki's pylib/tests/test_schedv3.py (SM-2 mode, fuzz off — as Anki's tests run).
 *
 *   npm run verify:collection
 */
import { Collection, DEFAULT_DECK_ID, renameFieldRefs, type StudyCard } from '../src/anki/collection';
import { splitFields } from '../src/anki/notetype';
import { setFuzzEnabled } from '../src/anki/fuzz';
import type { CardQueues } from '../src/anki/queue';
import { CardQueue, CardType, defaultDeckConfig, defaultFilteredConfig, type FilteredDeckConfig, type Rating } from '../src/anki/types';
import { asSeconds, intervalKind, maybeAsDays } from '../src/anki/states';
import { openTestDb } from './sqliteNode';

setFuzzEnabled(false);

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ ${name}`, detail ?? '');
  }
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

async function emptyCol(fsrs = false) {
  const { sql, raw } = await openTestDb();
  const col = new Collection(sql);
  await col.setConfig({ fsrs });
  await col.getOrCreateDeck('Default');
  const mid = await col.addNotetype({
    name: 'Basic',
    kind: 0,
    fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
    templates: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
    css: '',
    sortIdx: 0,
  });
  return { col, sql, raw, mid };
}

async function setConf(col: Collection, id: number, patch: Partial<ReturnType<typeof defaultDeckConfig>>) {
  const cur = (await col.deckConfigs()).find((c) => c.id === id)!;
  await col.updateDeckConfig(id, cur.name, { ...cur.config, ...patch });
}

/** Mimic Anki's `sched.getCard()` + `answerCard()` against a live queue. */
class Sched {
  q!: CardQueues;
  constructor(private col: Collection, private deckId = DEFAULT_DECK_ID, public now = Date.now()) {}
  async reset() {
    this.q = await this.col.buildQueues(this.deckId, this.now);
  }
  async counts() {
    if (!this.q) await this.reset();
    const c = this.q.getCounts(Math.floor(this.now / 1000));
    return [c.new, c.learning, c.review];
  }
  async getCard(): Promise<StudyCard | null> {
    if (!this.q) await this.reset();
    const e = this.q.next(Math.floor(this.now / 1000));
    return e ? this.col.studyCard(e.id, this.now) : null;
  }
  async answer(s: StudyCard, rating: Rating) {
    if (!this.q) await this.reset();
    const { card } = await this.col.answer(s, rating, 1000, this.now);
    this.q.pop(card.id);
    const t = await this.col.timing(this.now);
    this.q.requeueLearning(card, t.nextDayAt);
    this.q.updateLearningCutoffAndCount(Math.floor(this.now / 1000));
    return card;
  }
  /** Seconds until the button's outcome, as Anki's `nextIvl`. */
  async nextIvl(cardId: number, rating: Rating) {
    const s = (await this.col.studyCard(cardId, this.now))!;
    if (s.prepared.preview) return s.prepared.preview[rating - 1];
    const t = await this.col.timing(this.now);
    const next = [s.prepared.states.again, s.prepared.states.hard, s.prepared.states.good, s.prepared.states.easy][rating - 1];
    return asSeconds(maybeAsDays(intervalKind(next), t.nextDayAt - t.now));
  }
}

async function addBasic(col: Collection, mid: number, front: string, deckId = DEFAULT_DECK_ID) {
  const { cardIds } = await col.addNote(mid, [front, 'two'], [], deckId);
  return cardIds[0];
}

async function main() {
  // test_new
  {
    const { col, mid } = await emptyCol();
    const s = new Sched(col);
    eq('new: count 0', (await s.counts())[0], 0);
    await addBasic(col, mid, 'one');
    await s.reset();
    eq('new: count 1', (await s.counts())[0], 1);
    const c = (await s.getCard())!;
    eq('new: queue/type', [c.prepared.card.queue, c.prepared.card.type], [CardQueue.New, CardType.New]);
    const t = Math.floor(Date.now() / 1000);
    const after = await s.answer(c, 1);
    eq('new: again → learn', [after.queue, after.type], [CardQueue.Learn, CardType.Learn]);
    check('new: due >= now', after.due >= t);
  }

  // test_newLimits
  {
    const { col, mid } = await emptyCol();
    const deck2 = await col.getOrCreateDeck('Default::foo');
    for (let i = 0; i < 30; i++) await addBasic(col, mid, String(i), i > 4 ? deck2 : DEFAULT_DECK_ID);
    const c2 = await col.addDeckConfig('new conf', defaultDeckConfig());
    await col.updateDeck(deck2, { conf_id: c2 });
    const s = new Sched(col);
    await s.reset();
    eq('newLimits: 20', (await s.counts())[0], 20);
    eq('newLimits: first from parent', (await s.getCard())!.prepared.card.did, DEFAULT_DECK_ID);
    await setConf(col, 1, { newPerDay: 10 });
    await s.reset();
    eq('newLimits: parent 10', (await s.counts())[0], 10);
    await setConf(col, c2, { newPerDay: 4 });
    await s.reset();
    eq('newLimits: child 4 → 9', (await s.counts())[0], 9);
  }

  // test_learn
  {
    const { col, mid, raw } = await emptyCol();
    await addBasic(col, mid, 'one');
    await setConf(col, 1, { learnSteps: [0.5, 3, 10] });
    const s = new Sched(col);
    let c = (await s.getCard())!;
    let card = await s.answer(c, 1);
    eq('learn: 3 left', card.left % 1000, 3);
    const dueIn = card.due - Math.floor(s.now / 1000);
    check('learn: due in ~30s', dueIn >= 25 && dueIn <= 40, dueIn);
    c = (await col.studyCard(card.id, s.now))!;
    card = await s.answer(c, 3);
    const d2 = card.due - Math.floor(s.now / 1000);
    check('learn: due in 3m', d2 >= 178 && d2 <= 225, d2);
    eq('learn: 2 left', card.left % 1000, 2);
    const log = raw.exec('SELECT ease, ivl, lastIvl FROM revlog ORDER BY id DESC LIMIT 1')[0];
    eq('learn: revlog', [log.ease, log.ivl, log.lastIvl], [3, -180, -30]);
    c = (await col.studyCard(card.id, s.now))!;
    card = await s.answer(c, 3);
    eq('learn: 1 left', card.left % 1000, 1);
    eq('learn: still learning', [card.queue, card.type], [CardQueue.Learn, CardType.Learn]);
    c = (await col.studyCard(card.id, s.now))!;
    card = await s.answer(c, 3);
    const t = await col.timing(s.now);
    eq('learn: graduated', [card.queue, card.type, card.due - t.today, card.ivl], [CardQueue.Review, CardType.Review, 1, 1]);
    eq('learn: 4 learning revlogs', raw.exec('SELECT COUNT(*) AS n FROM revlog WHERE type = 0')[0].n, 4);
  }

  // test_relearn + test_relearn_no_steps
  for (const noSteps of [false, true]) {
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    const t = await col.timing();
    raw.exec('UPDATE cards SET ivl = 100, due = ?, queue = 2, type = 2, factor = 2500 WHERE id = ?', [t.today, cid]);
    if (noSteps) await setConf(col, 1, { relearnSteps: [] });
    const s = new Sched(col);
    const c = (await s.getCard())!;
    let card = await s.answer(c, 1);
    if (noSteps) {
      eq('relearn no steps: stays review', [card.queue, card.type], [CardQueue.Review, CardType.Review]);
    } else {
      eq('relearn: relearning', [card.queue, card.type, card.ivl], [CardQueue.Learn, CardType.Relearn, 1]);
      card = await s.answer((await col.studyCard(card.id, s.now))!, 4);
      eq('relearn: easy graduates', [card.queue, card.type, card.ivl, card.due - t.today], [CardQueue.Review, CardType.Review, 2, 2]);
    }
  }

  // test_learn_collapsed
  {
    const { col, mid } = await emptyCol();
    const a = await addBasic(col, mid, '1');
    const b = await addBasic(col, mid, '2');
    const s = new Sched(col);
    let c = (await s.getCard())!;
    eq('collapsed: first', c.prepared.card.id, a);
    await s.answer(c, 3);
    c = (await s.getCard())!;
    eq('collapsed: second', c.prepared.card.id, b);
    await s.answer(c, 1);
    c = (await s.getCard())!;
    check('collapsed: not the same card again', !!c && c.prepared.card.id !== b, c?.prepared.card.id);
  }

  // test_learn_day (first half)
  {
    const { col, mid } = await emptyCol();
    await addBasic(col, mid, 'one');
    await addBasic(col, mid, 'two');
    await setConf(col, 1, { learnSteps: [1, 10, 1440, 2880] });
    const s = new Sched(col);
    const c = (await s.getCard())!;
    const card = await s.answer(c, 3);
    eq('learn_day: 3 left', card.left % 1000, 3);
    eq('learn_day: counts', await s.counts(), [1, 1, 0]);
    eq('learn_day: next is 1 day', await s.nextIvl(card.id, 3), 86400);
  }

  // test_reviews
  {
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    const t = await col.timing();
    const setup = () => raw.exec('UPDATE cards SET type = 2, queue = 2, due = ?, factor = 2500, reps = 3, lapses = 1, ivl = 100 WHERE id = ?', [t.today - 8, cid]);
    const answerOnce = async (r: Rating) => {
      setup();
      const s = (await col.studyCard(cid))!;
      return (await col.answer(s, r, 1000)).card;
    };
    let card = await answerOnce(2);
    eq('reviews hard', [card.queue, card.ivl, card.due - t.today, card.factor, card.lapses, card.reps], [CardQueue.Review, 120, 120, 2350, 1, 4]);
    card = await answerOnce(3);
    eq('reviews good', [card.ivl, card.factor], [260, 2500]);
    card = await answerOnce(4);
    eq('reviews easy', [card.ivl, card.factor], [351, 2650]);
    await setConf(col, 1, { leechAction: 'suspend' });
    raw.exec('UPDATE cards SET type = 2, queue = 2, due = ?, factor = 2500, reps = 3, lapses = 7, ivl = 100 WHERE id = ?', [t.today - 8, cid]);
    card = (await col.answer((await col.studyCard(cid))!, 1, 1000)).card;
    eq('reviews leech suspended', card.queue, CardQueue.Suspended);
    const note = await col.note(card.nid);
    check('reviews leech tag', / leech /.test(note!.tags), note?.tags);
  }

  // test_review_limits
  {
    const { col, mid, raw } = await emptyCol();
    const parent = await col.getOrCreateDeck('parent');
    const child = await col.getOrCreateDeck('parent::child');
    const pconf = await col.addDeckConfig('parentConf', { ...defaultDeckConfig(), reviewsPerDay: 5 });
    const cconf = await col.addDeckConfig('childConf', { ...defaultDeckConfig(), reviewsPerDay: 10 });
    await col.updateDeck(parent, { conf_id: pconf });
    await col.updateDeck(child, { conf_id: cconf });
    for (let i = 0; i < 20; i++) {
      const cid = await addBasic(col, mid, 'one', child);
      raw.exec('UPDATE cards SET queue = 2, type = 2, due = 0, ivl = 1, factor = 2500 WHERE id = ?', [cid]);
    }
    let tree = await col.deckTree();
    const p = tree.find((n) => n.deckId === parent)!;
    eq('review_limits: parent 5', p.reviewCount, 5);
    eq('review_limits: child 10', p.children[0].reviewCount, 10);
    const s = new Sched(col, child);
    await s.reset();
    eq('review_limits: counts', await s.counts(), [0, 0, 10]);
    await s.answer((await s.getCard())!, 3);
    eq('review_limits: counts after', await s.counts(), [0, 0, 9]);
    tree = await col.deckTree();
    const p2 = tree.find((n) => n.deckId === parent)!;
    eq('review_limits: parent 4', p2.reviewCount, 4);
    eq('review_limits: child 9', p2.children[0].reviewCount, 9);
  }

  // test_button_spacing
  {
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    const t = await col.timing();
    raw.exec('UPDATE cards SET type = 2, queue = 2, due = ?, reps = 1, ivl = 1, factor = 2500 WHERE id = ?', [t.today, cid]);
    const s = new Sched(col);
    eq('button spacing', [await s.nextIvl(cid, 2), await s.nextIvl(cid, 3), await s.nextIvl(cid, 4)], [2, 3, 4].map((d) => d * 86400));
    await setConf(col, 1, { hardMultiplier: 1 });
    eq('button spacing hard≤1', await s.nextIvl(cid, 2), 86400);
  }

  // test_nextIvl
  {
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    await setConf(col, 1, { learnSteps: [0.5, 3, 10], relearnSteps: [1, 5, 9] });
    const s = new Sched(col);
    const ivls = async () => [await s.nextIvl(cid, 1), await s.nextIvl(cid, 2), await s.nextIvl(cid, 3), await s.nextIvl(cid, 4)];
    eq('nextIvl new', await ivls(), [30, 105, 180, 4 * 86400]);
    await s.answer((await s.getCard())!, 1);
    eq('nextIvl learning', await ivls(), [30, 105, 180, 4 * 86400]);
    await s.answer((await col.studyCard(cid, s.now))!, 3);
    eq('nextIvl learning 2', await ivls(), [30, 180, 600, 4 * 86400]);
    await s.answer((await col.studyCard(cid, s.now))!, 3);
    eq('nextIvl graduation', [await s.nextIvl(cid, 3), await s.nextIvl(cid, 4)], [86400, 4 * 86400]);
    raw.exec('UPDATE cards SET type = 3, ivl = 100, factor = 2500 WHERE id = ?', [cid]);
    eq('nextIvl relearn', [await s.nextIvl(cid, 1), await s.nextIvl(cid, 3), await s.nextIvl(cid, 4)], [60, 100 * 86400, 101 * 86400]);
    const t = await col.timing();
    raw.exec('UPDATE cards SET type = 2, queue = 2, ivl = 100, factor = 2500, due = ? WHERE id = ?', [t.today, cid]);
    eq('nextIvl review again', await s.nextIvl(cid, 1), 60);
    await setConf(col, 1, { relearnSteps: [] });
    eq('nextIvl review', await ivls(), [86400, 10368000, 21600000, 28080000]);
  }

  // test_bury + test_suspend
  {
    const { col, mid, raw } = await emptyCol();
    const a = await addBasic(col, mid, 'one');
    const b = await addBasic(col, mid, 'two');
    await col.buryOrSuspend([a], 'buryUser');
    await col.buryOrSuspend([b], 'burySched');
    const q = (id: number) => raw.exec('SELECT queue FROM cards WHERE id = ?', [id])[0].queue;
    eq('bury queues', [q(a), q(b)], [-3, -2]);
    const s = new Sched(col);
    check('bury: nothing to study', !(await s.getCard()));
    await col.unburyDeck(DEFAULT_DECK_ID);
    await s.reset();
    eq('bury: unburied counts', await s.counts(), [2, 0, 0]);
    await col.buryOrSuspend([a], 'suspend');
    await s.reset();
    eq('suspend: counts', await s.counts(), [1, 0, 0]);
    await col.unburyOrUnsuspend([a]);
    await s.reset();
    eq('unsuspend: counts', await s.counts(), [2, 0, 0]);
    // suspend/unsuspend keeps a relearning card's state
    const t = await col.timing();
    raw.exec('UPDATE cards SET due = ?, ivl = 100, type = 2, queue = 2, factor = 2500 WHERE id = ?', [t.today, a]);
    await s.reset();
    const card = (await col.answer((await col.studyCard(a))!, 1, 1000)).card;
    await col.buryOrSuspend([a], 'suspend');
    await col.unburyOrUnsuspend([a]);
    eq('suspend keeps relearning', raw.exec('SELECT queue, type, due FROM cards WHERE id = ?', [a])[0], { queue: 1, type: 3, due: card.due });
  }

  // sibling burying, undo
  {
    const { col, raw } = await emptyCol();
    const mid2 = await col.addNotetype({
      name: 'Basic (and reversed)',
      kind: 0,
      fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
      templates: [
        { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' },
        { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{Front}}' },
      ],
      css: '',
      sortIdx: 0,
    });
    await setConf(col, 1, { buryNew: true });
    const { cardIds } = await col.addNote(mid2, ['a', 'b'], [], DEFAULT_DECK_ID);
    eq('reversed: two cards', cardIds.length, 2);
    const s = new Sched(col);
    eq('bury siblings: only one gathered', await s.counts(), [1, 0, 0]);
    const first = (await s.getCard())!;
    const res = await col.answer(first, 3, 1000);
    eq('sibling buried', raw.exec('SELECT queue FROM cards WHERE id = ?', [cardIds[1]])[0].queue, -2);
    eq('deck stats new_studied', (await col.deck(DEFAULT_DECK_ID))!.new_studied, 1);
    await col.undoAnswer(res.undo);
    eq('undo: card new again', raw.exec('SELECT queue, type, reps FROM cards WHERE id = ?', [cardIds[0]])[0], { queue: 0, type: 0, reps: 0 });
    eq('undo: sibling unburied', raw.exec('SELECT queue FROM cards WHERE id = ?', [cardIds[1]])[0].queue, 0);
    eq('undo: revlog removed', raw.exec('SELECT COUNT(*) AS n FROM revlog')[0].n, 0);
    eq('undo: stats restored', (await col.deck(DEFAULT_DECK_ID))!.new_studied, 0);
  }

  // forget + set due date
  {
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    const t = await col.timing();
    raw.exec('UPDATE cards SET type = 2, queue = 2, due = ?, ivl = 10, factor = 2500, reps = 5, lapses = 2 WHERE id = ?', [t.today, cid]);
    await col.forget([cid], { resetCounts: true, restorePosition: false });
    eq('forget', raw.exec('SELECT type, queue, ivl, reps, lapses FROM cards WHERE id = ?', [cid])[0], { type: 0, queue: 0, ivl: 0, reps: 0, lapses: 0 });
    await col.setDueDate([cid], '3');
    const r = raw.exec('SELECT type, queue, due FROM cards WHERE id = ?', [cid])[0];
    eq('set due date', [r.type, r.queue, (r.due as number) - t.today], [2, 2, 3]);
    eq('manual revlogs', raw.exec('SELECT COUNT(*) AS n FROM revlog WHERE type = 4')[0].n, 2);
  }

  // FSRS: a new card's buttons follow the FSRS learning flow; graduating uses FSRS intervals
  {
    const { col, mid } = await emptyCol(true);
    const cid = await addBasic(col, mid, 'one');
    const s = new Sched(col);
    eq('fsrs new: again 1m / good 10m', [await s.nextIvl(cid, 1), await s.nextIvl(cid, 3)], [60, 600]);
    const easy = await s.nextIvl(cid, 4);
    eq('fsrs new: easy = round(S_easy)=8d', easy, 8 * 86400);
    const card = await s.answer((await s.getCard())!, 3);
    check('fsrs: memory state stored', card.stability != null && card.difficulty != null, card);
  }

  // ---- Answer = plan (in memory) + commit (batched write) ---------------------------------------
  {
    const { col, raw, mid } = await emptyCol();
    const parent = await col.getOrCreateDeck('Lang');
    const child = await col.getOrCreateDeck('Lang::Vocab');
    const twoCards = await col.addNotetype({
      name: 'Two', kind: 0, css: '', sortIdx: 0, fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
      templates: [{ name: 'A', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }, { name: 'B', ord: 1, qfmt: '{{Back}}', afmt: '{{Front}}' }],
    });
    const presetId = (await col.deck(child))!.conf_id;
    await setConf(col, presetId, { buryNew: true, leechThreshold: 2, leechAction: 'tagOnly' });
    const { cardIds: [a, b] } = await col.addNote(twoCards, ['front', 'back'], [], child);
    const { cardIds: [c1] } = await col.addNote(mid, ['solo', 'x'], [], child);
    const now = Date.UTC(2026, 4, 1, 12);
    const count = (q: string) => raw.exec(q)[0].n as number;

    const sa = (await col.studyCard(a, now))!;
    const before = count('SELECT COUNT(*) AS n FROM revlog');
    const plan = col.planAnswer(sa, 3, 1000, now);
    eq('plan: no database writes', count('SELECT COUNT(*) AS n FROM revlog'), before);
    eq('plan: sibling to bury', plan.bury.map((x) => x.id), [b]);
    await col.commitAnswer(plan);
    eq('commit: sibling buried', (await col.card(b))!.queue, -2);
    const today = (await col.timing(now)).today;
    eq('commit: child deck counts the new card', raw.exec('SELECT new_studied AS n, last_day_studied AS d FROM decks WHERE id = ?', [child])[0], { n: 1, d: today });
    eq('commit: parent deck counts it too', raw.exec('SELECT new_studied AS n FROM decks WHERE id = ?', [parent])[0].n, 1);
    eq('commit: unrelated Default deck untouched', raw.exec('SELECT new_studied AS n FROM decks WHERE id = 1')[0].n, 0);

    // Two answers in the same millisecond get distinct review log ids.
    const s1 = (await col.studyCard(c1, now))!;
    const r1 = await col.answer(s1, 3, 1000, now + 5);
    const s2 = (await col.studyCard(c1, now))!;
    const r2 = await col.answer(s2, 3, 1000, now + 5);
    check('same-millisecond answers: distinct revlog ids', r1.undo.revlogId !== r2.undo.revlogId, [r1.undo.revlogId, r2.undo.revlogId]);
    await col.undoAnswer(r2.undo);
    await col.undoAnswer(r1.undo);

    // A sibling whose queue changed since the card was loaded is not buried.
    await col.unburyOrUnsuspend([b]);
    const stale = (await col.studyCard(a, now))!;
    await col.buryOrSuspend([b], 'suspend');
    await col.commitAnswer(col.planAnswer(stale, 3, 1000, now + 10));
    eq('stale sibling (suspended meanwhile) stays suspended', (await col.card(b))!.queue, -1);

    // Leech: tag added at the threshold, removed again by undo.
    const { cardIds: [lc] } = await col.addNote(mid, ['leechy', 'x'], [], child);
    await col.forget([lc], { resetCounts: true, restorePosition: false });
    raw.exec('UPDATE cards SET type = 2, queue = 2, due = ?, ivl = 5, lapses = 1 WHERE id = ?', [today, lc]);
    const ls = (await col.studyCard(lc, now))!;
    const lr = await col.answer(ls, 1, 1000, now + 20);
    const tags = () => raw.exec('SELECT tags FROM notes WHERE id = (SELECT nid FROM cards WHERE id = ?)', [lc])[0].tags as string;
    check('leech tagged at the threshold', /\bleech\b/.test(tags()), tags());
    await col.undoAnswer(lr.undo);
    check('undo removes the leech tag', !/\bleech\b/.test(tags()), tags());
  }

  // ---- Undo for card actions -------------------------------------------------------------
  {
    const { col, mid } = await emptyCol();
    const a = await addBasic(col, mid, 'undo-a');
    const before = await col.card(a);
    const snap1 = await col.snapshot([a]);
    await col.buryOrSuspend([a], 'buryUser');
    eq('bury applied', (await col.card(a))!.queue, CardQueue.UserBuried);
    await col.restoreSnapshot(snap1);
    eq('undo bury restores the card exactly', await col.card(a), before);

    const snap2 = await col.snapshot([a]);
    await col.setDueDate([a], '5!');
    const revAfterSet = (await col.cardInfo(a))!.revlog.length;
    await col.restoreSnapshot(snap2);
    eq('undo set due date restores the card', await col.card(a), before);
    eq('…and removes its review-log entry', [revAfterSet > 0, (await col.cardInfo(a))!.revlog.length], [true, 0]);

    const note = (await col.note((await col.card(a))!.nid))!;
    const snap3 = await col.snapshot([a], [note.id]);
    await col.removeNotes([note.id]);
    eq('delete applied', await col.card(a), null);
    await col.restoreSnapshot(snap3);
    eq('undo delete brings back the card', await col.card(a), before);
    eq('…and the note', await col.note(note.id), note);

    eq('mark', await col.toggleMark(note.id), true);
    check('marked tag added', /\bmarked\b/.test((await col.note(note.id))!.tags));
    eq('unmark', await col.toggleMark(note.id), false);
  }

  // ---- Note type management ----------------------------------------------------------------
  {
    eq('rename refs', renameFieldRefs('{{Front}} {{#Front}}x{{/Front}} {{text:Front}} {{Fronts}} {{^Front}}', 'Front', 'Word'), '{{Word}} {{#Word}}x{{/Word}} {{text:Word}} {{Fronts}} {{^Word}}');
    const { col, sql } = await emptyCol();
    const mid = await col.addNotetype({
      name: 'Three',
      kind: 0,
      fields: [{ name: 'A', ord: 0 }, { name: 'B', ord: 1 }, { name: 'C', ord: 2 }],
      templates: [
        { name: 'Fwd', ord: 0, qfmt: '{{A}}', afmt: '{{B}}' },
        { name: 'Rev', ord: 1, qfmt: '{{B}}', afmt: '{{A}}' },
      ],
      css: '',
      sortIdx: 0,
    });
    const n1 = await col.addNote(mid, ['a1', 'b1', 'c1'], [], DEFAULT_DECK_ID);
    const n2 = await col.addNote(mid, ['a2', '', 'c2'], [], DEFAULT_DECK_ID);
    eq('cards before', [n1.cardIds.length, n2.cardIds.length], [2, 1]);
    const flds = async (nid: number) => splitFields((await col.note(nid))!.flds);

    // Rename A → Word, swap B/C order, drop nothing, add D; sort by C.
    await col.changeNotetypeFields(mid, [{ name: 'Word', from: 0 }, { name: 'C', from: 2 }, { name: 'B', from: 1 }, { name: 'D', from: null }], 1);
    eq('fields rewritten', await flds(n1.noteId), ['a1', 'c1', 'b1', '']);
    let nt = (await col.notetype(mid))!;
    eq('field names', nt.fields.map((f) => f.name), ['Word', 'C', 'B', 'D']);
    eq('templates follow the rename', nt.templates.map((t) => [t.qfmt, t.afmt]), [['{{Word}}', '{{B}}'], ['{{B}}', '{{Word}}']]);
    eq('sort field updated', (await sql.all<{ sfld: string }>('SELECT sfld FROM notes WHERE id = ?', [n1.noteId]))[0].sfld, 'c1');
    // Delete field C.
    await col.changeNotetypeFields(mid, [{ name: 'Word', from: 0 }, { name: 'B', from: 2 }, { name: 'D', from: 3 }], 0);
    eq('field deleted', await flds(n1.noteId), ['a1', 'b1', '']);
    let failed = '';
    try {
      await col.changeNotetypeFields(mid, [{ name: 'X', from: 0 }, { name: 'x', from: 1 }], 0);
    } catch (e) {
      failed = (e as Error).message;
    }
    check('duplicate field names refused', /different/.test(failed), failed);

    // Card types: swap order, add a third (front = D), then remove Rev.
    nt = (await col.notetype(mid))!;
    const [fwd, rev] = nt.templates;
    await col.changeNotetypeTemplates(mid, [{ ...rev, from: 1 }, { ...fwd, from: 0 }, { name: 'Extra', qfmt: '{{D}}', afmt: 'x', from: null }], '.card{}');
    const ords = async (nid: number) => (await sql.all<{ ord: number }>('SELECT ord FROM cards WHERE nid = ? ORDER BY ord', [nid])).map((r) => r.ord);
    eq('cards follow reordered card types', await ords(n1.noteId), [0, 1]);
    eq('the one-card note keeps its Fwd card (now ord 1)', await ords(n2.noteId), [1]);
    eq('no Extra cards for empty D', (await col.cardIdsOfNote(n1.noteId)).length, 2);
    await col.updateNote(n1.noteId, ['a1', 'b1', 'd1']);
    eq('Extra card generated when D is filled', await ords(n1.noteId), [0, 1, 2]);
    nt = (await col.notetype(mid))!;
    await col.changeNotetypeTemplates(mid, [{ ...nt.templates[1], from: 1 }, { ...nt.templates[2], from: 2 }], nt.css);
    eq('removing a card type deletes its cards', await ords(n1.noteId), [0, 1]);
    eq('…other notes keep their cards, renumbered', await ords(n2.noteId), [0]);
    nt = (await col.notetype(mid))!;
    eq('card types now', nt.templates.map((t) => [t.name, t.ord]), [['Fwd', 0], ['Extra', 1]]);
    eq('css saved', nt.css, '.card{}');
    // A new card type gets cards for existing notes.
    await col.changeNotetypeTemplates(mid, [{ ...nt.templates[0], from: 0 }, { ...nt.templates[1], from: 1 }, { name: 'Back', qfmt: '{{B}}', afmt: '{{Word}}', from: null }], nt.css);
    eq('new card type generates cards', await ords(n1.noteId), [0, 1, 2]);
    nt = (await col.notetype(mid))!;
    await col.changeNotetypeTemplates(mid, [{ ...nt.templates[1], from: 1 }, { ...nt.templates[2], from: 2 }], nt.css);
    eq('a note left without cards is removed', await col.note(n2.noteId), null);
    eq('…and the others keep theirs', await ords(n1.noteId), [0, 1]);

    // Duplicates.
    const d1 = await col.addNote(mid, ['<b>ne</b>ko', 'x', ''], [], DEFAULT_DECK_ID);
    eq('duplicate found ignoring HTML', await col.findDuplicates(mid, 'neko'), [d1.noteId]);
    eq('…not itself', await col.findDuplicates(mid, 'neko', d1.noteId), []);
    eq('…only its note type', await col.findDuplicates(mid + 999, 'neko'), []);

    const counts = await col.notetypeUseCounts();
    eq('use counts', counts.get(mid), 2);
    await col.renameNotetype(mid, 'Renamed');
    eq('renamed', (await col.notetype(mid))!.name, 'Renamed');
    await col.removeNotetype(mid);
    eq('removed with its notes', [await col.notetype(mid), await col.note(n1.noteId)], [null, null]);
  }

  // ---- Filtered decks (test_schedv3.py: test_suspend, test_filt_*, test_preview, test_negativeDueFilter) ----
  /** `col.decks.new_filtered()`: two empty searches (100 random, then 20 by due), rescheduling. */
  const cram = (patch: Partial<FilteredDeckConfig> = {}): FilteredDeckConfig => ({
    ...defaultFilteredConfig(),
    terms: [{ search: '', limit: 100, order: 'random' }, { search: '', limit: 20, order: 'due' }],
    ...patch,
  });
  {
    // test_suspend (cram part): suspending a card in a filtered deck keeps it there.
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    raw.exec(`UPDATE cards SET due = 1, ivl = 100, type = 2, queue = 2 WHERE id = ${cid}`);
    const { id: did } = await col.addFilteredDeck('tmp', cram());
    let c = (await col.card(cid))!;
    eq('cram: moved in', [c.due !== 1, c.did === did, c.odid, c.odue], [true, true, DEFAULT_DECK_ID, 1]);
    await col.buryOrSuspend([cid], 'suspend');
    c = (await col.card(cid))!;
    eq('cram: suspended card stays in the filtered deck', [c.due !== 1, c.did === did, c.odue], [true, true, 1]);
  }
  {
    // test_filt_reviewing_early_normal
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    const today = (await col.timing()).today;
    raw.exec(`UPDATE cards SET ivl = 100, queue = 2, type = 2, due = ${today + 25}, factor = 2500 WHERE id = ${cid}`);
    const home = new Sched(col);
    eq('early: nothing due at home', await home.counts(), [0, 0, 0]);
    const { id: did } = await col.addFilteredDeck('Cram', cram());
    const tree = await col.deckTree();
    eq('early: filtered deck shows the review in the deck list', tree.find((n) => n.deckId === did)?.reviewCount, 1);
    const s = new Sched(col, did);
    eq('early: counts', await s.counts(), [0, 0, 1]);
    let c = (await s.getCard())!;
    eq('early: next intervals', [await s.nextIvl(cid, 1), await s.nextIvl(cid, 2), await s.nextIvl(cid, 3), await s.nextIvl(cid, 4)],
      [600, Math.round(75 * 1.2) * 86400, Math.round(75 * 2.5) * 86400, Math.round(75 * 2.5 * 1.15) * 86400]);
    const after = await s.answer(c, 3);
    eq('early: due = today + ivl, back in review, back home', [after.due === today + after.ivl, after.queue, after.did, after.odid, after.odue], [true, CardQueue.Review, DEFAULT_DECK_ID, 0, 0]);
    eq('early: logged as a filtered (cram) review', raw.exec('SELECT type FROM revlog ORDER BY id DESC LIMIT 1')[0].type, 3);
    raw.exec(`UPDATE cards SET ivl = 100, due = ${today + 75} WHERE id = ${cid}`);
    await col.rebuildFilteredDeck(did);
    const s2 = new Sched(col, did);
    c = (await s2.getCard())!;
    eq('early (25 days waited): intervals', [await s2.nextIvl(cid, 2), await s2.nextIvl(cid, 3), await s2.nextIvl(cid, 4)],
      [(100 * 1.2) / 2 * 86400, 100 * 86400, Math.round(100 * (1.3 - (1.3 - 1) / 2)) * 86400]);
  }
  {
    // test_filt_keep_lrn_state
    const { col, mid } = await emptyCol();
    await setConf(col, 1, { learnSteps: [1, 10, 61] });
    const cid = await addBasic(col, mid, 'one');
    const home = new Sched(col);
    let c = await home.answer((await home.getCard())!, 1);
    eq('keep lrn: learning after Again', [c.type, c.queue, c.left % 1000], [CardType.Learn, CardQueue.Learn, 3]);
    c = await home.answer((await col.studyCard(cid))!, 3);
    eq('keep lrn: still learning', [c.type, c.queue], [CardType.Learn, CardQueue.Learn]);
    const { id: did } = await col.addFilteredDeck('Cram', cram());
    c = (await col.card(cid))!;
    eq('keep lrn: learning state kept in the filtered deck', [c.type, c.queue, c.left % 1000], [CardType.Learn, CardQueue.Learn, 2]);
    const s = new Sched(col, did);
    c = await s.answer((await col.studyCard(cid))!, 3);
    check('keep lrn: next step due over an hour away', c.due - Math.floor(Date.now() / 1000) > 3600, c.due);
    eq('keep lrn: still in the filtered deck', c.did, did);
    await col.emptyFilteredDeck(did);
    c = (await col.card(cid))!;
    eq('keep lrn: emptying keeps the learning state', [c.type, c.queue, c.left % 1000, c.did], [CardType.Learn, CardQueue.Learn, 1, DEFAULT_DECK_ID]);
    check('keep lrn: …and the due time', c.due - Math.floor(Date.now() / 1000) > 3600, c.due);
  }
  {
    // test_preview
    const { col, mid } = await emptyCol();
    const c1 = await addBasic(col, mid, 'one');
    const c2id = await addBasic(col, mid, 'two');
    const { id: did } = await col.addFilteredDeck('Cram', cram({ reschedule: false }));
    const s = new Sched(col, did);
    const c = (await s.getCard())!;
    eq('preview: Again = 60s, Easy = return', [await s.nextIvl(c.prepared.card.id, 1), await s.nextIvl(c.prepared.card.id, 4)], [60, 0]);
    const due = c.prepared.card.due;
    const failed = await s.answer(c, 1);
    check('preview: failing pushes its due time back', failed.due !== due, failed.due);
    eq('preview: failed card waits in the preview queue', failed.queue, CardQueue.PreviewRepeat);
    const next = (await s.getCard())!;
    check('preview: the other card comes next', next.prepared.card.id !== failed.id);
    const passed = await s.answer(next, 4);
    eq('preview: passing returns it unchanged', [passed.queue, passed.reps, passed.type, passed.did], [CardQueue.New, 0, CardType.New, DEFAULT_DECK_ID]);
    await col.emptyFilteredDeck(did);
    const back = (await col.card(failed.id))!;
    eq('preview: emptying restores the card', [back.queue, back.reps, back.type, back.did], [CardQueue.New, 0, CardType.New, DEFAULT_DECK_ID]);
    void c1;
    void c2id;
  }
  {
    // test_negativeDueFilter
    const { col, mid, raw } = await emptyCol();
    const cid = await addBasic(col, mid, 'one');
    raw.exec(`UPDATE cards SET due = -5, queue = 2, ivl = 5 WHERE id = ${cid}`);
    const { id: did } = await col.addFilteredDeck('Cram', cram());
    await col.emptyFilteredDeck(did);
    eq('negative due survives a filtered deck', (await col.card(cid))!.due, -5);
  }
  {
    // Building, ordering, rebuilding, moving out, deleting; and Custom Study.
    const { col, mid, raw } = await emptyCol();
    const a = await addBasic(col, mid, 'a');
    const b = await addBasic(col, mid, 'b');
    const sus = await addBasic(col, mid, 'suspended');
    await col.buryOrSuspend([sus], 'suspend');
    const positions = [(await col.card(a))!.due, (await col.card(b))!.due];
    let failed = '';
    try {
      await col.addFilteredDeck('Nothing', cram({ terms: [{ search: 'nomatch', limit: 10, order: 'random' }] }));
    } catch (e) {
      failed = (e as Error).message;
    }
    check('no matches: refused', /No cards matched/.test(failed), failed);
    eq('…and no deck left behind', (await col.decks()).some((d) => d.name === 'Nothing'), false);
    const { id: did, count } = await col.addFilteredDeck('Filt', cram({ terms: [{ search: 'deck:Default', limit: 10, order: 'added' }] }));
    eq('built: suspended cards stay out', count, 2);
    eq('built in order', [(await col.card(a))!.due, (await col.card(b))!.due], [-100000, -99999]);
    raw.exec(`UPDATE cards SET queue = -3 WHERE id = ${b}`);
    eq('rebuild returns cards first, skips buried ones', await col.rebuildFilteredDeck(did), 1);
    eq('…buried card went home with its position', [(await col.card(b))!.did, (await col.card(b))!.due], [DEFAULT_DECK_ID, positions[1]]);
    await col.moveCards([a], DEFAULT_DECK_ID);
    eq('moving a card takes it out of the filtered deck', [(await col.card(a))!.odid, (await col.card(a))!.due], [0, positions[0]]);
    failed = '';
    try {
      await col.moveCards([a], did);
    } catch (e) {
      failed = (e as Error).message;
    }
    check('can’t move cards into a filtered deck', /filtered deck/.test(failed), failed);
    await col.rebuildFilteredDeck(did);
    await col.removeDeck(did);
    eq('deleting a filtered deck returns its cards', [(await col.card(a))!.did, (await col.card(a))!.odid], [DEFAULT_DECK_ID, 0]);

    // Custom study: extra new cards today.
    raw.exec(`UPDATE cards SET queue = 0 WHERE id = ${b}`);
    await setConf(col, 1, { newPerDay: 1 });
    const s = new Sched(col);
    eq('limit 1 new', (await s.counts())[0], 1);
    await col.customStudy(DEFAULT_DECK_ID, { kind: 'newLimit', delta: 1 });
    const s2 = new Sched(col);
    eq('custom study: one more new card today', (await s2.counts())[0], 2);
    const info = await col.customStudyInfo(DEFAULT_DECK_ID);
    eq('custom study info', info.newAvailable, 2);
    // Custom study session: preview new cards added today.
    const sess = (await col.customStudy(DEFAULT_DECK_ID, { kind: 'preview', days: 1 }))!;
    eq('custom study session built', sess.count, 2);
    const again = (await col.customStudy(DEFAULT_DECK_ID, { kind: 'cram', cram: 'all', limit: 1, includeTags: [], excludeTags: [] }))!;
    eq('custom study session reused', [again.id, again.count], [sess.id, 1]);
    eq('…named as in Anki', (await col.deck(sess.id))!.name, 'Custom Study Session');
    await col.removeDeck(sess.id);

    // Renaming a deck inside itself is refused, as in Anki (it would vanish from the tree).
    const selfParent = await col.getOrCreateDeck('Loop');
    let renameErr = '';
    try {
      await col.renameDeck(selfParent, 'Loop::Inner');
    } catch (e) {
      renameErr = (e as Error).message;
    }
    eq('can’t rename a deck inside itself', [/inside itself/.test(renameErr), (await col.deck(selfParent))!.name], [true, 'Loop']);
    await col.removeDeck(selfParent);

    // Reviewing mined words: a session deck with exactly those cards, removed afterwards.
    const mined = await col.cardSession('Mined Session', [b]);
    eq('mined session holds exactly the mined card', [mined.count, (await col.card(b))!.did, (await col.card(a))!.did], [1, mined.id, DEFAULT_DECK_ID]);
    eq('…and reschedules (answers count)', (await col.deck(mined.id))!.filtered?.reschedule, true);
    await col.removeDeck(mined.id);
    eq('…removing it sends the card home', [(await col.card(b))!.did, (await col.card(b))!.odid, await col.deck(mined.id)], [DEFAULT_DECK_ID, 0, null]);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed, ${passes} passed.`);
    process.exit(1);
  }
  console.log(`All ${passes} collection scenario checks passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
