/**
 * Checks for book import and mining capture:
 *   - TXT decoding (UTF-8/16, Shift_JIS, EUC-JP), Aozora Bunko cleanup, chapter splitting;
 *   - PDF text extraction through pdf.js, with hand-built PDFs that use a non-embedded Japanese CID
 *     font (the usual case for Japanese PDFs) in horizontal and vertical writing;
 *   - sentence capture around a tapped word, and how the mined card renders it.
 *
 *   npm run verify:books
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { captureSentence, sentenceBounds, type SentenceToken } from '../src/books/sentence';
import {
  chapterize,
  cleanAozoraLine,
  decodeText,
  looksLikeHeading,
  parseTxt,
  pdfItemsToLines,
  pdfLinesToParas,
  type PdfTextItem,
} from '../src/books/textBook';
import { furiganaFilter, kanjiFilter, renderCard } from '../src/anki/template';
import { ensureStockNotetypes, stockNotetypes, VOCAB_FIELDS, VOCAB_NOTETYPE_NAME } from '../src/anki/stock';
import { Collection } from '../src/anki/collection';
import { openTestDb } from './sqliteNode';

let failures = 0;
let passes = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passes++;
  else {
    failures++;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  }
}
const ok = (label: string, cond: boolean, detail?: unknown) => eq(label, cond ? true : detail ?? false, true);

// ---- Decoding -------------------------------------------------------------------------------
const utf8 = new TextEncoder().encode('日本語のテキスト');
eq('utf-8', decodeText(utf8), '日本語のテキスト');
eq('utf-8 BOM', decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])), '日本語のテキスト');
const utf16 = new Uint8Array([0xff, 0xfe, 0xe5, 0x65, 0x2c, 0x67]); // 日本 LE
eq('utf-16le BOM', decodeText(utf16), '日本');
// 日本語です。 in Shift_JIS and EUC-JP.
const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xc5, 0x82, 0xb7, 0x81, 0x42]);
const euc = new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec, 0xa4, 0xc7, 0xa4, 0xb9, 0xa1, 0xa3]);
eq('shift_jis', decodeText(sjis), '日本語です。');
eq('euc-jp', decodeText(euc), '日本語です。');

// ---- Aozora Bunko ---------------------------------------------------------------------------
eq('aozora ruby', cleanAozoraLine('吾輩《わがはい》は｜猫である《ねこである》').text, '吾輩は猫である');
eq('aozora note', cleanAozoraLine('［＃７字下げ］一［＃「一」は中見出し］'), { text: '一', heading: true });
eq('heading 第一章', looksLikeHeading('第一章　出会い'), true);
eq('not a heading', looksLikeHeading('第一に、これは長い文章であって見出しではないのですが、どうでしょうか。'), false);

const aozora = [
  '吾輩は猫である',
  '夏目漱石',
  '',
  '-------------------------------------------------------',
  '【テキスト中に現れる記号について】',
  '《》：ルビ',
  '-------------------------------------------------------',
  '',
  '［＃８字下げ］一［＃「一」は中見出し］',
  '',
  '　吾輩《わがはい》は猫である。名前はまだ無い。',
  '　どこで生れたかとんと見当《けんとう》がつかぬ。',
  '',
  '［＃８字下げ］二［＃「二」は中見出し］',
  '　吾輩は新年来多少有名になったので、',
  '',
  '底本：「夏目漱石全集1」ちくま文庫、筑摩書房',
  '入力：柴田卓治',
].join('\r\n');
const book = parseTxt(aozora, 'file');
eq('aozora title', book.title, '吾輩は猫である');
eq('aozora creator', book.creator, '夏目漱石');
eq('aozora chapters', book.chapters.map((c) => c.title), ['一', '二']);
eq('aozora chapter 1', book.chapters[0].paragraphs, ['一', '　吾輩は猫である。名前はまだ無い。', '　どこで生れたかとんと見当がつかぬ。']);
ok('notation box dropped', !JSON.stringify(book).includes('ルビ'));
ok('colophon dropped', !JSON.stringify(book).includes('底本'));

const plain = parseTxt(Array.from({ length: 400 }, (_, i) => `これは${i}番目の段落です。`.repeat(3)).join('\n'), 'plain');
ok('headingless text is split into sections', plain.chapters.length > 1, plain.chapters.length);
eq('sections are named', plain.chapters[0].title, 'Part 1');
eq('no paragraphs lost', plain.chapters.reduce((n, c) => n + c.paragraphs.length, 0), 400);
const big = chapterize([{ text: '第一章', heading: true }, ...Array.from({ length: 2000 }, () => ({ text: 'あ'.repeat(20) })), { text: '第二章', heading: true }, { text: 'い' }]);
eq('long chapter split into parts', big.map((c) => c.title).slice(0, 3), ['第一章 (1)', '第一章 (2)', '第一章 (3)']);

// ---- PDF line → paragraph -------------------------------------------------------------------
const pages = [
  ['ある日の話', '　彼は駅へ向かって歩いていた。空は灰色で、今にも雨が', '降り出しそうだった。', '「急がないと」', '　彼はつぶやいた。', '1'],
  ['ある日の話', '　駅に着くと、電車はもう出ていた。', '2'],
  ['ある日の話', '第二章　雨', '　雨は夜まで続いた。', '3'],
  ['ある日の話', '　翌朝、空は晴れていた。', '4'],
];
eq('pdf paragraphs', pdfLinesToParas(pages).map((p) => p.text), [
  '彼は駅へ向かって歩いていた。空は灰色で、今にも雨が降り出しそうだった。',
  '「急がないと」',
  '彼はつぶやいた。',
  '駅に着くと、電車はもう出ていた。',
  '第二章　雨',
  '雨は夜まで続いた。',
  '翌朝、空は晴れていた。',
]);
eq('pdf heading marked', pdfLinesToParas(pages).filter((p) => p.heading).map((p) => p.text), ['第二章　雨']);
const items: PdfTextItem[] = [
  { str: '一行目', transform: [12, 0, 0, 12, 72, 700] },
  { str: 'の続き', transform: [12, 0, 0, 12, 108, 700] },
  { str: '二行目', transform: [12, 0, 0, 12, 72, 680] },
  { str: '三行目', hasEOL: true, transform: [12, 0, 0, 12, 72, 660] },
  { str: '四', transform: [12, 0, 0, 12, 72, 640] },
];
eq('vertical forms normalised', pdfItemsToLines([{ str: '﹁雨だ︒﹂︙' }]), ['「雨だ。」…']);
eq('pdf items → lines', pdfItemsToLines(items), ['一行目の続き', '二行目', '三行目', '四']);

// ---- Real PDFs through pdf.js ---------------------------------------------------------------
function utf16Hex(s: string): string {
  return Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
}
/** A PDF whose text uses a non-embedded Adobe-Japan1 CID font with a predefined UCS-2 CMap. */
function makePdf(pageLines: string[][], vertical: boolean, title: string): Uint8Array {
  const objs: string[] = [];
  const pageIds: number[] = [];
  const add = (body: string) => objs.push(body) && objs.length;
  const catalog = add('');
  const pagesId = add('');
  const font = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-${vertical ? 'V' : 'H'} /DescendantFonts [${objs.length + 3} 0 R] >>`,
  );
  const descriptor = add('<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 709 /StemV 80 >>');
  add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
  for (const lines of pageLines) {
    const ops = lines
      .map((l, i) => {
        // A paragraph indent is typeset as a one-character offset, not a space glyph.
        const indent = l.startsWith('　') ? 14 : 0;
        const [x, y] = vertical ? [540 - i * 20, 760 - indent] : [60 + indent, 760 - i * 20];
        return `BT /F1 14 Tf 1 0 0 1 ${x} ${y} Tm <${utf16Hex(l.replace(/^　/, ''))}> Tj ET`;
      })
      .join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  const info = add(`<< /Title <feff${utf16Hex(title)}> /Author (Test Author) >>`);
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // All content is ASCII (text is hex-encoded), so string length = byte offset.
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function extract(bytes: Uint8Array) {
  const doc = await getDocument({
    data: bytes,
    cMapUrl: new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).pathname,
    cMapPacked: true,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname,
    verbosity: 0,
  }).promise;
  const meta = (await doc.getMetadata()).info as { Title?: string; Author?: string };
  const out: string[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const vertical = new Set(Object.entries(content.styles).filter(([, st]) => (st as { vertical?: boolean }).vertical).map(([name]) => name));
    out.push(pdfItemsToLines(content.items as PdfTextItem[], vertical));
  }
  await doc.destroy();
  return { meta, pages: out };
}

const pdfText = [
  ['　吾輩は猫である。名前は', 'まだ無い。', '「どこで生れたか」', '1'],
  ['　とんと見当がつかぬ。', '2'],
];
for (const vertical of [false, true]) {
  const tag = vertical ? 'vertical' : 'horizontal';
  const { meta, pages: got } = await extract(makePdf(pdfText, vertical, '猫の本'));
  eq(`pdf ${tag}: title`, meta.Title, '猫の本');
  eq(`pdf ${tag}: lines`, got, pdfText);
  eq(`pdf ${tag}: paragraphs`, pdfLinesToParas(got).map((p) => p.text), ['吾輩は猫である。名前はまだ無い。', '「どこで生れたか」', 'とんと見当がつかぬ。']);
}

// ---- Sentence capture -----------------------------------------------------------------------
const tok = (surface: string, reading?: string): SentenceToken => ({
  surface,
  segments: reading ? [{ text: surface, reading }] : [{ text: surface }],
});
const para: SentenceToken[] = [
  tok('　'), tok('「'), tok('雨', 'あめ'), tok('だ'), tok('。'), tok('」'),
  tok('彼', 'かれ'), tok('は'), tok('傘', 'かさ'), tok('を'),
  { surface: '持って', segments: [{ text: '持', reading: 'も' }, { text: 'って' }] },
  tok('いた'), tok('。'), tok('そして'), tok('歩い'), tok('た'),
];
eq('bounds: first sentence', sentenceBounds(para, 2), [1, 6]);
eq('bounds: middle sentence (closing quote belongs to the previous one)', sentenceBounds(para, 8), [6, 13]);
eq('bounds: last sentence, no end mark', sentenceBounds(para, 14), [13, 16]);
const cap = captureSentence(para, 8);
eq('plain', cap.plain, '彼は傘を持っていた。');
eq('html', cap.html, '彼は<b>傘</b>を持っていた。');
eq('furigana syntax', cap.furigana, '彼[かれ]は<b>傘[かさ]</b>を 持[も]っていた。');
eq('furigana renders as ruby', furiganaFilter(cap.furigana), '<ruby><rb>彼</rb><rt>かれ</rt></ruby>は<b><ruby><rb>傘</rb><rt>かさ</rt></ruby></b>を<ruby><rb>持</rb><rt>も</rt></ruby>っていた。');
eq('kanji filter gives speakable text', kanjiFilter(cap.furigana), '彼は<b>傘</b>を持っていた。');
eq('html is escaped', captureSentence([tok('a<b'), tok('。')], 0).html, '<b>a&lt;b</b>。');

// ---- The mined card -------------------------------------------------------------------------
const vocab = { id: 1, ...stockNotetypes().find((n) => n.name === VOCAB_NOTETYPE_NAME)! };
const fieldsOf = (v: Record<string, string>) => VOCAB_FIELDS.map((f) => v[f] ?? '').join('\x1f');
const card = (v: Record<string, string>) => renderCard({ notetype: vocab, flds: fieldsOf(v), ord: 0, tags: '', deckName: 'Mined', flags: 0, cardId: 1 });
const withAudio = card({ Word: '傘', Reading: 'かさ', Meaning: 'umbrella', Sentence: cap.furigana, 'Word Audio': '[sound:w.mp3]', 'Sentence Audio': '[sound:s.wav]', Source: 'Book' });
ok('card shows ruby sentence', withAudio.answer.includes('<rt>かさ</rt>'), withAudio.answer);
eq('card plays recorded audio', withAudio.answerAv.map((a) => [a.kind, a.value]), [['sound', 'w.mp3'], ['sound', 's.wav']]);
const noAudio = card({ Word: '傘', Reading: 'かさ', Meaning: 'umbrella', Sentence: cap.furigana });
eq('without recordings the card speaks', noAudio.answerAv.map((a) => [a.kind, a.value, a.lang]), [['tts', '傘', 'ja_JP'], ['tts', '彼は傘を持っていた。', 'ja_JP']]);
const noSentence = card({ Word: '傘', Reading: 'かさ', Meaning: 'umbrella' });
eq('no sentence, no sentence speech', noSentence.answerAv.map((a) => a.value), ['傘']);

// ---- Upgrading the vocab note type shipped before sentence capture ---------------------------
const VOCAB_BACK_V1 = `{{FrontSide}}
<hr id=answer>
<div class="reading">{{Reading}}</div>
{{Word Audio}}
<div class="meaning">{{Meaning}}</div>
{{#Sentence}}<div class="sentence">{{Sentence}}</div>{{/Sentence}}
{{#Sentence Meaning}}<div class="sentence-meaning">{{Sentence Meaning}}</div>{{/Sentence Meaning}}
{{Sentence Audio}}
{{#Picture}}<div>{{Picture}}</div>{{/Picture}}
{{#Source}}<div class="source">{{Source}}</div>{{/Source}}`;
{
  const { sql } = await openTestDb();
  const col = new Collection(sql);
  await ensureStockNotetypes(col);
  const vocabNt = async () => (await col.notetypes()).find((n) => n.name === VOCAB_NOTETYPE_NAME)!;
  const nt = await vocabNt();
  await col.updateNotetype({ ...nt, templates: [{ ...nt.templates[0], afmt: VOCAB_BACK_V1 }] });
  await ensureStockNotetypes(col);
  ok('shipped v1 back template is upgraded', (await vocabNt()).templates[0].afmt.includes('{{furigana:Sentence}}'));
  const custom = VOCAB_BACK_V1 + '\n<div>mine</div>';
  await col.updateNotetype({ ...(await vocabNt()), templates: [{ ...nt.templates[0], afmt: custom }] });
  await ensureStockNotetypes(col);
  eq('user-edited template is left alone', (await vocabNt()).templates[0].afmt, custom);
  eq('no duplicate stock note types', (await col.notetypes()).filter((n) => n.name === VOCAB_NOTETYPE_NAME).length, 1);
}

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
