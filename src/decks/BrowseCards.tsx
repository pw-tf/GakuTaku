import { useEffect, useMemo, useRef, useState } from 'react';
import { appSql, col } from '../anki/appCollection';
import { SearchError, SORT_COLUMNS, type SortColumn } from '../anki/search';
import { stripHtml } from '../anki/template';
import { timeSpan } from '../anki/timespan';
import { useBackHandler } from '../app/back';
import { useLive } from '../db/useLive';
import { FLAG_COLORS, FLAG_NAMES } from '../study/ReviewScreen';
import { EditNoteModal } from '../study/EditNoteModal';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { ConfirmModal, Modal, PromptModal } from '../ui/Modal';
import { CardInfoModal } from './CardInfo';

/**
 * Anki's Browse screen: Anki search syntax over the whole collection (or one deck, via its
 * `deck:"…"` search), sortable columns, and actions on one card or — after a long press — on a
 * selection.
 */

type Filter = 'all' | 'due' | 'new' | 'learn' | 'review' | 'suspended' | 'buried' | 'flagged' | 'leech' | 'today' | 'added';
const FILTERS: Record<Filter, [string, string]> = {
  all: ['All', ''],
  due: ['Due', 'is:due'],
  new: ['New', 'is:new'],
  learn: ['Learning', 'is:learn'],
  review: ['Review', 'is:review'],
  suspended: ['Suspended', 'is:suspended'],
  buried: ['Buried', 'is:buried'],
  flagged: ['Flagged', '-flag:0'],
  leech: ['Leeches', 'tag:leech'],
  today: ['Studied today', 'rated:1'],
  added: ['Added today', 'added:1'],
};

interface Row {
  id: number;
  nid: number;
  did: number;
  ord: number;
  type: number;
  queue: number;
  due: number;
  odue: number;
  ivl: number;
  factor: number;
  flags: number;
  reps: number;
  lapses: number;
  mod: number;
  stability: number | null;
  difficulty: number | null;
  sfld: string;
  tags: string;
  deck: string;
}

const PAGE = 150;
const SORT_KEY = 'gt-browse-sort';

function loadSort(): { col: SortColumn; desc: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_KEY) ?? '') as { col: SortColumn; desc: boolean };
    if (v && v.col in SORT_COLUMNS) return v;
  } catch {
    /* default */
  }
  return { col: 'sortField', desc: false };
}

