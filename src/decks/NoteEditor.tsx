import { useEffect, useMemo, useRef, useState } from 'react';
import { col } from '../anki/appCollection';
import type { Notetype } from '../anki/notetype';
import { generatedOrdinals, renderCard } from '../anki/template';
import { usePrefs } from '../app/prefs';
import { useLive } from '../db/useLive';
import { hasMediaFile, putMediaFile, renamedForConflict } from '../media/store';
import { CardView } from '../study/CardView';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { Modal } from '../ui/Modal';

/**
 * The field editor shared by Add and Edit (Anki's editor, in its HTML form): each field gets a small
 * toolbar — bold, italic, underline, cloze, picture, audio — and, when adding, a pin that keeps the
 * field's text for the next note ("sticky"). The first field is checked for duplicates.
 */

const FIELD_SEP = '\x1f';

/** The next cloze number across all fields (Anki's Ctrl+Shift+C). */
function nextCloze(values: string[]): number {
  let max = 0;
  for (const v of values) for (const m of v.matchAll(/\{\{c(\d+)::/g)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/** Downscale a large photo before storing it (phone cameras make 5 MB images). */
async function prepareImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 600_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return out ?? file;
  } catch {
    return file;
  }
}

/** Store a picked file in the media folder; returns the name to reference it by. */
async function storeMedia(file: File): Promise<string> {
  const isImage = file.type.startsWith('image/');
  const blob = isImage ? await prepareImage(file) : file;
  let name = (file.name || (isImage ? 'image.jpg' : 'audio.mp3')).replace(/[\\/:*?"<>|#%[\]{}]/g, '_');
  if (blob !== file && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]*$/, '') + '.jpg';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const existing = await hasMediaFile(name);
  if (existing && existing.size !== bytes.length) name = renamedForConflict(name, bytes);
  await putMediaFile(name, blob);
  return name;
}

export function NoteFields({
  notetype,
  values,
  onChange,
  sticky,
  onToggleSticky,
  excludeNid = 0,
  autoFocus,
}: {
  notetype: Notetype;
  values: string[];
  onChange: (values: string[]) => void;
  sticky?: boolean[];
  onToggleSticky?: (i: number) => void;
  excludeNid?: number;
  autoFocus?: boolean;
}) {
  const fields = useMemo(() => [...notetype.fields].sort((a, b) => a.ord - b.ord), [notetype]);
  const [dupes, setDupes] = useState(0);
  const latest = useRef(values);
  latest.current = values;

  // Anki's duplicate check: same note type, same first field.
  const first = values[0] ?? '';
  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      void col.findDuplicates(notetype.id, first, excludeNid).then((ids) => alive && setDupes(ids.length));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [notetype.id, first, excludeNid]);

  const set = (i: number, v: string) => onChange(latest.current.map((x, j) => (j === i ? v : x)));

  return (
    <>
      {fields.map((f, i) => (
        <FieldInput
          key={`${notetype.id}-${f.ord}`}
          label={f.name}
          value={values[i] ?? ''}
          rows={i === 0 ? 2 : Math.min(6, Math.max(1, Math.ceil((values[i]?.length ?? 0) / 40)))}
          autoFocus={autoFocus && i === 0}
          cloze={notetype.kind === 1}
          nextCloze={() => nextCloze(latest.current)}
          onChange={(v) => set(i, v)}
          sticky={sticky?.[i]}
          onToggleSticky={onToggleSticky ? () => onToggleSticky(i) : undefined}
          warning={i === 0 && dupes > 0 ? `Duplicate: ${dupes === 1 ? 'a note' : `${dupes} notes`} of this type already ${dupes === 1 ? 'has' : 'have'} this first field.` : undefined}
        />
      ))}
    </>
  );
}

function FieldInput({
  label,
  value,
  rows,
  autoFocus,
  cloze,
  nextCloze: getNextCloze,
  onChange,
  sticky,
  onToggleSticky,
  warning,
}: {
  label: string;
  value: string;
  rows: number;
  autoFocus?: boolean;
  cloze: boolean;
  nextCloze: () => number;
  onChange: (v: string) => void;
  sticky?: boolean;
  onToggleSticky?: () => void;
  warning?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [mediaKind, setMediaKind] = useState<'image' | 'audio'>('image');
  const [err, setErr] = useState<string | null>(null);

  /** Replace the selection with before + selection + after, keeping the selection inside. */
  const wrap = (before: string, after: string) => {
    const el = ta.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + before.length, end + before.length);
    });
  };
  const insert = (text: string) => wrap(text, '');

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'b') wrap('<b>', '</b>');
    else if (k === 'i') wrap('<i>', '</i>');
    else if (k === 'u') wrap('<u>', '</u>');
    else if (k === 'c' && e.shiftKey) {
      const n = getNextCloze();
      wrap(`{{c${e.altKey ? Math.max(1, n - 1) : n}::`, '}}');
    } else return;
    e.preventDefault();
  };

  return (
    <div className="nf">
      <div className="nf-head">
        <span className="nf-label">{label}</span>
        <span className="nf-tools">
          <button type="button" title="Bold (Ctrl+B)" onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('<b>', '</b>')}><b>B</b></button>
          <button type="button" title="Italic (Ctrl+I)" onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('<i>', '</i>')}><i>I</i></button>
          <button type="button" title="Underline (Ctrl+U)" onMouseDown={(e) => e.preventDefault()} onClick={() => wrap('<u>', '</u>')}><u>U</u></button>
          {cloze && (
            <button type="button" className="nf-cloze" title="Cloze deletion (Ctrl+Shift+C)" onMouseDown={(e) => e.preventDefault()} onClick={() => wrap(`{{c${getNextCloze()}::`, '}}')}>[…]</button>
          )}
          <button type="button" title="Add a picture" onClick={() => { setMediaKind('image'); fileRef.current?.click(); }}>🖼</button>
          <button type="button" title="Add audio" onClick={() => { setMediaKind('audio'); fileRef.current?.click(); }}>♪</button>
          {onToggleSticky && (
            <button type="button" className={'nf-pin' + (sticky ? ' on' : '')} title={sticky ? 'Sticky: kept for the next note' : 'Keep this field for the next note'} aria-pressed={!!sticky} onClick={onToggleSticky}>📌</button>
          )}
        </span>
      </div>
      <textarea
        ref={ta}
        lang="ja"
        rows={rows}
        autoFocus={autoFocus}
        value={value}
        onKeyDown={onKeyDown}
        onChange={(e) => onChange(e.target.value)}
      />
      {warning && <p className="nf-warn">{warning}</p>}
      {err && <p className="nf-warn">{err}</p>}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept={mediaKind === 'image' ? 'image/*' : 'audio/*'}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setErr(null);
          try {
            const name = await storeMedia(file);
            insert(file.type.startsWith('image/') ? `<img src="${name.replace(/"/g, '&quot;')}">` : `[sound:${name}]`);
          } catch (x) {
            setErr(`Couldn’t add that file: ${x instanceof Error ? x.message : String(x)}`);
          }
        }}
      />
    </div>
  );
}

