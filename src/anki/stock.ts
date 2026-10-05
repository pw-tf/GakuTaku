import type { Collection } from './collection';
import type { Notetype } from './notetype';

/** Anki's stock note types (pylib/anki/stdmodels.py) plus GakuTaku's Japanese vocab type for mining. */

const ANKI_CSS = `.card {
    font-family: arial;
    font-size: 20px;
    line-height: 1.5;
    text-align: center;
    color: black;
    background-color: white;
}
`;

const CLOZE_CSS = `${ANKI_CSS}
.cloze {
    font-weight: bold;
    color: blue;
}
.nightMode .cloze {
    color: lightblue;
}
`;

export const VOCAB_NOTETYPE_NAME = 'Japanese Vocab (GakuTaku)';
export const VOCAB_FIELDS = ['Word', 'Reading', 'Meaning', 'Sentence', 'Sentence Meaning', 'Word Audio', 'Sentence Audio', 'Picture', 'Source'];

const VOCAB_CSS = `.card {
  font-family: "Zen Kaku Gothic New", "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 20px;
  line-height: 1.6;
  text-align: center;
  color: #26221d;
  background-color: #faf7f1;
}
.card.nightMode { color: #ece6dc; background-color: #24211d; }
.word { font-family: "Shippori Mincho", "Hiragino Mincho ProN", serif; font-size: 64px; font-weight: 700; line-height: 1.15; margin-top: 12vh; }
.reading { font-size: 26px; color: #6e655a; margin-top: 8px; }
.nightMode .reading { color: #b5ab9d; }
.meaning { font-size: 21px; margin: 18px auto 0; max-width: 32em; }
.sentence { font-size: 22px; margin: 22px auto 0; max-width: 30em; }
.sentence b, .sentence strong { color: #b8492f; }
.nightMode .sentence b, .nightMode .sentence strong { color: #e48a6f; }
.sentence-meaning { font-size: 16px; color: #8a8175; margin-top: 6px; }
.source { font-size: 12px; color: #a59c8f; margin-top: 26px; }
img { max-height: 40vh; margin-top: 16px; border-radius: 8px; }
hr#answer { margin: 22px auto; width: 50px; border: none; height: 1px; background: #d8d0c4; }
`;

const VOCAB_FRONT = `<div class="word">{{Word}}</div>`;
const VOCAB_BACK = `{{FrontSide}}
<hr id=answer>
<div class="reading">{{Reading}}</div>
{{Word Audio}}
<div class="meaning">{{Meaning}}</div>
{{#Sentence}}<div class="sentence">{{Sentence}}</div>{{/Sentence}}
{{#Sentence Meaning}}<div class="sentence-meaning">{{Sentence Meaning}}</div>{{/Sentence Meaning}}
{{Sentence Audio}}
{{#Picture}}<div>{{Picture}}</div>{{/Picture}}
{{#Source}}<div class="source">{{Source}}</div>{{/Source}}`;

const fields = (names: string[]) => names.map((name, ord) => ({ name, ord }));

export function stockNotetypes(): Omit<Notetype, 'id'>[] {
  return [
    {
      name: 'Basic', kind: 0, css: ANKI_CSS, sortIdx: 0, fields: fields(['Front', 'Back']),
      templates: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }],
    },
    {
      name: 'Basic (and reversed card)', kind: 0, css: ANKI_CSS, sortIdx: 0, fields: fields(['Front', 'Back']),
      templates: [
        { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' },
        { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}' },
      ],
    },
    {
      name: 'Cloze', kind: 1, css: CLOZE_CSS, sortIdx: 0, fields: fields(['Text', 'Back Extra']),
      templates: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }],
    },
    {
      name: VOCAB_NOTETYPE_NAME, kind: 0, css: VOCAB_CSS, sortIdx: 0, fields: fields(VOCAB_FIELDS),
      templates: [{ name: 'Recognition', ord: 0, qfmt: VOCAB_FRONT, afmt: VOCAB_BACK }],
    },
  ];
}

/** Create any missing stock note types (by name). Safe to call on every start. */
export async function ensureStockNotetypes(col: Collection): Promise<void> {
  const existing = new Set((await col.notetypes()).map((n) => n.name));
  for (const nt of stockNotetypes()) if (!existing.has(nt.name)) await col.addNotetype(nt);
}