function dueLabel(r: Row, today: number, nowSecs: number): string {
  if (r.queue === -1) return 'Suspended';
  if (r.queue === -2 || r.queue === -3) return 'Buried';
  if (r.type === 0) return `New #${r.due}`;
  if (r.queue === 1 || r.queue === 4) {
    const mins = Math.max(0, Math.round((r.due - nowSecs) / 60));
    return mins < 1 ? 'Now' : mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
  }
  const days = (r.odue || r.due) - today;
  if (days <= 0) return days === 0 ? 'Today' : `${-days}d overdue`;
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

/** The value of the sort column, shown on each row (when it isn't already). */
function sortValue(r: Row, c: SortColumn): string | null {
  switch (c) {
    case 'interval':
      return r.ivl > 0 ? timeSpan(r.ivl * 86_400) : null;
    case 'ease':
      return r.factor > 0 ? `${Math.round(r.factor / 10)}% ease` : null;
    case 'reviews':
      return `${r.reps} reviews`;
    case 'lapses':
      return `${r.lapses} lapses`;
    case 'difficulty':
      return r.difficulty != null ? `${Math.round(((r.difficulty - 1) / 9) * 100)}% difficulty` : null;
    case 'stability':
      return r.stability != null ? `stability ${timeSpan(r.stability * 86_400)}` : null;
    case 'created':
      return `added ${new Date(r.nid).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
    case 'modified':
      return `edited ${new Date(r.mod * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
    default:
      return null;
  }
}

export function BrowseCards({ initialQuery = '', title = 'Browse', currentDeckId, onBack }: { initialQuery?: string; title?: string; currentDeckId?: number; onBack: () => void }) {
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSortState] = useState(loadSort);
  const [limit, setLimit] = useState(PAGE);
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const [sheet, setSheet] = useState<{ cids: number[]; row?: Row } | null>(null);
  const [help, setHelp] = useState(false);
  const lastGood = useRef<{ ids: number[]; rows: Row[]; today: number; now: number } | null>(null);

  useBackHandler(selection == null, onBack);
  useBackHandler(selection != null, () => setSelection(null));

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(input);
      setLimit(PAGE);
    }, 250);
    return () => clearTimeout(id);
  }, [input]);

  const setSort = (next: { col: SortColumn; desc: boolean }) => {
    setSortState(next);
    setLimit(PAGE);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };

  const fullQuery = useMemo(() => {
    const term = FILTERS[filter][1];
    const q = query.trim();
    if (!term) return q;
    return q ? `(${q}) ${term}` : term;
  }, [query, filter]);

  const { data } = useLive(
    async () => {
      try {
        const t = await col.timing();
        const ids = await col.searchCards(fullQuery, { sort: sort.col, desc: sort.desc, currentDeckId });
        const page = ids.slice(0, limit);
        const rows: Row[] = [];
        for (let i = 0; i < page.length; i += 500) {
          const chunk = page.slice(i, i + 500);
          rows.push(
            ...(await appSql.all<Row>(
              `SELECT c.id, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.odue, c.ivl, c.factor, c.flags, c.reps, c.lapses, c.mod, c.stability, c.difficulty, n.sfld, n.tags, d.name AS deck
               FROM cards c JOIN notes n ON n.id = c.nid LEFT JOIN decks d ON d.id = c.did WHERE c.id IN (${chunk.map(() => '?').join(',')})`,
              chunk,
            )),
          );
        }
        const byId = new Map(rows.map((r) => [r.id, r]));
        const result = { ids, rows: page.map((id) => byId.get(id)).filter((r): r is Row => !!r), today: t.today, now: t.now, error: null as string | null };
        lastGood.current = result;
        return result;
      } catch (e) {
        if (!(e instanceof SearchError)) throw e;
        // Keep showing the last results while the search is being typed.
        return { ...(lastGood.current ?? { ids: [], rows: [], today: 0, now: 0 }), error: e.message };
      }
    },
    [fullQuery, sort.col, sort.desc, limit, currentDeckId],
    ['cards', 'notes', 'decks'],
  );

  const rows = data?.rows ?? [];
  const total = data?.ids.length ?? 0;
  const multiDeck = useMemo(() => new Set(rows.map((r) => r.did)).size > 1, [rows]);

  const toggle = (id: number) =>
    setSelection((s) => {
      const next = new Set(s ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size ? next : null;
    });

  return (
    <div className="page browse">
      <div className="dd-bar">
        {selection ? (
          <>
            <button className="dd-back" onClick={() => setSelection(null)}><Icon.close s={18} /> {selection.size.toLocaleString()} selected</button>
            <span style={{ flex: 1 }} />
            <Btn size="sm" onClick={() => setSelection(new Set(data?.ids ?? []))}>All {total > 0 ? `(${total.toLocaleString()})` : ''}</Btn>
            <Btn size="sm" variant="primary" onClick={() => setSheet({ cids: [...selection] })}>Actions</Btn>
          </>
        ) : (
          <>
            <button className="dd-back" onClick={onBack}><Icon.chevL s={18} /> {title}</button>
            <span style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 13 }}>{data ? `${total.toLocaleString()} card${total === 1 ? '' : 's'}` : ''}</span>
          </>
        )}
      </div>

      <div className="browse-search">
        <Icon.search s={16} />
        <input
          placeholder="Search (Anki syntax: deck:  tag:  is:due …)"
          value={input}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setQuery(input);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {input && <button className="icon-btn" aria-label="Clear search" onClick={() => setInput('')}><Icon.close s={15} /></button>}
        <button className="icon-btn" aria-label="Search help" onClick={() => setHelp(true)}>?</button>
      </div>
      {data?.error && <p className="browse-error">{data.error}</p>}

      <div className="browse-tools">
        <div className="chip-row">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <button key={f} className={'fchip' + (filter === f ? ' on' : '')} onClick={() => { setFilter(f); setLimit(PAGE); }}>{FILTERS[f][0]}</button>
          ))}
        </div>
        <div className="browse-sort">
          <select aria-label="Sort by" value={sort.col} onChange={(e) => setSort({ col: e.target.value as SortColumn, desc: sort.desc })}>
            {(Object.keys(SORT_COLUMNS) as SortColumn[]).map((c) => <option key={c} value={c}>{SORT_COLUMNS[c]}</option>)}
          </select>
          <button className="icon-btn" aria-label={sort.desc ? 'Descending' : 'Ascending'} title={sort.desc ? 'Descending' : 'Ascending'} onClick={() => setSort({ ...sort, desc: !sort.desc })}>
            {sort.desc ? '↓' : '↑'}
          </button>
        </div>
      </div>

      <div className="browse-list">
        {rows.map((r) => (
          <BrowseRow
            key={r.id}
            row={r}
            selected={selection?.has(r.id) ?? false}
            selecting={selection != null}
            meta={[multiDeck ? r.deck.split('::').pop() : null, dueLabel(r, data!.today, data!.now), sortValue(r, sort.col) ?? (r.type === 2 && r.queue >= 0 && sort.col !== 'due' ? `${r.ivl}d` : null)].filter(Boolean).join(' · ')}
            onTap={() => (selection ? toggle(r.id) : setSheet({ cids: [r.id], row: r }))}
            onLongPress={() => toggle(r.id)}
          />
        ))}
        {data && rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No cards match.</p>}
        {total > rows.length && rows.length >= limit && <Btn onClick={() => setLimit((l) => l + PAGE)} style={{ margin: '12px auto', display: 'flex' }}>Show more</Btn>}
      </div>
      {!selection && rows.length > 0 && <p className="muted browse-hint">Long-press a card to select several.</p>}

      {sheet && (
        <ActionsSheet
          cids={sheet.cids}
          row={sheet.row}
          onClose={() => setSheet(null)}
          onDeleted={() => setSelection(null)}
        />
      )}
      {help && <SearchHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

function BrowseRow({ row: r, selected, selecting, meta, onTap, onLongPress }: { row: Row; selected: boolean; selecting: boolean; meta: string; onTap: () => void; onLongPress: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <div
      className={'browse-row' + (r.queue === -1 ? ' suspended' : '') + (selected ? ' selected' : '')}
      onPointerDown={(e) => {
        longPressed.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        cancel();
        timer.current = setTimeout(() => {
          longPressed.current = true;
          navigator.vibrate?.(15);
          onLongPress();
        }, 450);
      }}
      onPointerMove={(e) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!longPressed.current) onLongPress();
        longPressed.current = true;
      }}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onTap();
      }}
    >
      {selecting && <span className={'br-check' + (selected ? ' on' : '')}>{selected && <Icon.check s={13} />}</span>}
      {(r.flags & 7) > 0 && <span className="flag-dot" style={{ background: FLAG_COLORS[r.flags & 7] }} />}
      <span className="br-text">
        <span className="br-main" lang="ja">{stripHtml(r.sfld).slice(0, 80) || '(empty)'}</span>
        <span className="br-meta">{meta}</span>
      </span>
    </div>
  );
}

