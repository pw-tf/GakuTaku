/**
 * Round trip for the Anki package export (src/export/apkg.ts): a collection with every kind of
 * card is exported, parsed by the importer and imported into an empty collection; scheduling,
 * memory state, history, presets, note types and media must come back the same.
 *
 *   npm run verify:export
 */
import { Collection } from '../src/anki/collection';
import { setFuzzEnabled } from '../src/anki/fuzz';
import { timingAt } from '../src/anki/timing';
import { apkgFileName, buildApkg, gatherExport, mediaReferences } from '../src/export/apkg';
import { parseApkg } from '../src/import/apkg';
import { importPackage, type MediaSink } from '../src/import/importPackage';
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

const nowMs = Date.now();
const { sql, raw } = await openTestDb();
const col = new Collection(sql);
await col.setConfig({ fsrs: true, rollover: 4 });
const presetId = await col.addDeckConfig('Japanese preset', {
  ...(await col.deckConfigs())[0].config,
  learnSteps: [1, 10, 60],
  newPerDay: 15,
  reviewsPerDay: 150,
  fsrsParams: Array.from({ length: 21 }, (_, i) => 0.1 + i / 10),
  desiredRetention: 0.88,
  leechAction: 'suspend',
  newCardGatherPriority: 'randomNotes',
  reviewOrder: 'intervalsAscending',
  buryNew: true,
});
const parent = await col.getOrCreateDeck('Japanese');
const child = await col.getOrCreateDeck('Japanese::Vocab');
await col.updateDeck(parent, { conf_id: presetId, description: 'My deck' });
await col.updateDeck(child, { conf_id: presetId, new_limit: 7 });
const other = await col.getOrCreateDeck('Other');
const mid = await col.addNotetype({
  name: 'Word', kind: 0,
  fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
  templates: [{ name: 'Recall', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }, { name: 'Reverse', ord: 1, qfmt: '{{Back}}', afmt: '{{Front}}' }],
  css: '.card { color: red; }', sortIdx: 0,
});
const t = timingAt(nowMs, 4);
const a = await col.addNote(mid, ['猫 <img src="neko.png">', 'cat [sound:neko.mp3]'], ['animals', 'jlpt::n5'], child);
const b = await col.addNote(mid, ['犬', 'dog'], [], parent);
const c = await col.addNote(mid, ['other', 'x'], [], other);
// a1: review card with FSRS memory, due in 5 days; a2: intraday learning; b1: day learning (due tomorrow);
// b2: suspended review, flagged.
raw.exec(`UPDATE cards SET type = 2, queue = 2, due = ${t.today + 5}, ivl = 12, factor = 2300, reps = 6, lapses = 1, stability = 13.5, difficulty = 6.25, desired_retention = 0.88, last_review = ${t.now - 7 * 86400} WHERE id = ${a.cardIds[0]}`);
raw.exec(`UPDATE cards SET type = 1, queue = 1, due = ${t.now + 600}, left = 2, reps = 1 WHERE id = ${a.cardIds[1]}`);
raw.exec(`UPDATE cards SET type = 1, queue = 3, due = ${t.today + 1}, left = 1, reps = 2 WHERE id = ${b.cardIds[0]}`);
raw.exec(`UPDATE cards SET type = 2, queue = -1, due = ${t.today - 3}, ivl = 40, factor = 2500, reps = 9, flags = 2 WHERE id = ${b.cardIds[1]}`);
raw.exec(`INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (${nowMs - 7 * 86400000}, ${a.cardIds[0]}, 3, 12, 4, 2300, 8000, 1), (${nowMs - 20 * 86400000}, ${a.cardIds[0]}, 1, -600, 4, 2500, 9000, 1)`);
// One card of the exported deck sits in a filtered deck: it exports from its home deck.
const filt = await col.addFilteredDeck('Cram', { terms: [{ search: `cid:${b.cardIds[0]}`, limit: 10, order: 'due' }], reschedule: true, previewAgainSecs: 60, previewHardSecs: 600, previewGoodSecs: 0 });
eq('setup: one card borrowed by a filtered deck', filt.count, 1);

const mediaFiles = new Map([['neko.png', new Blob(['png-bytes'])], ['neko.mp3', new Blob(['mp3-bytes'])]]);
eq('media references', mediaReferences('a <img src="neko.png"> [sound:neko.mp3] <img src="https://x/y.png"> <img src=\'q&amp;a.jpg\'>'), ['neko.png', 'q&a.jpg', 'neko.mp3']);

const data = await gatherExport(col, sql, parent);
eq('gather: deck subtree only', data.decks.map((d) => d.name).sort(), ['Japanese', 'Japanese::Vocab']);
eq('gather: notes', data.notes.length, 2);
eq('gather: cards (incl. the borrowed one)', data.cards.length, 4);
const out = await buildApkg(data, { scheduling: true, media: true }, async (n) => mediaFiles.get(n) ?? null, nowMs);
eq('export summary', [out.notes, out.cards, out.media], [2, 4, 2]);
eq('file name', apkgFileName('Japanese::Vocab'), 'Japanese - Vocab.apkg');

