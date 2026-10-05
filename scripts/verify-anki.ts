/**
 * Checks the Anki scheduler port (src/anki/) against the expected values in Anki's and fsrs-rs's
 * own unit tests (rslib/src/scheduler/states/*.rs, fsrs-rs v6.6.2 src/inference.rs).
 *
 *   npm run verify:anki
 */
import { LearningSteps } from '../src/anki/steps';
import { constrainedFuzzBounds, minimumReviewFuzzInterval, withReviewFuzz } from '../src/anki/fuzz';
import { DEFAULT_PARAMETERS, memoryStateFromSm2, nextInterval, nextStates as fsrsNext, prepareParameters } from '../src/anki/fsrs';
import { defaultReview, leechThresholdMet, nextStates, type CardState, type LearnState, type StateContext } from '../src/anki/states';
import { compareDeckNames } from '../src/anki/limits';
import { fnvHash } from '../src/anki/queue';
import { timingAt } from '../src/anki/timing';
import { clozeNumbersInString, compareAnswer, extractClozeForTyping, fieldIsEmpty, furiganaFilter, kanaFilter, kanjiFilter, renderCard, revealClozeText, stripHtml } from '../src/anki/template';
import type { Notetype } from '../src/anki/notetype';

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ ${name}`, detail ?? '');
  }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const near = (name: string, actual: number, expected: number, tol = 1e-3) =>
  check(name, Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), { actual, expected });

// ---- steps.rs ----------------------------------------------------------------------------
{
  const DAY = 86_400;
  const t = (steps: number[], remaining: number, again: number | null, hard: number | null, good: number | null) => {
    const s = new LearningSteps(steps);
    eq(`steps ${steps} r=${remaining} again`, s.againDelaySecsLearn(), again);
    eq(`steps ${steps} r=${remaining} hard`, s.hardDelaySecs(remaining), hard);
    eq(`steps ${steps} r=${remaining} good`, s.goodDelaySecs(remaining), good);
  };
  t([10], 1, 600, 900, null);
  t([(3 * DAY) / 60], 1, 3 * DAY, 4 * DAY, null);
  t([1, 10], 2, 60, 330, 600);
  t([1, 10], 1, 60, 600, null);
  t([1, 10, 100], 3, 60, 330, 600);
  t([1, 10, 100], 2, 60, 600, 6000);
  t([1, 10, 100], 1, 60, 6000, null);
}

// ---- fuzz.rs -----------------------------------------------------------------------------
{
  eq('fuzz none 1.5', withReviewFuzz(null, 1.5, 1, 100), 2);
  eq('fuzz none 0.1', withReviewFuzz(null, 0.1, 1, 100), 1);
  eq('fuzz none 101', withReviewFuzz(null, 101, 1, 100), 100);
  const lmu = (ivl: number, min: number, max: number, lower: number, middle: number, upper: number) => {
    eq(`fuzz ${ivl} [${min},${max}] lower`, withReviewFuzz(0, ivl, min, max), lower);
    eq(`fuzz ${ivl} [${min},${max}] middle`, withReviewFuzz(0.5, ivl, min, max), middle);
    eq(`fuzz ${ivl} [${min},${max}] upper`, withReviewFuzz(0.99, ivl, min, max), upper);
  };
  lmu(1.0, 1, 1000, 1, 1, 1);
  lmu(2.49, 1, 1000, 2, 2, 2);
  lmu(2.5, 1, 1000, 2, 3, 4);
  lmu(7.0, 1, 1000, 5, 7, 9);
  lmu(17.0, 1, 1000, 14, 17, 20);
  lmu(37.0, 1, 1000, 33, 37, 41);
  lmu(2.0, 2, 1000, 2, 2, 2);
  lmu(2.0, 3, 1000, 3, 4, 4);
  lmu(2.0, 3, 3, 3, 3, 3);
  lmu(6.9, 3, 1000, 5, 7, 9);
  lmu(7.0, 3, 1000, 5, 7, 9);
  lmu(7.1, 3, 1000, 5, 7, 9);
  lmu(19.9, 3, 1000, 17, 20, 23);
  lmu(20.0, 3, 1000, 17, 20, 23);
  lmu(20.1, 3, 1000, 17, 20, 23);
  lmu(100.0, 101, 1000, 101, 105, 108);
  lmu(100.0, 1, 99, 92, 96, 99);
  lmu(100.0, 97, 103, 97, 100, 103);
  constrainedFuzzBounds(1.0, 3, 2); // must not throw
  eq('min fuzz 1', minimumReviewFuzzInterval(2.7269483, 4, 36500), 4);
  eq('min fuzz 2', minimumReviewFuzzInterval(2.7269483, 5, 36500), 0);
  eq('min fuzz 3', minimumReviewFuzzInterval(4.591988, 4, 36500), 5);
}

// ---- states: context as Anki's `defaults_for_testing` -------------------------------------
function ctxForTesting(over: Partial<StateContext> = {}): StateContext {
  return {
    fuzzFactor: null,
    fsrsNextStates: null,
    fsrsShortTermWithStepsEnabled: false,
    fsrsAllowShortTerm: false,
    steps: new LearningSteps([1, 10]),
    graduatingIntervalGood: 1,
    graduatingIntervalEasy: 4,
    initialEaseFactor: 2.5,
    hardMultiplier: 1.2,
    easyMultiplier: 1.3,
    intervalMultiplier: 1,
    maximumReviewInterval: 36500,
    leechThreshold: 8,
    relearnSteps: new LearningSteps([10]),
    lapseMultiplier: 0,
    minimumLapseInterval: 1,
    ...over,
  };
}
const learn = (remaining: number): LearnState => ({ kind: 'learning', remainingSteps: remaining, scheduledSecs: 60, elapsedSecs: 0, memory: null });
const kindOf = (s: CardState) => s.kind;

{
  const ctx = ctxForTesting();
  for (const r of [1, 2]) {
    const s = nextStates(learn(r), ctx);
    check(`learn again r=${r} resets`, s.again.kind === 'learning' && s.again.remainingSteps === 2 && s.again.scheduledSecs === 60, s.again);
    check(`learn easy r=${r} graduates`, s.easy.kind === 'review');
  }
  const noSteps = ctxForTesting({ steps: new LearningSteps([]) });
  const a = nextStates(learn(0), noSteps).again;
  check('learn again no steps → review 1d', a.kind === 'review' && a.scheduledDays === 1, a);
  const h0 = nextStates(learn(1), noSteps).hard;
  check('learn hard no steps → review 1d', h0.kind === 'review' && h0.scheduledDays === 1, h0);
  const h2 = nextStates(learn(2), ctx).hard;
  check('learn hard first step 330s', h2.kind === 'learning' && h2.remainingSteps === 2 && h2.scheduledSecs === 330, h2);
  const h1 = nextStates(learn(1), ctx).hard;
  check('learn hard last step 600s', h1.kind === 'learning' && h1.remainingSteps === 1 && h1.scheduledSecs === 600, h1);
  const g2 = nextStates(learn(2), ctx).good;
  check('learn good first → 600s', g2.kind === 'learning' && g2.remainingSteps === 1 && g2.scheduledSecs === 600, g2);
  const g1 = nextStates(learn(1), ctx).good;
  check('learn good last → review 1d', g1.kind === 'review' && g1.scheduledDays === 1, g1);
  const e1 = nextStates(learn(1), ctx).easy;
  check('learn easy > good', e1.kind === 'review' && g1.kind === 'review' && e1.scheduledDays > g1.scheduledDays, e1);
  const n = nextStates({ kind: 'new', position: 3 }, ctx);
  eq('new kinds', [kindOf(n.again), kindOf(n.hard), kindOf(n.good), kindOf(n.easy)], ['learning', 'learning', 'learning', 'review']);
}

// review.rs
{
  const cases: [number, number, boolean][] = [
    [0, 3, false], [1, 3, false], [2, 3, false], [3, 3, true], [4, 3, false], [5, 3, true], [6, 3, false], [7, 3, true],
    [7, 8, false], [8, 8, true], [9, 8, false], [10, 8, false], [11, 8, false], [12, 8, true], [13, 8, false],
    [0, 0, false], [0, 1, false], [1, 1, true], [2, 1, true], [3, 1, true],
  ];
  for (const [l, t, e] of cases) eq(`leech ${l}/${t}`, leechThresholdMet(l, t), e);

  const pass = (ctx: StateContext, scheduled: number, ease: number) => {
    const s = nextStates(defaultReview({ scheduledDays: scheduled, elapsedDays: scheduled, easeFactor: ease }), ctx);
    const d = (x: CardState) => (x.kind === 'review' ? x.scheduledDays : -1);
    return [d(s.hard), d(s.good), d(s.easy)];
  };
  const ctx = ctxForTesting({ fuzzFactor: 0 });
  eq('extreme mult 1', pass(ctx, 1, 1.3), [2, 3, 4]);
  eq('extreme mult 2', pass({ ...ctx, intervalMultiplier: 0.1 }, 1, 1.3), [2, 3, 4]);
  eq('extreme mult 3', pass({ ...ctx, intervalMultiplier: 0.1, fuzzFactor: 0.99 }, 1, 1.3), [2, 4, 6]);
  eq('extreme mult 4', pass({ ...ctx, intervalMultiplier: 10, fuzzFactor: 0.99, maximumReviewInterval: 5 }, 1, 1.3), [5, 5, 5]);
  eq('low hard mult', pass({ ...ctx, hardMultiplier: 0.1 }, 2, 1.3), [1, 3, 4]);
}

// relearning.rs
{
  const ctx = ctxForTesting();
  const relearn: CardState = {
    kind: 'relearning',
    learning: { kind: 'learning', remainingSteps: 1, scheduledSecs: 600, elapsedSecs: 0, memory: null },
    review: defaultReview({ scheduledDays: 3, elapsedDays: 3, lapses: 1 }),
  };
  const s = nextStates(relearn, ctx);
  check('relearn again stays', s.again.kind === 'relearning');
  check('relearn again lapse → 1d', s.again.kind === 'relearning' && s.again.review.scheduledDays === 1, s.again);
  const noSteps = nextStates(relearn, ctxForTesting({ relearnSteps: new LearningSteps([]) }));
  check('relearn again no steps → review', noSteps.again.kind === 'review', noSteps.again);
  check('relearn hard 900s', s.hard.kind === 'relearning' && s.hard.learning.scheduledSecs === 900, s.hard);
  check('relearn good graduates', s.good.kind === 'review', s.good);
  check('relearn easy 4d', s.easy.kind === 'review' && s.easy.scheduledDays === 4, s.easy);
}

// ---- fsrs-rs ----------------------------------------------------------------------------
{
  const w = prepareParameters([]);
  const n = fsrsNext(w, null, 0.9, 0);
  near('fsrs new again S', n.again.memory.stability, 0.212);
  near('fsrs new again D', n.again.memory.difficulty, 6.4133);
  near('fsrs new hard D', n.hard.memory.difficulty, 5.1121707);
  near('fsrs new good S', n.good.memory.stability, 2.3065);
  near('fsrs new good D', n.good.memory.difficulty, 2.118104);
  near('fsrs new easy D', n.easy.memory.difficulty, 1.0);
  near('fsrs new good ivl', n.good.interval, 2.3065);

  // test_memory_state: ratings [1,3,3,3,3,3] at intervals [0,0,1,3,8,21]
  const run = (params: number[]) => {
    const ww = prepareParameters(params);
    let m = null as ReturnType<typeof fsrsNext>['good']['memory'] | null;
    const ratings = [1, 3, 3, 3, 3, 3];
    const ivls = [0, 0, 1, 3, 8, 21];
    ratings.forEach((r, i) => {
      const st = fsrsNext(ww, m, 0.9, ivls[i]);
      m = [st.again, st.hard, st.good, st.easy][r - 1].memory;
    });
    return m!;
  };
  const m1 = run([...DEFAULT_PARAMETERS]);
  near('memory_state S', m1.stability, 53.62691, 1e-4);
  near('memory_state D', m1.difficulty, 6.3574867, 1e-4);
  const frozen = [...DEFAULT_PARAMETERS];
  frozen[17] = frozen[18] = frozen[19] = 0;
  const m2 = run(frozen);
  near('memory_state frozen S', m2.stability, 53.335106, 1e-4);

  // test_next_interval
  const ivls = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => Math.max(1, Math.round(nextInterval(w, 1, i / 10))));
  // f32 (fsrs-rs) vs f64 here: the 3-million-day extreme differs in the 7th digit.
  [3116766, 34793, 2508, 387, 90, 27, 9, 3, 1, 1].forEach((e, i) => near(`next_interval dr=${(i + 1) / 10}`, ivls[i], e, 1e-5));

  // test_memory_from_sm2
  const sm = (e: number, i: number, r: number) => memoryStateFromSm2(w, e, i, r);
  near('sm2 S 0.9', sm(2.5, 10, 0.9).stability, 10.0);
  near('sm2 D 0.9', sm(2.5, 10, 0.9).difficulty, 6.9140563);
  near('sm2 S 0.8', sm(2.5, 10, 0.8).stability, 3.01572);
  near('sm2 D 0.8', sm(2.5, 10, 0.8).difficulty, 9.393428);
  near('sm2 S 0.95', sm(2.5, 10, 0.95).stability, 24.841097);
  near('sm2 D 0.95', sm(2.5, 10, 0.95).difficulty, 1.2974405);
  near('sm2 D 1.3', sm(1.3, 20, 0.9).difficulty, 10.0);

  // test_next_states with the 19-param set
  const P19 = [0.6845422, 1.6790825, 4.7349424, 10.042885, 7.4410233, 0.64219797, 1.071918, 0.0025195254, 1.432437, 0.1544, 0.8692766, 2.0696752, 0.0953, 0.2975, 2.4691248, 0.19542035, 3.201072, 0.18046261, 0.121442534];
  const w19 = prepareParameters(P19);
  let st = fsrsNext(w19, null, 0.9, 0).again.memory;
  for (const [r, dt] of [[3, 1], [3, 3], [3, 8]] as const) st = [fsrsNext(w19, st, 0.9, dt).again, fsrsNext(w19, st, 0.9, dt).hard, fsrsNext(w19, st, 0.9, dt).good][r - 1].memory;
  const ns = fsrsNext(w19, st, 0.9, 21);
  near('next_states again S', ns.again.memory.stability, 2.9691455);
  near('next_states again D', ns.again.memory.difficulty, 8.000659);
  near('next_states hard S', ns.hard.memory.stability, 17.091452);
  near('next_states good S', ns.good.memory.stability, 31.722992);
  near('next_states good D', ns.good.memory.difficulty, 7.382128);
  near('next_states easy S', ns.easy.memory.stability, 71.7502);
  near('next_states easy D', ns.easy.memory.difficulty, 7.0728626);
}


// ---- cloze.rs ---------------------------------------------------------------------------
{
  const nums = (t: string) => [...clozeNumbersInString(t)].sort((a, b) => a - b);
  eq('cloze nums none', nums('test'), []);
  eq('cloze nums', nums('{{c2::te}}{{c1::s}}t{{'), [1, 2]);
  eq('cloze nums c0', nums('{{c0::te}}s{{c2::t}}s'), [2]);
  eq('cloze nums nested', nums('{{c2::te{{c1::s}}}}t{{'), [1, 2]);
  eq('typing none', extractClozeForTyping('{{c2::foo}}', 1), '');
  eq('typing multi', extractClozeForTyping('{{c1::foo}} {{c1::bar}} {{c1::foo}}', 1), 'foo, bar, foo');
  eq('typing same', extractClozeForTyping('{{c1::foo}} {{c1::foo}} {{c1::foo}}', 1), 'foo');
  const plain = (t: string, o: number, q: boolean) => stripHtml(revealClozeText(t, o, q));
  eq('nested 1q', plain('foo {{c1::bar {{c2::baz}}}}', 1, true), 'foo [...]');
  eq('nested 1a', plain('foo {{c1::bar {{c2::baz}}}}', 1, false), 'foo bar baz');
  eq('nested 2q hint', plain('foo {{c1::bar {{c2::baz}}::qux}}', 2, true), 'foo bar [...]');
  eq('nested 2a', plain('foo {{c1::bar {{c2::baz}}::qux}}', 2, false), 'foo bar baz');
  eq('nested 1q hint', plain('foo {{c1::bar {{c2::baz}}::qux}}', 1, true), 'foo [qux]');
  eq('nested html a', revealClozeText('foo {{c1::bar {{c2::baz}}}}', 1, false), 'foo <span class="cloze" data-ordinal="1">bar <span class="cloze-inactive" data-ordinal="2">baz</span></span>');
  eq('nested html 2q', revealClozeText('foo {{c1::bar {{c2::baz}}::qux}}', 2, true), 'foo <span class="cloze-inactive" data-ordinal="1">bar <span class="cloze" data-cloze="baz" data-ordinal="2">[...]</span></span>');
  eq('mathjax braces', stripHtml(revealClozeText('{{c1:: \\( \\frac{1}{\\sqrt{\\pi}} \\) }}', 1, true)), '[...]');
}

// ---- template.rs / template_filters.rs ----------------------------------------------------
{
  eq('field empty br', fieldIsEmpty(' <br> <div></div> '), true);
  eq('field not empty', fieldIsEmpty('x'), false);
  eq('furigana', furiganaFilter('日本語[にほんご]を 勉強[べんきょう]'), '<ruby><rb>日本語</rb><rt>にほんご</rt></ruby>を<ruby><rb>勉強</rb><rt>べんきょう</rt></ruby>');
  eq('kana', kanaFilter('日本語[にほんご]を 勉強[べんきょう]'), 'にほんごをべんきょう');
  eq('kanji', kanjiFilter('日本語[にほんご]を 勉強[べんきょう]'), '日本語を勉強');
  eq('furigana keeps sound', furiganaFilter('[sound:a.mp3]'), '[sound:a.mp3]');

  const basic: Notetype = {
    id: 1, name: 'Basic', kind: 0, css: '.card{}', sortIdx: 0,
    fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }, { name: 'Audio', ord: 2 }],
    templates: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}{{#Audio}}{{Audio}}{{/Audio}}{{^Back}}no back{{/Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}} [sound:b.mp3] {{Tags}}/{{Deck}}/{{Subdeck}}/{{Card}}/{{Type}}' }],
  };
  const r = renderCard({ notetype: basic, flds: 'front\x1fback\x1f[sound:a.mp3]', ord: 0, tags: ' t1 t2 ', deckName: 'Japanese::Kaishi', flags: 0, cardId: 5 });
  eq('render q av', r.questionAv, [{ kind: 'sound', value: 'a.mp3' }]);
  eq('render a av (only answer-side audio)', r.answerAv, [{ kind: 'sound', value: 'b.mp3' }]);
  check('render q play button', r.question.startsWith('front<a class="replay-button soundLink" href="#" data-play="q:0"'), r.question);
  check('render a has frontside q button', r.answer.includes('data-play="q:0"') && r.answer.includes('data-play="a:0"'), r.answer);
  check('render special fields', r.answer.endsWith('t1 t2/Japanese::Kaishi/Kaishi/Card 1/Basic'), r.answer);
  const blank = renderCard({ notetype: basic, flds: '\x1fback\x1f', ord: 0, tags: '', deckName: 'D', flags: 0, cardId: 1 });
  eq('render empty front', blank.isEmpty, true);
  const bad = renderCard({ notetype: { ...basic, templates: [{ ...basic.templates[0], qfmt: '{{#Front}}x' }] }, flds: 'a\x1fb\x1fc', ord: 0, tags: '', deckName: 'D', flags: 0, cardId: 1 });
  check('render template error', !!bad.error, bad);

  const cloze: Notetype = {
    id: 2, name: 'Cloze', kind: 1, css: '', sortIdx: 0,
    fields: [{ name: 'Text', ord: 0 }, { name: 'Extra', ord: 1 }],
    templates: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}{{#c2}}[two]{{/c2}}', afmt: '{{cloze:Text}}<br>{{Extra}}' }],
  };
  const c1 = renderCard({ notetype: cloze, flds: '{{c1::東京}}は{{c2::日本}}の首都\x1fextra', ord: 1, tags: '', deckName: 'D', flags: 0, cardId: 1 });
  eq('cloze q c2', stripHtml(c1.question), '東京は[...]の首都[two]');
  eq('cloze a c2', stripHtml(c1.answer), '東京は日本の首都extra');
  const c3 = renderCard({ notetype: cloze, flds: '{{c1::a}}\x1f', ord: 2, tags: '', deckName: 'D', flags: 0, cardId: 1 });
  eq('cloze missing ord empty', c3.isEmpty, true);

  eq('compare exact', compareAnswer('abc', 'abc'), '<code id=typeans><span class=typeGood>a</span><span class=typeGood>b</span><span class=typeGood>c</span></code>');
  check('compare wrong', compareAnswer('abc', 'axc').includes('typeBad') && compareAnswer('abc', 'axc').includes('typeMissed'));
}

// ---- misc --------------------------------------------------------------------------------
{
  check('deck name order', ['b', 'a::c', 'a', 'A::b'].sort(compareDeckNames).join(',') === 'a,A::b,a::c,b');
  // FNV-1a of the empty input is the offset basis.
  eq('fnv empty', fnvHash().toString(16), 'cbf29ce484222325');
  // timing: rollover at 4am
  const t1 = timingAt(new Date(2025, 9, 5, 3, 59).getTime(), 4);
  const t2 = timingAt(new Date(2025, 9, 5, 4, 0).getTime(), 4);
  eq('day rolls at 4am', t2.today - t1.today, 1);
  eq('nextDayAt before rollover', t1.nextDayAt, new Date(2025, 9, 5, 4, 0).getTime() / 1000);
  eq('nextDayAt after rollover', t2.nextDayAt, new Date(2025, 9, 6, 4, 0).getTime() / 1000);
}

if (failures) {
  console.error(`\n${failures} check(s) failed, ${passes} passed.`);
  process.exit(1);
}
console.log(`All ${passes} Anki scheduler checks passed.`);