type Sub = null | 'edit' | 'info' | 'due' | 'forget' | 'reposition' | 'deck' | 'delete' | 'addTags' | 'removeTags';

/** Actions on one card (with `row`) or on a selection. */
function ActionsSheet({ cids, row, onClose, onDeleted }: { cids: number[]; row?: Row; onClose: () => void; onDeleted: () => void }) {
  const [sub, setSub] = useState<Sub>(null);
  const one = row != null;
  const n = cids.length;
  const noun = one ? 'card' : `${n.toLocaleString()} card${n === 1 ? '' : 's'}`;
  const close = () => {
    setSub(null);
    onClose();
  };
  const run = async (f: () => Promise<unknown>) => {
    await f();
    onClose();
  };
  const notes = () => col.noteIdsOfCards(cids);
  const title = useMemo(() => (row ? stripHtml(row.sfld).slice(0, 40) || 'Card' : `${n.toLocaleString()} selected`), [row, n]);

  if (sub === 'edit' && row) return <EditNoteModal noteId={row.nid} onClose={close} />;
  if (sub === 'info' && row) return <CardInfoModal cardId={row.id} onClose={close} />;
  if (sub === 'due') {
    return (
      <PromptModal title={`Set due date (${noun})`} label="Days from today" initial="0" help="“0” = today, “3-7” = random day in range, add “!” to also set the interval." confirmLabel="Set" onClose={close}
        onSubmit={async (v) => { await col.setDueDate(cids, v); }} />
    );
  }
  if (sub === 'reposition') return <RepositionModal cids={cids} initial={row?.type === 0 ? row.due : 0} onClose={close} />;
  if (sub === 'forget') return <ForgetModal cids={cids} noun={noun} onClose={close} />;
  if (sub === 'delete') {
    return (
      <ConfirmModal title="Delete notes?" message={one ? 'The note and all its cards will be deleted.' : `The notes of the ${noun} selected, with all their cards, will be deleted.`} confirmLabel="Delete" danger onClose={close}
        onConfirm={async () => { await col.removeNotes(await notes()); onDeleted(); }} />
    );
  }
  if (sub === 'deck') return <DeckPickModal current={row?.did} onClose={close} onPick={(did) => run(() => col.moveCards(cids, did))} />;
  if (sub === 'addTags' || sub === 'removeTags') {
    const adding = sub === 'addTags';
    return (
      <TagsModal
        title={adding ? 'Add tags' : 'Remove tags'}
        confirmLabel={adding ? 'Add' : 'Remove'}
        onClose={close}
        onSubmit={async (tags) => {
          const nids = await notes();
          if (adding) await col.addTags(nids, tags);
          else await col.removeTags(nids, tags);
        }}
      />
    );
  }

  const flag = row ? row.flags & 7 : -1;
  const suspended = row ? row.queue === -1 : false;
  const buried = row ? row.queue === -2 || row.queue === -3 : false;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body sheet">
        {row && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {row.deck} · {row.reps} reviews · {row.lapses} lapses{row.stability != null ? ` · stability ${row.stability.toFixed(1)}d` : ''}
          </p>
        )}
        <div className="flag-row">
          {[1, 2, 3, 4, 5, 6, 7].map((f) => (
            <button key={f} aria-label={`${FLAG_NAMES[f]} flag`} title={FLAG_NAMES[f]} onClick={() => run(() => col.setFlag(cids, flag === f ? 0 : f))}
              style={{ background: FLAG_COLORS[f], outline: flag === f ? '2px solid var(--ink)' : 'none' }} />
          ))}
          {!one && <button className="flag-clear" onClick={() => run(() => col.setFlag(cids, 0))}>No flag</button>}
        </div>
        {one && <button className="sheet-item" onClick={() => setSub('edit')}><Icon.study s={16} /> Edit note</button>}
        {one && <button className="sheet-item" onClick={() => setSub('info')}><Icon.chart s={16} /> Card info</button>}
        {one ? (
          <>
            <button className="sheet-item" onClick={() => run(() => (suspended ? col.unburyOrUnsuspend(cids) : col.buryOrSuspend(cids, 'suspend')))}>
              <Icon.pause s={16} /> {suspended ? 'Unsuspend' : 'Suspend'}
            </button>
            <button className="sheet-item" onClick={() => run(() => (buried ? col.unburyOrUnsuspend(cids) : col.buryOrSuspend(cids, 'buryUser')))}>
              <Icon.moon s={16} /> {buried ? 'Unbury' : 'Bury'}
            </button>
          </>
        ) : (
          <>
            <button className="sheet-item" onClick={() => run(() => col.buryOrSuspend(cids, 'suspend'))}><Icon.pause s={16} /> Suspend</button>
            <button className="sheet-item" onClick={() => run(() => col.unburyOrUnsuspend(cids))}><Icon.review s={16} /> Unsuspend / unbury</button>
          </>
        )}
        <button className="sheet-item" onClick={() => setSub('deck')}><Icon.decks s={16} /> Change deck…</button>
        <button className="sheet-item" onClick={() => setSub('addTags')}><Icon.plus s={16} /> Add tags…</button>
        <button className="sheet-item" onClick={() => setSub('removeTags')}><Icon.close s={16} /> Remove tags…</button>
        <button className="sheet-item" onClick={() => setSub('due')}><Icon.clock s={16} /> Set due date…</button>
        {(!one || row!.type === 0) && <button className="sheet-item" onClick={() => setSub('reposition')}><Icon.chevR s={16} /> Reposition new cards…</button>}
        <button className="sheet-item" onClick={() => setSub('forget')}><Icon.undo s={16} /> Reset (Forget)…</button>
        <button className="sheet-item danger" onClick={() => setSub('delete')}><Icon.trash s={16} /> Delete {one ? 'note' : 'notes'}…</button>
      </div>
    </Modal>
  );
}

