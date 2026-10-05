/**
 * Checks for Anki's search syntax (src/anki/search.ts) against a real SQLite collection, plus the
 * browser's bulk tag edits and card info.
 *
 *   npm run verify:search
 */
import { Collection } from '../src/anki/collection';
import { compileSearch, parseSearch, SearchError, toLike } from '../src/anki/search';
import { openTestDb } from './sqliteNode';

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

const { sql, raw } = await openTestDb();
const col = new Collection(sql);
const DAY_MS = 86_400_000;
const now = Date.now();

const jp = await col.getOrCreateDeck('Japanese');
const vocab = await col.getOrCreateDeck('Japanese::Vocab');
const kanji = await col.getOrCreateDeck('Japanese::Kanji');
const other = await col.getOrCreateDeck('Other deck');
const basic = await col.addNotetype({
  name: 'Basic',
  kind: 0,
  fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
  templates: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
  css: '',
  sortIdx: 0,
});
const reverse = await col.addNotetype({
  name: 'Basic (and reversed card)',
  kind: 0,
  fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
  templates: [
    { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' },
    { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{Front}}' },
  ],
  css: '',
  sortIdx: 0,
});
const word = await col.addNotetype({
  name: 'Japanese word',
  kind: 0,
  fields: [{ name: 'Word', ord: 0 }, { name: 'Reading', ord: 1 }, { name: 'Meaning', ord: 2 }],
  templates: [{ name: 'Recognition', ord: 0, qfmt: '{{Word}}', afmt: '{{Meaning}}' }],
  css: '',
  sortIdx: 0,
});

const notes: Record<string, number> = {};
const cards: Record<string, number[]> = {};
async function add(key: string, mid: number, fields: string[], tags: string[], deck: number) {
  const r = await col.addNote(mid, fields, tags, deck);
  notes[key] = r.noteId;
  cards[key] = r.cardIds;
}
await add('dog', basic, ['dog', 'いぬ'], ['animals', 'jlpt::n5'], vocab);
await add('cat', basic, ['cat', 'ねこ <b>猫</b>'], ['animals::pets'], vocab);
await add('hot', reverse, ['hot dog', '<i>ホットドッグ</i>'], ['food'], other);
await add('water', word, ['水', 'みず', 'water'], ['jlpt::n5', 'Kanji'], kanji);
await add('pct', basic, ['100% sure', 'a_b'], [], jp);
await add('fire', word, ['火', 'ひ', 'fire'], ['leech'], kanji);

// Shape the cards' scheduling state.
const today = (await col.timing(now)).today;
const set = (cid: number, cols: string) => raw.exec(`UPDATE cards SET ${cols} WHERE id = ${cid}`);
set(cards.dog[0], `type = 2, queue = 2, due = ${today}, ivl = 30, factor = 2500, reps = 8, lapses = 1, stability = 40.5, difficulty = 5.5, last_review = ${Math.floor(now / 1000) - 86400 * 30}`);
set(cards.cat[0], `type = 2, queue = 2, due = ${today + 5}, ivl = 3, factor = 1300, reps = 4, lapses = 3, flags = 1`);
set(cards.hot[0], `type = 1, queue = 1, due = ${Math.floor(now / 1000) + 60}, reps = 1`);
set(cards.hot[1], `queue = -1`);
set(cards.water[0], `type = 2, queue = -3, due = ${today - 1}, ivl = 10, factor = 2000, reps = 5`);
set(cards.fire[0], `queue = -2, flags = 3`);
// Reviews: dog answered today (Good), cat 3 days ago (Again).
raw.exec(`INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (${now - 1000}, ${cards.dog[0]}, 3, 30, 10, 2500, 5000, 1)`);
raw.exec(`INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (${now - 3 * DAY_MS}, ${cards.cat[0]}, 1, -600, 3, 1300, 9000, 1)`);
raw.exec(`INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (${now - 10 * DAY_MS}, ${cards.dog[0]}, 0, 5, 3, 2500, 0, 4)`);
// "cat" was created 20 days ago, its note edited then too.
raw.exec(`UPDATE notes SET mod = ${Math.floor(now / 1000) - 20 * 86400} WHERE id = ${notes.cat}`);
const oldId = now - 20 * DAY_MS;
raw.exec(`UPDATE cards SET id = ${oldId} WHERE id = ${cards.cat[0]}`);
raw.exec(`UPDATE revlog SET cid = ${oldId} WHERE cid = ${cards.cat[0]}`);
cards.cat = [oldId];

const keyOf = new Map<number, string>();
for (const [k, ids] of Object.entries(cards)) ids.forEach((id, i) => keyOf.set(id, ids.length > 1 ? `${k}${i + 1}` : k));
async function found(q: string): Promise<string[]> {
  const ids = await col.searchCards(q, {}, now);
  return ids.map((id) => keyOf.get(id) ?? String(id)).sort();
}
async function expect(q: string, expected: string[]) {
  try {
    eq(`search ${q}`, await found(q), [...expected].sort());
  } catch (e) {
    check(`search ${q}`, false, e instanceof Error ? e.message : e);
  }
}
async function rejects(q: string, match: RegExp) {
  try {
    await col.searchCards(q, {}, now);
    check(`rejects ${q}`, false, 'no error');
  } catch (e) {
    check(`rejects ${q}`, e instanceof SearchError && match.test(e.message), e instanceof Error ? e.message : e);
  }
}
const ALL = ['dog', 'cat', 'hot1', 'hot2', 'water', 'pct', 'fire'];

// ---- text --------------------------------------------------------------------------------------
await expect('', ALL);
await expect('dog', ['dog', 'hot1', 'hot2']);
await expect('DOG', ['dog', 'hot1', 'hot2']);
await expect('"hot dog"', ['hot1', 'hot2']);
await expect('hot dog', ['hot1', 'hot2']);
await expect('d*g', ['dog', 'hot1', 'hot2']);
await expect('d_g', ['dog', 'hot1', 'hot2']);
await expect('猫', ['cat']);
await expect('dog or 猫', ['dog', 'hot1', 'hot2', 'cat']);
await expect('dog OR 猫', ['dog', 'hot1', 'hot2', 'cat']);
await expect('dog -hot', ['dog']);
await expect('-dog', ['cat', 'water', 'pct', 'fire']);
await expect('(dog or cat) -hot', ['dog', 'cat']);
await expect('-(dog or cat)', ['water', 'pct', 'fire']);
await expect('dog and -hot', ['dog']);
await expect('100%', ['pct']);
await expect('a\\_b', ['pct']);
await expect('a_b', ['pct']);
await expect('ホットドッグ', ['hot1', 'hot2']);

// ---- fields ------------------------------------------------------------------------------------
await expect('front:dog', ['dog']);
await expect('front:*dog*', ['dog', 'hot1', 'hot2']);
await expect('Front:DOG', ['dog']);
await expect('back:', []);
await expect('meaning:water', ['water']);
await expect('word:水', ['water']);
await expect('reading:み*', ['water']);
await expect('fr*:cat', ['cat']);
await expect('"back:ねこ*"', ['cat']);
await expect('front:re:^h', ['hot1', 'hot2']);
await expect('nosuchfield:x', []);
await expect('re:<b>', ['cat']);
await expect('re:(?-i)DOG', []);
await expect('re:DOG', ['dog', 'hot1', 'hot2']);

// ---- decks, notetypes, cards --------------------------------------------------------------------
await expect('deck:Japanese', ['dog', 'cat', 'water', 'pct', 'fire']);
await expect('deck:japanese::vocab', ['dog', 'cat']);
await expect('deck:Japanese -deck:Japanese::Kanji', ['dog', 'cat', 'pct']);
await expect('"deck:Other deck"', ['hot1', 'hot2']);
await expect('deck:"Other deck"', ['hot1', 'hot2']);
await expect('deck:Other*', ['hot1', 'hot2']);
await expect('deck:*', ALL);
await expect('deck:nope', []);
await expect('note:Basic', ['dog', 'cat', 'pct']);
await expect('note:basic*', ['dog', 'cat', 'pct', 'hot1', 'hot2']);
await expect('"note:Japanese word"', ['water', 'fire']);
await expect('card:2', ['hot2']);
await expect('card:1 deck:Other*', ['hot1']);
await expect('card:Recognition', ['water', 'fire']);

// ---- tags ----------------------------------------------------------------------------------------
await expect('tag:animals', ['dog', 'cat']);
await expect('tag:animals::pets', ['cat']);
await expect('tag:ANIMALS::PETS', ['cat']);
await expect('tag:jlpt::*', ['dog', 'water']);
await expect('tag:jlpt', ['dog', 'water']);
await expect('tag:jl*', ['dog', 'water']);
await expect('tag:anim', []);
await expect('tag:none', ['pct']);
await expect('tag:kanji', ['water']);
await expect('-tag:leech', ['dog', 'cat', 'hot1', 'hot2', 'water', 'pct']);

// ---- states, flags, props --------------------------------------------------------------------------
await expect('is:new', ['hot2', 'pct', 'fire']);
await expect('is:review', ['dog', 'cat', 'water']);
await expect('is:learn', ['hot1']);
await expect('is:due', ['dog', 'hot1']);
await expect('is:suspended', ['hot2']);
await expect('is:buried', ['water', 'fire']);
await expect('is:buried-manually', ['water']);
await expect('is:buried-sibling', ['fire']);
await expect('flag:1', ['cat']);
await expect('flag:3', ['fire']);
await expect('flag:0', ['dog', 'hot1', 'hot2', 'water', 'pct']);
await expect('prop:ivl>=10', ['dog', 'water']);
await expect('prop:ivl=3', ['cat']);
await expect('prop:ivl!=30 is:review', ['cat', 'water']);
await expect('prop:lapses>1', ['cat']);
await expect('prop:reps<2', ['hot1', 'hot2', 'pct', 'fire']);
await expect('prop:ease<2', ['cat']);
await expect('prop:ease=2.5', ['dog']);
await expect('prop:due=5', ['cat']);
await expect('prop:due<=0', ['dog', 'hot1']);
await expect('prop:due=-1', []); // buried: not in the review queue
await expect('prop:due=-1 or is:buried', ['water', 'fire']);
await expect('prop:s>40', ['dog']);
await expect('prop:d=0.5', ['dog']);
await expect('prop:pos<=3 is:new', ['hot2']);

// ---- history ---------------------------------------------------------------------------------------
await expect('rated:1', ['dog']);
await expect('rated:5', ['dog', 'cat']);
await expect('rated:5:1', ['cat']);
await expect('rated:5:3', ['dog']);
await expect('resched:30', ['dog']);
await expect('added:1', ['dog', 'hot1', 'hot2', 'water', 'pct', 'fire']);
await expect('-added:7', ['cat']);
await expect('edited:7', ['dog', 'hot1', 'hot2', 'water', 'pct', 'fire']);
await expect('introduced:5', ['dog', 'cat']);
await expect(`nid:${notes.dog},${notes.cat}`, ['dog', 'cat']);
await expect(`cid:${cards.hot[1]}`, ['hot2']);

// ---- errors ----------------------------------------------------------------------------------------
await rejects('"open quote', /quote/);
await rejects('(dog', /closing/);
await rejects('dog)', /opening/);
await rejects('dog or', /both sides/);
await rejects('is:nonsense', /is:due/);
await rejects('prop:ivl>>3', /prop:/);
await rejects('prop:r>0.9', /isn’t supported/);
await rejects('flag:9', /flag/);
await rejects('rated:x', /number of days/);
await rejects('"re:(unclosed"', /regular expression/);
await rejects('nid:abc', /ids/);

// ---- parser odds and ends ----------------------------------------------------------------------------
eq('empty parses to nothing', parseSearch('   '), null);
eq('like escaping', toLike('50%_off\\*'), '50\\%_off*');
eq('all parameters bound', (() => {
  const ctx = { decks: [], notetypes: [], today: 0, nextDayAt: 0, nowSecs: 0, learnAheadSecs: 0 };
  const c = compileSearch('a b or c -d front:x', ctx);
  return (c.where.match(/\?/g) ?? []).length === c.params.length;
})(), true);

// ---- sorting ---------------------------------------------------------------------------------------
const order = async (sort: Parameters<typeof col.searchCards>[1]) => (await col.searchCards('is:review', sort, now)).map((id) => keyOf.get(id));
eq('sort by interval', await order({ sort: 'interval' }), ['cat', 'water', 'dog']);
eq('sort by interval, descending', await order({ sort: 'interval', desc: true }), ['dog', 'water', 'cat']);
eq('sort by ease', await order({ sort: 'ease' }), ['cat', 'water', 'dog']);
eq('sort by lapses descending', (await order({ sort: 'lapses', desc: true }))[0], 'cat');
eq('sort by due (suspended/buried last)', await order({ sort: 'due' }), ['dog', 'cat', 'water']);
eq('sort by sort field', (await col.searchCards('deck:japanese::vocab', { sort: 'sortField' }, now)).map((id) => keyOf.get(id)), ['cat', 'dog']);
eq('limit', (await col.searchCards('', { limit: 2 }, now)).length, 2);

// ---- bulk tags -------------------------------------------------------------------------------------
await col.addTags([notes.dog, notes.pct], ['Later', 'animals']);
eq('add tags (no duplicates, case-insensitive)', (await col.note(notes.dog))!.tags, ' animals jlpt::n5 Later ');
eq('add tags to an untagged note', (await col.note(notes.pct))!.tags, ' Later animals ');
await expect('tag:later', ['dog', 'pct']);
await col.removeTags([notes.dog, notes.cat, notes.pct], ['animals']);
eq('remove a tag and its children', (await col.note(notes.cat))!.tags, '');
eq('remove keeps others', (await col.note(notes.dog))!.tags, ' jlpt::n5 Later ');
eq('all tags', await col.allTags(), ['food', 'jlpt::n5', 'Kanji', 'Later', 'leech']);
eq('note ids of cards', (await col.noteIdsOfCards([...cards.hot, cards.dog[0]])).sort(), [notes.hot, notes.dog].sort());

// ---- card info -------------------------------------------------------------------------------------
await col.updateDeckConfig(1, 'Default', { ...(await col.deckConfigs())[0].config, fsrsParams: [] });
const info = (await col.cardInfo(cards.dog[0], now))!;
eq('card info: deck', info.deckName, 'Japanese::Vocab');
eq('card info: template', info.templateName, 'Card 1');
eq('card info: history, newest first', info.revlog.map((r) => r.ease), [3, 0]);
check('card info: retrievability between 0 and 1', info.retrievability != null && info.retrievability > 0.5 && info.retrievability < 1, info.retrievability);
eq('card info: no retrievability for a new card', (await col.cardInfo(cards.pct[0], now))!.retrievability, null);
eq('card info: missing card', await col.cardInfo(123), null);

console.log(failures ? `${passes} passed, ${failures} failed` : `All ${passes} search checks passed.`);
if (failures) process.exit(1);