/** Space-separated tags, with suggestions from the collection for the word being typed. */
export function TagInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: all } = useLive(() => col.allTags(), [], ['notes']);
  const [focused, setFocused] = useState(false);
  const words = value.split(/\s+/);
  const current = value.endsWith(' ') ? '' : words[words.length - 1] ?? '';
  const have = new Set(words.map((w) => w.toLowerCase()));
  const suggestions = current
    ? (all ?? []).filter((t) => t.toLowerCase().includes(current.toLowerCase()) && !have.has(t.toLowerCase())).slice(0, 8)
    : [];
  return (
    <label className="opt-field col">
      <span>Tags</span>
      <input
        value={value}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="space-separated"
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onChange={(e) => onChange(e.target.value)}
      />
      {focused && suggestions.length > 0 && (
        <span className="tag-suggest">
          {suggestions.map((t) => (
            <button
              type="button"
              key={t}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange([...words.slice(0, -1), t].join(' ') + ' ')}
            >
              {t}
            </button>
          ))}
        </span>
      )}
    </label>
  );
}

/** Preview the cards a note makes (both sides), as the reviewer would show them. */
export function CardPreview({ notetype, values, tags, deckName, onClose }: { notetype: Notetype; values: string[]; tags: string; deckName: string; onClose: () => void }) {
  const dark = usePrefs((s) => s.dark);
  const flds = values.join(FIELD_SEP);
  const ords = useMemo(() => generatedOrdinals(notetype, flds), [notetype, flds]);
  const [ordIdx, setOrdIdx] = useState(0);
  const [back, setBack] = useState(false);
  const ord = ords[Math.min(ordIdx, ords.length - 1)] ?? 0;
  const rendered = useMemo(() => renderCard({ notetype, flds, ord, tags: ` ${tags} `, deckName, flags: 0, cardId: 0 }), [notetype, flds, ord, tags, deckName]);
  const html = (back ? rendered.answer : rendered.question).replace(/\[\[type:[^\]]+\]\]/g, back ? '' : '<input type="text" id="typeans">');
  const label = (o: number) => (notetype.kind === 1 ? `Cloze ${o + 1}` : notetype.templates.find((t) => t.ord === o)?.name ?? `Card ${o + 1}`);
  return (
    <Modal title="Preview" onClose={onClose} wide>
      <div className="modal-body preview-body">
        {ords.length > 1 && (
          <div className="chip-row">
            {ords.map((o, i) => (
              <button key={o} className={'fchip' + (i === ordIdx ? ' on' : '')} onClick={() => setOrdIdx(i)}>{label(o)}</button>
            ))}
          </div>
        )}
        {ords.length === 0 ? (
          <p className="muted">This note doesn’t make any cards yet.</p>
        ) : (
          <div className="preview-frame">
            <CardView html={html} css={rendered.css} ord={ord} dark={dark} onEvent={(e) => e.type === 'tap' && setBack((b) => !b)} side={back ? 'a' : 'q'} />
          </div>
        )}
      </div>
      <div className="modal-foot">
        <Btn onClick={() => setBack((b) => !b)}><Icon.review s={15} /> {back ? 'Show front' : 'Show back'}</Btn>
        <Btn variant="primary" onClick={onClose}>Done</Btn>
      </div>
    </Modal>
  );
}