function DeckPickModal({ current, onPick, onClose }: { current?: number; onPick: (did: number) => void; onClose: () => void }) {
  const { data: decks } = useLive(async () => (await col.decks()).filter((d) => !d.filtered), [], ['decks']);
  const [q, setQ] = useState('');
  const list = (decks ?? []).filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal title="Change deck" onClose={onClose}>
      <div className="modal-body">
        {(decks?.length ?? 0) > 8 && <input className="deck-filter" placeholder="Filter decks" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />}
        {list.map((d) => (
          <button key={d.id} className={'deck-pick' + (d.id === current ? ' on' : '')} onClick={() => onPick(d.id)}>{d.name}</button>
        ))}
      </div>
    </Modal>
  );
}

function TagsModal({ title, confirmLabel, onSubmit, onClose }: { title: string; confirmLabel: string; onSubmit: (tags: string[]) => Promise<void>; onClose: () => void }) {
  const { data: all } = useLive(() => col.allTags(), [], ['notes']);
  return (
    <>
      <PromptModal
        title={title}
        label="Tags (separated by spaces)"
        confirmLabel={confirmLabel}
        onClose={onClose}
        onSubmit={async (v) => {
          const tags = v.split(/\s+/).filter(Boolean);
          if (!tags.length) return 'Enter at least one tag.';
          await onSubmit(tags);
        }}
        help={all?.length ? <>Tags in use: {all.slice(0, 40).join(', ')}{all.length > 40 ? '…' : ''}</> : undefined}
      />
    </>
  );
}

