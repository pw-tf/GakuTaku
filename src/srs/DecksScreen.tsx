import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../sync/system';
import { useAuth } from '../auth/AuthProvider';
import { Btn, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { importFile, useImporting } from '../import/runImport';
import { useDeckCards, useDeckStats, type CardRow, type DeckStat } from './srsHooks';
import { buildDeckTree, descendantDeckIds, findNodeByDeckId, flattenVisible, type DeckNode } from './deckTree';
import { EditCardModal } from './EditCardModal';
import { DEFAULT_MAXIMUM_INTERVAL, cardStateLabel, deckConfig, formatInterval, serializeDeckConfig, type DeckConfig } from './fsrs';
import { addCardForWord, createDeck, deleteDeck, renameDeck } from './mining';
import { saveDeckOverrides } from './presetOps';
import { optimizeDeck } from '../analytics/optimizer';

interface Props {
  onReviewDeck: (deck: DeckStat, deckIds: string[]) => void;
}

/** Merge a config patch into a deck's fsrs_params, preserving anything not touched (e.g. weights). */
async function updateDeckConfig(deckId: string, patch: Partial<DeckConfig>): Promise<void> {
  const rows = await db.getAll<{ fsrs_params: string | null }>(
    'SELECT fsrs_params FROM decks WHERE id = ?',
    [deckId],
  );
  const cfg = deckConfig({ fsrs_params: rows[0]?.fsrs_params ?? null });
  await db.execute('UPDATE decks SET fsrs_params = ? WHERE id = ?', [
    serializeDeckConfig({ ...cfg, ...patch }),
    deckId,
  ]);
}

/** "1m 10m" / "1m, 10m" → ['1m','10m']; empty → undefined (use FSRS defaults). */
function parseSteps(text: string): string[] | undefined {
  const steps = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return steps.length ? steps : undefined;
}

// ---------------------------------------------------------------------------
// Top-level screen: deck grid, or a single deck's detail view.
// ---------------------------------------------------------------------------

export function DecksScreen({ onReviewDeck }: Props) {
  const { decks, loading } = useDeckStats();
  const roots = useMemo(() => buildDeckTree(decks), [decks]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? decks.find((d) => d.id === selectedId) ?? null : null;

  // If the open deck disappears (deleted), fall back to the list.
  useEffect(() => {
    if (selectedId && decks.length && !decks.some((d) => d.id === selectedId)) setSelectedId(null);
  }, [decks, selectedId]);

  if (selected) {
    const node = findNodeByDeckId(roots, selected.id);
    const studyIds = node ? descendantDeckIds(node) : [selected.id];
    return (
      <DeckDetail
        deck={selected}
        childNodes={node?.children ?? []}
        onBack={() => setSelectedId(null)}
        onOpenDeck={setSelectedId}
        onReview={() => onReviewDeck(selected, studyIds)}
      />
    );
  }
  return <DeckList roots={roots} deckCount={decks.length} loading={loading} onOpen={(d) => setSelectedId(d.id)} />;
}

// ---------------------------------------------------------------------------
// Deck tree (Anki-style) + create/upload.
// ---------------------------------------------------------------------------

function DeckCounts({ roll }: { roll: DeckNode['roll'] }) {
  return (
    <span className="dr-counts">
      <span className="c new" title="New">{roll.new}</span>
      <span className="c learn" title="Learning">{roll.learning}</span>
      <span className="c due" title="Due">{roll.due}</span>
    </span>
  );
}

function DeckList({ roots, deckCount, loading, onOpen }: { roots: DeckNode[]; deckCount: number; loading: boolean; onOpen: (d: DeckStat) => void }) {
  const { session } = useAuth();
  const importing = useImporting();
  const fileRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const rows = useMemo(() => flattenVisible(roots, collapsed), [roots, collapsed]);

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function addDeck() {
    const userId = session?.user.id;
    if (!userId || creating) return;
    const name = window.prompt('New deck name (use “Parent::Child” for a subdeck)', 'New deck');
    if (name === null) return;
    setCreating(true);
    try {
      await createDeck(userId, name.trim() || 'New deck');
    } finally {
      setCreating(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !session) return;
    e.target.value = '';
    await importFile(file, session.user.id);
  }

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept=".apkg" hidden onChange={onFile} />
      <div className="sec-bar">
        <h2>Decks</h2>
        <span className="count">{loading ? '…' : `${deckCount} ${deckCount === 1 ? 'deck' : 'decks'}`}</span>
        <span className="more deck-add">
          <Btn size="sm" disabled={creating || importing} onClick={() => setMenuOpen((o) => !o)}>
            <Icon.plus s={15} /> New deck
          </Btn>
          {menuOpen && (
            <>
              <div className="popmenu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="popmenu">
                <button onClick={() => { setMenuOpen(false); void addDeck(); }}>
                  <Icon.plus s={15} /> Create empty deck
                </button>
                <button onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>
                  <Icon.upload s={15} /> Upload Anki deck (.apkg)
                </button>
              </div>
            </>
          )}
        </span>
      </div>

      {loading ? (
        <div className="deck-loading"><Spinner size={26} /></div>
      ) : deckCount === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>
          No decks yet. Open a book, tap a word, and ＋ Add to deck — or import an Anki deck above.
        </p>
      ) : (
        <div className="deck-tree">
          {rows.map((node) => {
            const hasChildren = node.children.length > 0;
            const isCollapsed = collapsed.has(node.key);
            return (
              <div
                key={node.key}
                className={'deck-row' + (node.deck ? '' : ' group')}
                style={{ paddingLeft: 14 + node.depth * 20 }}
                onClick={() => (node.deck ? onOpen(node.deck) : toggle(node.key))}
              >
                <button
                  className={'dr-caret' + (hasChildren ? '' : ' empty')}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(node.key); }}
                >
                  {hasChildren ? <Icon.chevR s={14} style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s' }} /> : null}
                </button>
                <span className="dr-name">{node.label}</span>
                <DeckCounts roll={node.roll} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single deck: actions menu + scoped card browser.
// ---------------------------------------------------------------------------

type Modal = null | 'options' | 'description' | 'add';

function DeckDetail({ deck, childNodes, onBack, onOpenDeck, onReview }: {
  deck: DeckStat;
  childNodes: DeckNode[];
  onBack: () => void;
  onOpenDeck: (id: string) => void;
  onReview: () => void;
}) {
  const { session } = useAuth();
  const cards = useDeckCards(deck.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  function rename() {
    const name = window.prompt('Rename deck', deck.name);
    if (name && name.trim() && name.trim() !== deck.name) void renameDeck(deck.id, name);
  }
  function confirmDelete() {
    if (window.confirm(`Delete “${deck.name}” and its ${deck.total} card${deck.total === 1 ? '' : 's'}? This cannot be undone.`)) {
      void deleteDeck(deck.id);
      onBack();
    }
  }

  const MENU: { label: string; icon: keyof typeof Icon; run: () => void; danger?: boolean }[] = [
    { label: 'Add card', icon: 'plus', run: () => setModal('add') },
    { label: 'Rename deck', icon: 'study', run: rename },
    { label: 'Edit description', icon: 'reader', run: () => setModal('description') },
    { label: 'Deck options', icon: 'gear', run: () => setModal('options') },
    { label: 'Delete deck', icon: 'trash', run: confirmDelete, danger: true },
  ];

  return (
    <div className="page">
      <div className="dd-bar">
        <button className="dd-back" onClick={onBack}><Icon.chevL s={18} /> Decks</button>
        <span style={{ flex: 1 }} />
        <span className="deck-add">
          <Btn size="sm" onClick={() => setMenuOpen((o) => !o)}><Icon.gear s={15} /> Options</Btn>
          {menuOpen && (
            <>
              <div className="popmenu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="popmenu">
                {MENU.map((m) => (
                  <button key={m.label} className={m.danger ? 'danger' : ''} onClick={() => { setMenuOpen(false); m.run(); }}>
                    {(() => { const I = Icon[m.icon]; return <I s={15} />; })()} {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </span>
      </div>

      <div className="dd-head">
        <h2 className="dd-name">{deck.name}</h2>
        {deck.cfg.description && <p className="dd-desc">{deck.cfg.description}</p>}
        <div className="dd-stats">
          <span><b>{deck.new}</b> new</span>
          <span><b>{deck.learning}</b> learning</span>
          <span><b>{deck.due}</b> due</span>
          <span className="muted">{deck.total} cards · {deck.cfg.newPerDay}/day new · {deck.cfg.reviewsPerDay}/day reviews</span>
        </div>
        <div className="dd-actions">
          <Btn variant="primary" onClick={onReview} disabled={deck.new + deck.learning + deck.due === 0}>
            <Icon.review s={16} /> Study now{childNodes.length ? ' (incl. subdecks)' : ''}
          </Btn>
          <Btn onClick={() => setModal('add')}><Icon.plus s={15} /> Add card</Btn>
        </div>
      </div>

      {childNodes.length > 0 && (
        <>
          <div className="sec-bar"><h2>Subdecks</h2><span className="count">{childNodes.length}</span></div>
          <div className="deck-tree">
            {childNodes.map((c) => (
              <div
                key={c.key}
                className={'deck-row' + (c.deck ? '' : ' group')}
                onClick={() => c.deck && onOpenDeck(c.deck.id)}
              >
                <span className="dr-caret empty" />
                <span className="dr-name">{c.label}</span>
                <DeckCounts roll={c.roll} />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sec-bar">
        <h2>Cards</h2>
        <span className="count">{cards.length} {cards.length === 1 ? 'card' : 'cards'}</span>
      </div>
      <CardTable cards={cards} onEdit={setEditingCardId} />

      {modal === 'options' && <DeckOptionsModal deck={deck} onClose={() => setModal(null)} />}
      {modal === 'description' && <DescriptionModal deck={deck} onClose={() => setModal(null)} />}
      {modal === 'add' && session && (
        <AddCardModal deckId={deck.id} userId={session.user.id} onClose={() => setModal(null)} />
      )}
      {editingCardId && <EditCardModal cardId={editingCardId} onClose={() => setEditingCardId(null)} />}
    </div>
  );
}

function CardTable({ cards, onEdit }: { cards: CardRow[]; onEdit: (cardId: string) => void }) {
  const now = Date.now();
  if (cards.length === 0) return <p style={{ color: 'var(--ink-faint)' }}>No cards in this deck yet.</p>;
  return (
    <table className="card-table clickable">
      <thead>
        <tr>
          <th>Front</th>
          <th className="hide-sm">Back</th>
          <th>State</th>
          <th className="hide-sm">Due</th>
        </tr>
      </thead>
      <tbody>
        {cards.map((c) => {
          const state = cardStateLabel({
            state: c.state,
            reps: c.reps,
            due: new Date(c.due ?? now),
            last_review: c.last_review ? new Date(c.last_review) : null,
          });
          const dueText = c.reps === 0 ? 'new' : !c.due ? '—' : new Date(c.due).getTime() <= now ? 'due' : formatInterval(new Date(now), new Date(c.due));
          return (
            <tr key={c.id} onClick={() => onEdit(c.id)} title="Edit card">
              <td>
                <span className="ct-term" lang="ja">{c.front || '—'}</span>
                {c.reading && <> <span className="ct-reading" lang="ja">{c.reading}</span></>}
              </td>
              <td className="hide-sm" style={{ color: 'var(--ink-soft)' }}>{c.back}</td>
              <td><span className={'state-pill state-' + state}>{state}</span></td>
              <td className="hide-sm" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-faint)' }}>{dueText}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Modals.
// ---------------------------------------------------------------------------

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}><Icon.close s={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeckOptionsModal({ deck, onClose }: { deck: DeckStat; onClose: () => void }) {
  const [newPerDay, setNewPerDay] = useState(String(deck.cfg.newPerDay));
  const [reviewsPerDay, setReviewsPerDay] = useState(String(deck.cfg.reviewsPerDay));
  const [learn, setLearn] = useState((deck.cfg.learningSteps ?? []).join(' '));
  const [relearn, setRelearn] = useState((deck.cfg.relearningSteps ?? []).join(' '));
  const [retention, setRetention] = useState(String(Math.round(deck.cfg.desiredRetention * 100)));
  const [maxIvl, setMaxIvl] = useState(String(deck.cfg.maximumInterval));

  async function save() {
    // Anki clamps desired retention to 0.70–0.99.
    const dr = Math.min(0.99, Math.max(0.7, (parseInt(retention || '90', 10) || 90) / 100));
    await updateDeckConfig(deck.id, {
      newPerDay: Math.max(0, parseInt(newPerDay || '0', 10) || 0),
      reviewsPerDay: Math.max(0, parseInt(reviewsPerDay || '0', 10) || 0),
      learningSteps: parseSteps(learn),
      relearningSteps: parseSteps(relearn),
      desiredRetention: dr,
      maximumInterval: Math.max(1, parseInt(maxIvl || '0', 10) || DEFAULT_MAXIMUM_INTERVAL),
    });
    onClose();
  }

  return (
    <Modal title="Deck options" onClose={onClose}>
      <div className="modal-body">
        <label className="opt-field">
          <span>New cards / day</span>
          <input type="number" min={0} value={newPerDay} onChange={(e) => setNewPerDay(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Maximum reviews / day</span>
          <input type="number" min={0} value={reviewsPerDay} onChange={(e) => setReviewsPerDay(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Learning steps</span>
          <input value={learn} placeholder="1m 10m" onChange={(e) => setLearn(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Relearning steps</span>
          <input value={relearn} placeholder="10m" onChange={(e) => setRelearn(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Desired retention (%)</span>
          <input type="number" min={70} max={99} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Maximum interval (days)</span>
          <input type="number" min={1} value={maxIvl} onChange={(e) => setMaxIvl(e.target.value)} />
        </label>
        <OptimizeRow deck={deck} />
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => void save()}>Save</Btn>
      </div>
    </Modal>
  );
}

/** Trains personalized FSRS weights from this deck's review history and writes them to fsrs_params. */
function OptimizeRow({ deck }: { deck: DeckStat }) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setRunning(true);
    setMsg(null);
    try {
      const r = await optimizeDeck(deck.id);
      setMsg(r.ok
        ? { ok: true, text: `Optimized from ${r.reviewCount} reviews — weights saved.` }
        : { ok: false, text: r.reason ?? 'Could not optimize.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message ?? 'Optimization failed.' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="opt-optimize">
      <button className="dc-opt-btn" disabled={running} onClick={() => void run()}>
        {running ? 'Optimizing…' : 'Optimize FSRS weights from history'}
      </button>
      {msg && <span className={'dc-opt-msg' + (msg.ok ? ' ok' : ' err')}>{msg.text}</span>}
    </div>
  );
}

function DescriptionModal({ deck, onClose }: { deck: DeckStat; onClose: () => void }) {
  const [text, setText] = useState(deck.cfg.description ?? '');
  async function save() {
    await saveDeckOverrides(deck.id, { description: text.trim() || undefined });
    onClose();
  }
  return (
    <Modal title="Edit description" onClose={onClose}>
      <div className="modal-body">
        <textarea
          className="opt-textarea"
          rows={4}
          value={text}
          placeholder="A note about this deck…"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => void save()}>Save</Btn>
      </div>
    </Modal>
  );
}

function AddCardModal({ deckId, userId, onClose }: { deckId: string; userId: string; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [reading, setReading] = useState('');
  const [meaning, setMeaning] = useState('');
  const [pos, setPos] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!term.trim()) { setErr('A term is required.'); return; }
    setSaving(true);
    setErr(null);
    try {
      await addCardForWord(userId, { deckId, term: term.trim(), reading: reading.trim(), gloss: meaning.trim(), pos: pos.trim() });
      onClose();
    } catch (e) {
      setErr((e as Error)?.message ?? 'Could not add card.');
      setSaving(false);
    }
  }

  return (
    <Modal title="Add card" onClose={onClose}>
      <div className="modal-body">
        <label className="opt-field col"><span>Term</span>
          <input lang="ja" value={term} autoFocus onChange={(e) => setTerm(e.target.value)} /></label>
        <label className="opt-field col"><span>Reading</span>
          <input lang="ja" value={reading} onChange={(e) => setReading(e.target.value)} /></label>
        <label className="opt-field col"><span>Meaning</span>
          <input value={meaning} onChange={(e) => setMeaning(e.target.value)} /></label>
        <label className="opt-field col"><span>Part of speech</span>
          <input value={pos} onChange={(e) => setPos(e.target.value)} /></label>
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Adding…' : 'Add card'}</Btn>
      </div>
    </Modal>
  );
}
