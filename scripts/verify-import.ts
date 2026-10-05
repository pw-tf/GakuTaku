/**
 * Imports Kaishi-style packages (both Anki package formats, see ./fixtures.ts) into a fresh
 * collection and checks nothing was lost or changed: scheduling state, due dates, review history,
 * presets (incl. FSRS parameters), note types/CSS, media, and that re-importing adds no duplicates.
 *
 *   npm run verify:import
 */
import { Collection } from '../src/anki/collection';
import { setFuzzEnabled } from '../src/anki/fuzz';
import { renderCard } from '../src/anki/template';
import { timingAt } from '../src/anki/timing';
import { parseApkg } from '../src/import/apkg';
import { importPackage, type MediaSink } from '../src/import/importPackage';
import { buildKaishiPackage, CONF_ID, FSRS_PARAMS, KAISHI_CSS, KAISHI_FIELDS } from './fixtures';
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
const near = (name: string, a: number, b: number, tol = 1e-3) => check(name, Math.abs(a - b) <= tol, { a, b });

function memoryMedia(): MediaSink & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    has: async (n) => (files.has(n) ? { size: files.get(n)!.length } : null),
    putMany: async (fs) => fs.forEach((f) => files.set(f.name, f.data)),
    rename: (n) => n.replace(/(\.\w+)$/, '-renamed$1'),
  };
}

async function run(format: 'legacy' | 'modern') {
  const tag = `[${format}]`;
  const nowMs = Date.now();
  const fx = await buildKaishiPackage(format, nowMs);
  const { sql, raw } = await openTestDb();
  const col = new Collection(sql);
  const media = memoryMedia();
  const pkg = await parseApkg(new Blob([fx.bytes as BlobPart]));
  const s = await importPackage(col, sql, pkg, media, { isCollection: false, nowMs });

  eq(`${tag} summary`, [s.notes, s.cards, s.reviews, s.mediaFiles], [20, 20, fx.revlogCount, fx.mediaNames.length]);

  // note type
  const nts = await col.notetypes();
  eq(`${tag} one notetype`, nts.length, 1);
  eq(`${tag} fields`, nts[0].fields.map((f) => f.name), KAISHI_FIELDS);
  eq(`${tag} css`, nts[0].css, KAISHI_CSS);

  // deck + preset
  const decks = await col.decks();
  eq(`${tag} decks`, decks.map((d) => d.name), ['Kaishi 1.5k']);
  eq(`${tag} description`, decks[0].description, 'A Japanese vocab deck');
  const confs = await col.deckConfigs();
  const kaishi = confs.find((c) => c.name === 'Kaishi');
  check(`${tag} preset imported`, !!kaishi, confs.map((c) => c.name));
  eq(`${tag} deck uses preset`, decks[0].conf_id, kaishi?.id);
  if (kaishi) {
    eq(`${tag} preset limits`, [kaishi.config.newPerDay, kaishi.config.reviewsPerDay, kaishi.config.buryNew, kaishi.config.buryReviews], [10, 300, true, true]);
    near(`${tag} preset DR`, kaishi.config.desiredRetention, 0.88);
    eq(`${tag} preset fsrs params`, kaishi.config.fsrsParams.length, 21);
    near(`${tag} preset w0`, kaishi.config.fsrsParams[0], FSRS_PARAMS[0], 1e-6);
    eq(`${tag} preset orders`, [kaishi.config.reviewOrder, kaishi.config.newMix], ['dayThenDeck', 'beforeReviews']);
  }
  void CONF_ID;

  // cards: scheduling state preserved, day-based dues shifted onto our day numbers
  const ourToday = timingAt(nowMs, (await col.config()).rollover).today;
  const rows = raw.exec('SELECT * FROM cards ORDER BY id') as Record<string, number | null>[];
  let ok = true;
  rows.forEach((c, i) => {
    const src = fx.cards[i];
    const dayBased = src.queue === 2 || src.queue === 3 || src.type === 2;
    const expectDue = dayBased ? src.due - fx.srcToday + ourToday : src.due;
    const same = c.type === src.type && c.queue === src.queue && c.due === expectDue && c.ivl === src.ivl && c.factor === src.factor && c.reps === src.reps && c.lapses === src.lapses && c.left === src.left;
    if (!same) {
      ok = false;
      console.error(`${tag} card ${i} differs`, { got: c, src, expectDue });
    }
  });
  check(`${tag} all card states preserved`, ok);
  const withFsrs = rows.filter((c) => c.stability != null).length;
  eq(`${tag} FSRS memory states kept`, withFsrs, fx.cards.filter((c) => c.data.includes('"s"')).length);
  check(`${tag} last_review filled for studied cards`, rows.filter((c) => c.type !== 0).every((c) => c.last_review != null));

  // deck counts: new = 5 (one more new card is buried), learning = 3 + 1 relearning, reviews due = 5 + 1
  const tree = await col.deckTree(nowMs);
  eq(`${tag} deck counts`, [tree[0].newCount, tree[0].learnCount, tree[0].reviewCount], [5, 4, 6]);

  // media present by original filename
  check(`${tag} media stored`, fx.mediaNames.every((n) => media.files.has(n)));

  // rendering uses the deck's own template
  const card = rows[0];
  const note = await col.note(card.nid as number);
  const r = renderCard({ notetype: nts[0], flds: note!.flds, ord: 0, tags: note!.tags, deckName: 'Kaishi 1.5k', flags: 0, cardId: card.id as number });
  check(`${tag} render front`, r.question.includes('<div class="word">食べる</div>'), r.question);
  check(`${tag} render furigana`, r.answer.includes('<ruby><rb>食</rb><rt>た</rt></ruby>べる'), r.answer);
  eq(`${tag} render audio`, r.answerAv.map((a) => a.value), ['word_0.mp3', 'sent_0.mp3']);
  check(`${tag} render picture`, r.answer.includes('<img src="pic_0.png">'), r.answer);

  // re-import: nothing duplicated
  const again = await importPackage(col, sql, await parseApkg(new Blob([fx.bytes as BlobPart])), media, { isCollection: false, nowMs });
  eq(`${tag} reimport skips`, [again.notes, again.cards, again.skippedNotes], [0, 0, 20]);
  eq(`${tag} reimport card count`, raw.exec('SELECT COUNT(*) AS n FROM cards')[0].n, 20);
}

async function main() {
  await run('legacy');
  await run('modern');
  if (failures) {
    console.error(`\n${failures} check(s) failed, ${passes} passed.`);
    process.exit(1);
  }
  console.log(`All ${passes} import checks passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