function RepositionModal({ cids, initial, onClose }: { cids: number[]; initial: number; onClose: () => void }) {
  const [start, setStart] = useState(String(initial));
  const [step, setStep] = useState('1');
  const [randomize, setRandomize] = useState(false);
  const [shift, setShift] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Reposition new cards" onClose={onClose}>
      <div className="modal-body">
        <label className="opt-field col"><span>Start position</span><input inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="opt-field col"><span>Step</span><input inputMode="numeric" value={step} onChange={(e) => setStep(e.target.value)} /></label>
        <label className="opt-check"><input type="checkbox" checked={randomize} onChange={(e) => setRandomize(e.target.checked)} /> Randomize order</label>
        <label className="opt-check"><input type="checkbox" checked={shift} onChange={(e) => setShift(e.target.checked)} /> Shift position of existing cards</label>
        <p className="muted" style={{ fontSize: 12 }}>Only new cards are moved.</p>
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          onClick={async () => {
            const s = Number(start);
            const st = Number(step);
            if (!Number.isInteger(s) || s < 0 || !Number.isInteger(st) || st < 1) return setErr('Enter whole numbers (step at least 1).');
            await col.repositionNew(cids, s, st, randomize, shift);
            onClose();
          }}
        >
          Reposition
        </Btn>
      </div>
    </Modal>
  );
}

function ForgetModal({ cids, noun, onClose }: { cids: number[]; noun: string; onClose: () => void }) {
  const [restore, setRestore] = useState(true);
  const [reset, setReset] = useState(false);
  return (
    <Modal title="Reset cards?" onClose={onClose}>
      <div className="modal-body">
        <p style={{ marginTop: 0, color: 'var(--ink-soft)', lineHeight: 1.55 }}>Return the {noun} to the new queue. Review history is kept.</p>
        <label className="opt-check"><input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} /> Restore original position where possible</label>
        <label className="opt-check"><input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} /> Reset repetition and lapse counts</label>
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={async () => { await col.forget(cids, { resetCounts: reset, restorePosition: restore }); onClose(); }}>Reset</Btn>
      </div>
    </Modal>
  );
}

const HELP: [string, string][] = [
  ['dog', 'notes containing “dog”'],
  ['dog cat', 'both words'],
  ['dog or cat', 'either word'],
  ['-cat', 'without “cat”'],
  ['"a dog"', 'the exact phrase'],
  ['d*g  d_g', '* = any run of characters, _ = one'],
  ['front:dog', 'the Front field is exactly “dog” (front:*dog* contains it)'],
  ['deck:Japanese', 'a deck and its subdecks (quote names with spaces)'],
  ['tag:n5', 'tagged n5 (or a child tag like n5::verbs); tag:none'],
  ['note:Basic  card:2', 'by note type, by card number or template name'],
  ['is:due  is:new  is:learn  is:review', 'by state'],
  ['is:suspended  is:buried', ''],
  ['flag:1', 'red flag (0 = none, 1–7 colours)'],
  ['prop:ivl>=30', 'also due, reps, lapses, ease, pos, s (stability), d (difficulty)'],
  ['rated:7  rated:7:1', 'answered in the last 7 days (with Again)'],
  ['added:7  edited:7  introduced:7', 'added / edited / first studied in the last 7 days'],
  ['re:\\d{3}  front:re:^a', 'regular expressions'],
];

function SearchHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Searching" onClose={onClose}>
      <div className="modal-body">
        <dl className="search-help">
          {HELP.map(([k, v]) => (
            <div key={k}>
              <dt><code>{k}</code></dt>
              {v && <dd>{v}</dd>}
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}
