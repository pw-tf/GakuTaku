/**
 * Standalone verification for the on-demand dictionary + feed parsing. Run with
 * `npx tsx scripts/verify-dict.ts` (or `npm run verify:dict`). No test framework — same pattern as
 * verify-srs.ts / verify-analytics.ts: everything imported here is pure, so it runs without a
 * browser, a network, or the built dictionary.
 *
 * The bucket hash is the load-bearing piece: the build script files each headword into
 * `bucketOf(form, n)` and the runtime fetches exactly that bucket, so if the two ever disagreed
 * every lookup would silently return nothing. These checks pin its behaviour.
 */
import { bucketOf, bucketPath } from '../src/dictionary/types';
import { mimeForMedia } from '../src/import/mediaMime';
import { parseNhkEasyList } from '../src/feeds/parse';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function checkTrue(label: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ---------- 1. Bucket hash ----------
console.log('--- bucket hash ---');
{
  const forms = ['猫', '食べる', 'ネコ', '日本語', 'たべる', '田中', 'ア', '一二三四五六七八九十'];
  for (const f of forms) {
    checkTrue(`${f}: stable across calls`, bucketOf(f, 4096) === bucketOf(f, 4096));
    checkTrue(`${f}: within range`, bucketOf(f, 4096) >= 0 && bucketOf(f, 4096) < 4096);
    checkTrue(`${f}: integer`, Number.isInteger(bucketOf(f, 4096)));
  }
  check('empty string is in range', bucketOf('', 4096) >= 0 && bucketOf('', 4096) < 4096, true);
  checkTrue('distinct forms generally land in distinct buckets', new Set(forms.map((f) => bucketOf(f, 4096))).size >= 7);
  checkTrue('bucket count is honoured', [...Array(200)].every((_, i) => bucketOf(`w${i}`, 16) < 16));
}
{
  // Even spread matters: one oversized bucket is a slow lookup for every word in it.
  const N = 2048;
  const counts = new Array<number>(N).fill(0);
  for (let i = 0; i < 200_000; i++) counts[bucketOf(`見出し語${i}`, N)]++;
  const mean = 200_000 / N;
  const max = Math.max(...counts);
  const empty = counts.filter((c) => c === 0).length;
  checkTrue(`no bucket wildly oversized (max ${max} vs mean ${mean})`, max < mean * 2);
  checkTrue(`no empty buckets (${empty})`, empty === 0);
}

// ---------- 2. Bucket paths ----------
console.log('\n--- bucket paths ---');
check('bucket 0', bucketPath(0), 'b/0000.json.gz');
check('bucket 42', bucketPath(42), 'b/0042.json.gz');
check('bucket 4095', bucketPath(4095), 'b/4095.json.gz');
checkTrue('paths are unique per bucket', new Set([...Array(4096)].map((_, i) => bucketPath(i))).size === 4096);

// ---------- 3. Media MIME types ----------
console.log('\n--- media mime types ---');
check('mp3', mimeForMedia('audio.mp3'), 'audio/mpeg');
check('ogg', mimeForMedia('word_1234.ogg'), 'audio/ogg');
check('uppercase extension', mimeForMedia('CLIP.MP3'), 'audio/mpeg');
check('dotted filename', mimeForMedia('my.file.name.wav'), 'audio/wav');
check('image', mimeForMedia('diagram.png'), 'image/png');
check('unknown extension', mimeForMedia('notes.xyz'), 'application/octet-stream');
check('no extension', mimeForMedia('noextension'), 'application/octet-stream');

// ---------- 4. NHK Easy list parsing ----------
// NHK moved News Web Easy to news.web.nhk for NHK ONE (Oct 2025) and serves two list shapes.
// Both must parse, and article links must follow whichever host actually answered.
console.log('\n--- NHK Easy list ---');
const NEW_HOST = 'https://news.web.nhk/news/easy/news-list.json';
const OLD_HOST = 'https://www3.nhk.or.jp/news/easy/news-list.json';
{
  const dateKeyed = JSON.stringify([
    {
      '2026-08-01': [
        { news_id: 'k100', title: '台風が近づいています', news_prearranged_time: '2026-08-01 11:30:00' },
      ],
      '2026-07-31': [
        { news_id: 'k099', title: '新しい駅ができました', news_prearranged_time: '2026-07-31 09:00:00' },
      ],
    },
  ]);
  const arts = parseNhkEasyList(dateKeyed, NEW_HOST);
  check('date-keyed shape parses both days', arts.length, 2);
  check('newest first', arts[0].id, 'k100');
  check('link follows the responding host', arts[0].link, 'https://news.web.nhk/news/easy/k100/k100.html');
  check('JST timestamp becomes UTC', arts[0].published, '2026-08-01T02:30:00.000Z');
}
{
  const flat = JSON.stringify([
    { news_id: 'k200', title: '雨が降ります', news_prearranged_time: '2026-08-02 07:00:00' },
    { news_id: 'k201', title: '祭りがあります', news_publication_time: '2026-08-02 08:00:00' },
  ]);
  const arts = parseNhkEasyList(flat, NEW_HOST);
  check('flat shape parses', arts.length, 2);
  check('flat shape sorts newest first', [arts[0].id, arts[1].id], ['k201', 'k200']);
  check('news_publication_time is accepted', arts[0].published, '2026-08-01T23:00:00.000Z');
}
{
  const legacy = JSON.stringify([{ '2026-08-01': [{ news_id: 'k300', title: 'ニュース' }] }]);
  check('legacy host still yields legacy links', parseNhkEasyList(legacy, OLD_HOST)[0].link,
    'https://www3.nhk.or.jp/news/easy/k300/k300.html');
  check('missing timestamp is null, not a crash', parseNhkEasyList(legacy, OLD_HOST)[0].published, null);
}
{
  const ruby = JSON.stringify([{ news_id: 'k400', title: '<ruby>台風<rt>たいふう</rt></ruby>が来る' }]);
  check('ruby markup is stripped from titles', parseNhkEasyList(ruby, NEW_HOST)[0].title, '台風が来る');
}
{
  const dupes = JSON.stringify([
    { news_id: 'k500', title: 'A', news_prearranged_time: '2026-08-01 10:00:00' },
    { news_id: 'k500', title: 'A again', news_prearranged_time: '2026-08-01 10:00:00' },
  ]);
  check('duplicate news_ids collapse', parseNhkEasyList(dupes, NEW_HOST).length, 1);
}
{
  const throws = (json: string) => {
    try {
      parseNhkEasyList(json, NEW_HOST);
      return false;
    } catch {
      return true;
    }
  };
  checkTrue('invalid JSON throws', throws('<!DOCTYPE html><html>401</html>'));
  checkTrue('empty list throws rather than showing an empty feed', throws('[]'));
  checkTrue('unrecognised shape throws', throws('{"items":[{"id":"x"}]}'));
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All dictionary checks passed.');