// ---- import into an empty collection ----
async function importInto(blob: Blob) {
  const db = await openTestDb();
  const col2 = new Collection(db.sql);
  await col2.setConfig({ rollover: 4 });
  const files = new Map<string, Uint8Array>();
  const sink: MediaSink = { has: async (n) => (files.has(n) ? { size: files.get(n)!.length } : null), putMany: async (fs) => fs.forEach((f) => files.set(f.name, f.data)), rename: (n) => n };
  const pkg = await parseApkg(blob);
  const summary = await importPackage(col2, db.sql, pkg, sink, { isCollection: false, nowMs });
  await pkg.close();
  return { col2, db, files, summary };
}
const { col2, db: db2, files } = await importInto(out.blob);
const card2 = async (id: number) => (await col2.card(id))!;
const t2 = timingAt(nowMs, (await col2.config()).rollover);

const ra = await card2(a.cardIds[0]);
eq('review card: state', [ra.type, ra.queue, ra.ivl, ra.factor, ra.reps, ra.lapses], [2, 2, 12, 2300, 6, 1]);
eq('review card: due in 5 days', ra.due - t2.today, 5);
eq('review card: FSRS memory', [ra.stability, ra.difficulty, ra.desired_retention, ra.last_review], [13.5, 6.25, 0.88, t.now - 7 * 86400]);
const la = await card2(a.cardIds[1]);
eq('learning card: due time and steps', [la.type, la.queue, la.due, la.left % 1000], [1, 1, t.now + 600, 2]);
const db1 = await card2(b.cardIds[0]);
eq('day-learning card came home from the filtered deck, due tomorrow', [db1.queue, db1.due - t2.today, db1.odid, (await col2.deck(db1.did))?.name], [3, 1, 0, 'Japanese']);
const sb = await card2(b.cardIds[1]);
eq('suspended, flagged review card', [sb.queue, sb.flags, sb.due - t2.today, sb.ivl], [-1, 2, -3, 40]);
eq('history', (await col2.cardInfo(a.cardIds[0]))!.revlog.map((r) => [r.ease, r.ivl]), [[3, 12], [1, -600]]);
eq('other decks not exported', await col2.card(c.cardIds[0]), null);
const n2 = (await col2.note(a.noteId))!;
eq('note fields and tags', [n2.flds, n2.tags.trim()], ['猫 <img src="neko.png">\x1fcat [sound:neko.mp3]', 'animals jlpt::n5']);
eq('media', [...files.keys()].sort(), ['neko.mp3', 'neko.png']);
eq('media content', new TextDecoder().decode(files.get('neko.png')), 'png-bytes');
const nt2 = (await col2.notetypes()).find((n) => n.name === 'Word')!;
eq('note type', [nt2.templates.map((x) => [x.name, x.qfmt]), nt2.css, nt2.fields.map((f) => f.name)], [[['Recall', '{{Front}}'], ['Reverse', '{{Back}}']], '.card { color: red; }', ['Front', 'Back']]);
const decks2 = await col2.decks();
const vocab2 = decks2.find((d) => d.name === 'Japanese::Vocab')!;
eq('deck options: per-deck limit, description', [vocab2.new_limit, decks2.find((d) => d.name === 'Japanese')!.description], [7, 'My deck']);
const preset2 = (await col2.deckConfigs()).find((p) => p.id === vocab2.conf_id)!;
eq('preset', [preset2.name, preset2.config.learnSteps, preset2.config.newPerDay, preset2.config.reviewsPerDay, preset2.config.desiredRetention, preset2.config.leechAction, preset2.config.newCardGatherPriority, preset2.config.reviewOrder, preset2.config.buryNew],
  ['Japanese preset', [1, 10, 60], 15, 150, 0.88, 'suspend', 'randomNotes', 'intervalsAscending', true]);
eq('preset FSRS parameters', preset2.config.fsrsParams.map((x) => Math.round(x * 100) / 100), Array.from({ length: 21 }, (_, i) => Math.round((0.1 + i / 10) * 100) / 100));
void db2;

// ---- without scheduling ----
const plain = await buildApkg(data, { scheduling: false, media: false }, async () => null, nowMs);
const { col2: col3, files: files3 } = await importInto(plain.blob);
const all3 = await Promise.all([...a.cardIds, ...b.cardIds].map((id) => col3.card(id)));
eq('no scheduling: all new (suspended stays suspended)', all3.map((x) => [x!.type, x!.queue]), [[0, 0], [0, 0], [0, 0], [0, -1]]);
eq('no scheduling: no history, no memory', [(await col3.cardInfo(a.cardIds[0]))!.revlog.length, all3[0]!.stability], [0, null]);
eq('no media when not asked', files3.size, 0);

console.log(failures ? `${passes} passed, ${failures} failed` : `All ${passes} export checks passed.`);
if (failures) process.exit(1);
