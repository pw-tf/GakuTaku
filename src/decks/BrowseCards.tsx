import { useMemo, useState } from 'react';
import { appSql, col } from '../anki/appCollection';
import { stripHtml } from '../anki/template';
import { timingAt } from '../anki/timing';
import { useBackHandler } from '../app/back';
import { useLive } from '../db/useLive';
import { FLAG_COLORS, FLAG_NAMES } from '../study/ReviewScreen';
import { EditNoteModal } from '../study/EditNoteModal';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { ConfirmModal, Modal, PromptModal } from '../ui/Modal';

/** Anki's Browse screen, scoped to a deck and its subdecks. */

type Filter = 'all' | 'new' | 'learning' | 'review' | 'due' | 'suspended' | 'buried' | 'flagged' | 'leech';
const FILTERS: Record<Filter, string> = {
  all: 'All', due: 'Due', new: 'New', learning: 'Learning', review: 'Review', suspended: 'Suspended', buried: 'Buried', flagged: 'Flagged', leech: 'Leeches',
};

interface Row {
  id: number;
  nid: number;
  did: number;
  ord: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  flags: number;
  reps: number;
  lapses: number;
  stability: number | null;
  sfld: string;
  tags: string;
  deck: string;
}

const PAGE = 150;

function dueLabel(r: Row, today: number, nowSecs: number): string {
  if (r.queue === -1) return 'Suspended';
  if (r.queue === -2 || r.queue === -3) return 'Buried';
  if (r.type === 0) return `New #${r.due}`;
  if (r.queue === 1 || r.queue === 4) {
    const mins = Math.max(0, Math.round((r.due - nowSecs) / 60));
    return mins < 1 ? 'Now' : mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
  }
  const days = r.due - today;
  if (days <= 0) return days === 0 ? 'Today' : `${-days}d overdue`;
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

export function BrowseCards({ deckId, deckName, onBack }: { deckId: number; deckName: string; onBack: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Row | null>(null);
  useBackHandler(true, onBack);

  const { data } = useLive(
    async () => {
      const cfg = await col.config();
      const t = timingAt(Date.now(), cfg.rollover);
      const decks = await col.decks();
      const root = decks.find((d) => d.id === deckId);
      const ids = decks.filter((d) => d.id === deckId || (root && d.name.toLowerCase().startsWith(root.name.toLowerCase() + '::'))).map((d) => d.id);
      const ph = ids.map(() => '?').join(',');
      const where: string[] = [`c.did IN (${ph})`];
      const params: unknown[] = [...ids];
      switch (filter) {
        case 'new': where.push('c.type = 0 AND c.queue >= 0'); break;
        case 'learning': where.push('c.type IN (1, 3) AND c.queue >= 0'); break;
        case 'review': where.push('c.type = 2 AND c.queue >= 0'); break;
        case 'due': where.push('((c.queue IN (2, 3) AND c.due <= ?) OR (c.queue IN (1, 4) AND c.due <= ?))'); params.push(t.today, t.now + cfg.learnAheadSecs); break;
        case 'suspended': where.push('c.queue = -1'); break;
        case 'buried': where.push('c.queue IN (-2, -3)'); break;
        case 'flagged': where.push('(c.flags & 7) != 0'); break;
        case 'leech': where.push("(' ' || lower(n.tags) || ' ') LIKE '% leech %'"); break;
      }
      const q = search.trim();
      if (q) {
        where.push('(n.flds LIKE ? OR n.tags LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      const rows = await appSql.all<Row>(
        `SELECT c.id, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.ivl, c.flags, c.reps, c.lapses, c.stability, n.sfld, n.tags, d.name AS deck
         FROM cards c JOIN notes n ON n.id = c.nid LEFT JOIN decks d ON d.id = c.did
         WHERE ${where.join(' AND ')} ORDER BY n.sfld COLLATE NOCASE, c.ord LIMIT ?`,
        [...params, limit + 1],
      );
      return { rows, today: t.today, now: t.now };
    },
    [deckId, filter, search, limit],
    ['cards', 'notes', 'decks'],
  );

  const rows = data?.rows.slice(0, limit) ?? [];
  const more = (data?.rows.length ?? 0) > limit;

  return (
    <div className="page">
      <div className="dd-bar">
        <button className="dd-back" onClick={onBack}><Icon.chevL s={18} /> {deckName.split('::').pop()}</button>
      </div>
      <div className="browse-search">
        <Icon.search s={16} />
        <input placeholder="Search this deck" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }} />
      </div>
      <div className="chip-row">
        {(Object.keys(FILTERS) as Filter[]).map((f) => (
          <button key={f} className={'fchip' + (filter === f ? ' on' : '')} onClick={() => { setFilter(f); setLimit(PAGE); }}>{FILTERS[f]}</button>
        ))}
      </div>
      <div className="browse-list">
        {rows.map((r) => (
          <div key={r.id} className={'browse-row' + (r.queue === -1 ? ' suspended' : '')} onClick={() => setSelected(r)}>
            {(r.flags & 7) > 0 && <span className="flag-dot" style={{ background: FLAG_COLORS[r.flags & 7] }} />}
            <span className="br-main" lang="ja">{stripHtml(r.sfld).slice(0, 80) || '(empty)'}</span>
            <span className="br-meta">{dueLabel(r, data!.today, data!.now)}{r.type === 2 && r.queue >= 0 ? ` · ${r.ivl}d` : ''}</span>
          </div>
        ))}
        {data && rows.length === 0 && <p className="muted" style={{ padding: 16 }}>No cards match.</p>}
        {more && <Btn onClick={() => setLimit((l) => l + PAGE)} style={{ margin: '12px auto', display: 'flex' }}>Show more</Btn>}
      </div>
      {selected && <CardActions row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

type Sub = null | 'edit' | 'due' | 'forget' | 'reposition' | 'deck' | 'delete';

function CardActions({ row, onClose }: { row: Row; onClose: () => void }) {
  const [sub, setSub] = useState<Sub>(null);
  const decksQ = useLive(() => col.decks(), [], ['decks']);
  const suspended = row.queue === -1;
  const buried = row.queue === -2 || row.queue === -3;
  const close = () => {
    setSub(null);
    onClose();
  };
  const title = useMemo(() => stripHtml(row.sfld).slice(0, 40) || 'Card', [row.sfld]);

  if (sub === 'edit') return <EditNoteModal noteId={row.nid} onClose={close} />;
  if (sub === 'due') {
    return (
      <PromptModal title="Set due date" label="Days from today" initial="0" help="“0” = today, “3-7” = random day in range, add “!” to also set the interval." confirmLabel="Set" onClose={close}
        onSubmit={async (v) => { await col.setDueDate([row.id], v); }} />
    );
  }
  if (sub === 'reposition') {
    return (
      <PromptModal title="Reposition new card" label="Position" initial={String(row.due)} help="Other new cards keep their positions." confirmLabel="Reposition" onClose={close}
        onSubmit={async (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) return 'Enter a position.'; await col.repositionNew([row.id], Math.round(n), 1, false, false); }} />
    );
  }
  if (sub === 'forget') {
    return (
      <ConfirmModal title="Reset card?" message="Return the card to the end of the new queue. Review history is kept." confirmLabel="Reset" onClose={close}
        onConfirm={() => col.forget([row.id], { resetCounts: false, restorePosition: true })} />
    );
  }
  if (sub === 'delete') {
    return <ConfirmModal title="Delete note?" message="The note and all its cards will be deleted." confirmLabel="Delete" danger onClose={close} onConfirm={() => col.removeNotes([row.nid])} />;
  }
  if (sub === 'deck') {
    return (
      <Modal title="Change deck" onClose={close}>
        <div className="modal-body">
          {(decksQ.data ?? []).map((d) => (
            <button key={d.id} className={'deck-pick' + (d.id === row.did ? ' on' : '')} onClick={async () => { await col.moveCards([row.id], d.id); close(); }}>{d.name}</button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body sheet">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {row.deck} · {row.reps} reviews · {row.lapses} lapses{row.stability != null ? ` · stability ${row.stability.toFixed(1)}d` : ''}
        </p>
        <div className="flag-row">
          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
            <button key={n} aria-label={`${FLAG_NAMES[n]} flag`} title={FLAG_NAMES[n]} onClick={async () => { await col.setFlag([row.id], (row.flags & 7) === n ? 0 : n); onClose(); }}
              style={{ background: FLAG_COLORS[n], outline: (row.flags & 7) === n ? '2px solid var(--ink)' : 'none' }} />
          ))}
        </div>
        <button className="sheet-item" onClick={() => setSub('edit')}><Icon.study s={16} /> Edit note</button>
        <button className="sheet-item" onClick={async () => { if (suspended) await col.unburyOrUnsuspend([row.id]); else await col.buryOrSuspend([row.id], 'suspend'); onClose(); }}>
          <Icon.pause s={16} /> {suspended ? 'Unsuspend' : 'Suspend'}
        </button>
        <button className="sheet-item" onClick={async () => { if (buried) await col.unburyOrUnsuspend([row.id]); else await col.buryOrSuspend([row.id], 'buryUser'); onClose(); }}>
          <Icon.moon s={16} /> {buried ? 'Unbury' : 'Bury'}
        </button>
        <button className="sheet-item" onClick={() => setSub('due')}><Icon.clock s={16} /> Set due date…</button>
        {row.type === 0 && <button className="sheet-item" onClick={() => setSub('reposition')}><Icon.chevR s={16} /> Reposition…</button>}
        <button className="sheet-item" onClick={() => setSub('forget')}><Icon.undo s={16} /> Reset (Forget)…</button>
        <button className="sheet-item" onClick={() => setSub('deck')}><Icon.decks s={16} /> Change deck…</button>
        <button className="sheet-item danger" onClick={() => setSub('delete')}><Icon.trash s={16} /> Delete note…</button>
      </div>
    </Modal>
  );
}
