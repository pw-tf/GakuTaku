import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useQuery } from '../sync/hooks';
import { Btn, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { importFile, useImporting } from '../import/runImport';
import { useDeckCards, useDeckStats, type CardRow, type DeckCardsFilter, type DeckStat } from './srsHooks';
import { buildDeckTree, descendantDeckIds, findNodeByDeckId, flattenVisible, type DeckNode } from './deckTree';
import { EditCardModal } from './EditCardModal';
import { cardStateLabel, formatInterval } from './fsrs';
import { addCardForWord, createDeck, deleteDeck, renameDeck } from './mining';
import {
  GATHER_PRIORITY_LABELS,
  INSERTION_ORDER_LABELS,
  LEECH_ACTION_LABELS,
  NEW_SORT_ORDER_LABELS,
  REVIEW_MIX_LABELS,
  REVIEW_SORT_ORDER_LABELS,
  parsePresetConfig,
  type DeckPresetConfig,
  type InsertionOrder,
  type LeechAction,
  type NewGatherPriority,
  type NewSortOrder,
  type ReviewMix,
  type ReviewSortOrder,
} from './presets';
import {
  assignPreset,
  createPreset,
  deletePreset,
  ensureDefaultPreset,
  renamePreset,
  saveDeckOverrides,
  savePresetConfig,
} from './presetOps';
import { buryCards, forgetCards, repositionNew, setDueDate, setFlag, suspendCards, unburyCards, unburyDecks, unsuspendCards } from './cardOps';
import { FLAG_COLORS, FLAG_NAMES, parseDueDateSpec } from './cardPlans';
import { optimizeDeck, optimizePreset } from '../analytics/optimizer';

interface Props {
  onReviewDeck: (deck: DeckStat, deckIds: string[]) => void;
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
  const [filter, setFilter] = useState<DeckCardsFilter>({ status: 'all' });
  const cards = useDeckCards(deck.id, filter);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const userId = session?.user.id ?? '';

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
          {deck.buried > 0 && (
            <Btn onClick={() => void unburyDecks([deck.id])} title="Return this deck's buried cards to the queue">
              <Icon.moon s={15} /> Unbury ({deck.buried})
            </Btn>
          )}
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
      <CardFilterBar filter={filter} onChange={setFilter} />
      <CardTable cards={cards} userId={userId} onEdit={setEditingCardId} />

      {modal === 'options' && <DeckOptionsModal deck={deck} onClose={() => setModal(null)} />}
      {modal === 'description' && <DescriptionModal deck={deck} onClose={() => setModal(null)} />}
      {modal === 'add' && session && (
        <AddCardModal deckId={deck.id} userId={session.user.id} onClose={() => setModal(null)} />
      )}
      {editingCardId && <EditCardModal cardId={editingCardId} onClose={() => setEditingCardId(null)} />}
    </div>
  );
}

/** Anki-browser-style filter chips: All · the 7 flags · Suspended · Buried. */
function CardFilterBar({ filter, onChange }: { filter: DeckCardsFilter; onChange: (f: DeckCardsFilter) => void }) {
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 12.5,
    cursor: 'pointer',
    border: '1px solid var(--line)',
    background: on ? 'var(--ink)' : 'transparent',
    color: on ? 'var(--paper)' : 'var(--ink-soft)',
  });
  const isAll = !filter.flag && (filter.status ?? 'all') === 'all';
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '2px 0 10px' }}>
      <button style={chip(isAll)} onClick={() => onChange({ status: 'all' })}>All</button>
      {[1, 2, 3, 4, 5, 6, 7].map((n) => (
        <button
          key={n}
          title={FLAG_NAMES[n]}
          style={{ ...chip(filter.flag === n), display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => onChange(filter.flag === n ? { status: 'all' } : { flag: n, status: 'all' })}
        >
          <span style={{ width: 9, height: 9, borderRadius: 3, background: FLAG_COLORS[n], display: 'inline-block' }} />
          {FLAG_NAMES[n]}
        </button>
      ))}
      <button
        style={chip(filter.status === 'suspended')}
        onClick={() => onChange(filter.status === 'suspended' ? { status: 'all' } : { status: 'suspended' })}
      >
        Suspended
      </button>
      <button
        style={chip(filter.status === 'buried')}
        onClick={() => onChange(filter.status === 'buried' ? { status: 'all' } : { status: 'buried' })}
      >
        Buried
      </button>
    </div>
  );
}

/** The status shown in the table: user state (suspended/buried) overrides the maturity label. */
function cardStatus(c: CardRow, now: number): { label: string; cls: string } {
  if (c.queue === -1) return { label: 'suspended', cls: 'suspended' };
  if (c.queue <= -2 && c.buried_until && new Date(c.buried_until).getTime() > now) return { label: 'buried', cls: 'buried' };
  const label = cardStateLabel({
    state: c.state,
    reps: c.reps,
    due: new Date(c.due ?? now),
    last_review: c.last_review ? new Date(c.last_review) : null,
  });
  return { label, cls: label };
}

function CardRowMenu({ card, userId, onClose }: { card: CardRow; userId: string; onClose: () => void }) {
  const now = Date.now();
  const suspended = card.queue === -1;
  const buried = card.queue <= -2 && !!card.buried_until && new Date(card.buried_until).getTime() > now;
  const run = (fn: () => Promise<void>) => {
    onClose();
    void fn();
  };
  return (
    <>
      <div className="popmenu-backdrop" onClick={onClose} />
      <div className="popmenu" style={{ right: 0 }}>
        <div style={{ display: 'flex', gap: 6, padding: '8px 12px', alignItems: 'center' }}>
          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
            <button
              key={n}
              title={FLAG_NAMES[n]}
              onClick={() => run(() => setFlag([card.id], card.flag === n ? 0 : n))}
              style={{
                width: 18,
                height: 18,
                borderRadius: 5,
                border: card.flag === n ? '2px solid var(--ink)' : '1px solid transparent',
                background: FLAG_COLORS[n],
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>
        {suspended ? (
          <button onClick={() => run(() => unsuspendCards([card.id]))}><Icon.pause s={15} /> Unsuspend</button>
        ) : (
          <button onClick={() => run(() => suspendCards([card.id]))}><Icon.pause s={15} /> Suspend</button>
        )}
        {buried ? (
          <button onClick={() => run(() => unburyCards([card.id]))}><Icon.moon s={15} /> Unbury</button>
        ) : (
          <button onClick={() => run(() => buryCards([card.id], { manual: true }))}><Icon.moon s={15} /> Bury until tomorrow</button>
        )}
        <button
          onClick={() => {
            const raw = window.prompt('Set due date: days from now (e.g. “5”), or a range (e.g. “3-7”)', '1');
            const spec = raw != null ? parseDueDateSpec(raw) : null;
            if (spec) run(() => setDueDate(userId, [card.id], spec));
            else onClose();
          }}
        >
          <Icon.clock s={15} /> Set due date…
        </button>
        {card.reps === 0 ? (
          <button
            onClick={() => {
              const raw = window.prompt('Reposition: new position number', String(card.position ?? 0));
              const start = raw != null ? parseInt(raw, 10) : NaN;
              if (Number.isFinite(start)) run(() => repositionNew([card.id], start));
              else onClose();
            }}
          >
            <Icon.study s={15} /> Reposition…
          </button>
        ) : (
          <button className="danger" onClick={() => run(() => forgetCards(userId, [card.id]))}>
            <Icon.undo s={15} /> Forget (back to new)
          </button>
        )}
      </div>
    </>
  );
}

function CardTable({ cards, userId, onEdit }: { cards: CardRow[]; userId: string; onEdit: (cardId: string) => void }) {
  const now = Date.now();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  if (cards.length === 0) return <p style={{ color: 'var(--ink-faint)' }}>No cards match.</p>;
  return (
    <table className="card-table clickable">
      <thead>
        <tr>
          <th>Front</th>
          <th className="hide-sm">Back</th>
          <th>State</th>
          <th className="hide-sm">Due</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {cards.map((c) => {
          const status = cardStatus(c, now);
          const dueText = c.reps === 0 ? 'new' : !c.due ? '—' : new Date(c.due).getTime() <= now ? 'due' : formatInterval(new Date(now), new Date(c.due));
          return (
            <tr key={c.id} onClick={() => onEdit(c.id)} title="Edit card" style={c.queue === -1 ? { opacity: 0.55 } : undefined}>
              <td>
                {c.flag > 0 && (
                  <span
                    title={FLAG_NAMES[c.flag]}
                    style={{ width: 8, height: 8, borderRadius: 2, background: FLAG_COLORS[c.flag], display: 'inline-block', marginRight: 7 }}
                  />
                )}
                <span className="ct-term" lang="ja">{c.front || '—'}</span>
                {c.reading && <> <span className="ct-reading" lang="ja">{c.reading}</span></>}
              </td>
              <td className="hide-sm" style={{ color: 'var(--ink-soft)' }}>{c.back}</td>
              <td><span className={'state-pill state-' + status.cls}>{status.label}</span></td>
              <td className="hide-sm" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-faint)' }}>{dueText}</td>
              <td style={{ width: 34 }} onClick={(e) => e.stopPropagation()}>
                <span className="deck-add" style={{ position: 'relative' }}>
                  <button className="icon-btn" title="Card actions" onClick={() => setMenuFor((m) => (m === c.id ? null : c.id))}>
                    <Icon.gear s={15} />
                  </button>
                  {menuFor === c.id && <CardRowMenu card={c} userId={userId} onClose={() => setMenuFor(null)} />}
                </span>
              </td>
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

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{ margin: '14px 0 6px', fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>
      {children}
    </h4>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <label className="opt-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {(Object.keys(options) as T[]).map((k) => (
          <option key={k} value={k}>{options[k]}</option>
        ))}
      </select>
    </label>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="opt-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * Anki-style deck options: everything belongs to the deck's shared *preset* (options group) —
 * saving affects every deck using it — except the per-deck daily-limit overrides ("This deck").
 */
function DeckOptionsModal({ deck, onClose }: { deck: DeckStat; onClose: () => void }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? '';
  const presetParams = useMemo(() => [], []);
  const { data: presets } = useQuery<{ id: string; name: string; config: string | null }>(
    'SELECT id, name, config FROM deck_presets ORDER BY name ASC',
    presetParams,
  );
  const { data: memberCounts } = useQuery<{ preset_id: string | null; n: number }>(
    'SELECT preset_id, COUNT(*) AS n FROM decks GROUP BY preset_id',
    presetParams,
  );
  const [presetId, setPresetId] = useState<string | null>(deck.presetId);
  const [presetMenu, setPresetMenu] = useState(false);

  // A pre-migration deck gets attached to the Default preset when its options are first opened.
  useEffect(() => {
    if (presetId || !userId) return;
    void (async () => {
      const id = await ensureDefaultPreset(userId);
      await assignPreset(deck.id, id);
      setPresetId(id);
    })();
  }, [presetId, userId, deck.id]);

  const preset = presets.find((p) => p.id === presetId) ?? null;
  const usedBy = memberCounts.find((m) => m.preset_id === presetId)?.n ?? 0;

  // Draft form state, re-seeded when the selected preset (or its stored config) changes.
  const [draft, setDraft] = useState<DeckPresetConfig | null>(null);
  const [learn, setLearn] = useState('');
  const [relearn, setRelearn] = useState('');
  const [retention, setRetention] = useState('90');
  const [newOverride, setNewOverride] = useState<string | null>(null);
  const [revOverride, setRevOverride] = useState<string | null>(null);
  useEffect(() => {
    if (!preset) return;
    const cfg = parsePresetConfig(preset.config);
    setDraft(cfg);
    setLearn((cfg.learningSteps ?? ['1m', '10m']).join(' '));
    setRelearn((cfg.relearningSteps ?? ['10m']).join(' '));
    setRetention(String(Math.round(cfg.desiredRetention * 100)));
    setNewOverride(deck.overrides.newPerDayOverride != null ? String(deck.overrides.newPerDayOverride) : null);
    setRevOverride(deck.overrides.reviewsPerDayOverride != null ? String(deck.overrides.reviewsPerDayOverride) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.id, preset?.config]);

  if (!draft || !preset) {
    return (
      <Modal title="Deck options" onClose={onClose}>
        <div className="modal-body"><Spinner size={22} /></div>
      </Modal>
    );
  }
  const d = draft;
  const patch = (p: Partial<DeckPresetConfig>) => setDraft({ ...d, ...p });

  async function selectPreset(id: string) {
    await assignPreset(deck.id, id);
    setPresetId(id);
  }

  async function save() {
    // Anki clamps desired retention to 0.70–0.99.
    const dr = Math.min(0.99, Math.max(0.7, (parseInt(retention || '90', 10) || 90) / 100));
    await savePresetConfig(preset!.id, {
      ...d,
      learningSteps: parseSteps(learn),
      relearningSteps: parseSteps(relearn),
      desiredRetention: dr,
      newPerDay: Math.max(0, d.newPerDay || 0),
      reviewsPerDay: Math.max(0, d.reviewsPerDay || 0),
      leechThreshold: Math.max(1, d.leechThreshold || 8),
      maximumInterval: Math.max(1, d.maximumInterval || 36500),
    });
    await saveDeckOverrides(deck.id, {
      newPerDayOverride: newOverride != null ? Math.max(0, parseInt(newOverride, 10) || 0) : undefined,
      reviewsPerDayOverride: revOverride != null ? Math.max(0, parseInt(revOverride, 10) || 0) : undefined,
    });
    onClose();
  }

  async function newPreset(clone: boolean) {
    if (!userId) return;
    const name = window.prompt(clone ? 'Clone preset as' : 'New preset name', clone ? `${preset!.name} copy` : 'New preset');
    if (!name?.trim()) return;
    const id = await createPreset(userId, name, clone ? d : parsePresetConfig(null));
    await selectPreset(id);
  }

  return (
    <Modal title="Deck options" onClose={onClose}>
      <div className="modal-body">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="opt-field" style={{ flex: 1 }}>
            <span>Preset</span>
            <select value={preset.id} onChange={(e) => void selectPreset(e.target.value)}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <span className="deck-add" style={{ position: 'relative' }}>
            <button className="icon-btn" title="Preset actions" onClick={() => setPresetMenu((o) => !o)}><Icon.gear s={16} /></button>
            {presetMenu && (
              <>
                <div className="popmenu-backdrop" onClick={() => setPresetMenu(false)} />
                <div className="popmenu" style={{ right: 0 }}>
                  <button onClick={() => { setPresetMenu(false); void newPreset(false); }}><Icon.plus s={15} /> New preset</button>
                  <button onClick={() => { setPresetMenu(false); void newPreset(true); }}><Icon.decks s={15} /> Clone preset</button>
                  <button
                    onClick={() => {
                      setPresetMenu(false);
                      const name = window.prompt('Rename preset', preset.name);
                      if (name?.trim()) void renamePreset(preset.id, name);
                    }}
                  >
                    <Icon.study s={15} /> Rename preset
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setPresetMenu(false);
                      if (window.confirm(`Delete preset “${preset.name}”? Its decks move to Default.`)) {
                        void (async () => {
                          await deletePreset(userId, preset.id);
                          const def = await ensureDefaultPreset(userId);
                          setPresetId(def);
                        })();
                      }
                    }}
                  >
                    <Icon.trash s={15} /> Delete preset
                  </button>
                </div>
              </>
            )}
          </span>
        </div>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--ink-faint)' }}>
          Used by {usedBy} {usedBy === 1 ? 'deck' : 'decks'} — changes apply to all of them.
        </p>

        <SectionHead>Daily limits</SectionHead>
        <label className="opt-field">
          <span>New cards / day{newOverride != null ? ' (this deck)' : ''}</span>
          <input
            type="number"
            min={0}
            value={newOverride ?? String(d.newPerDay)}
            onChange={(e) =>
              newOverride != null ? setNewOverride(e.target.value) : patch({ newPerDay: parseInt(e.target.value, 10) || 0 })
            }
          />
        </label>
        <CheckField
          label="Override new limit for this deck only"
          checked={newOverride != null}
          onChange={(v) => setNewOverride(v ? String(deck.overrides.newPerDayOverride ?? d.newPerDay) : null)}
        />
        <label className="opt-field">
          <span>Maximum reviews / day{revOverride != null ? ' (this deck)' : ''}</span>
          <input
            type="number"
            min={0}
            value={revOverride ?? String(d.reviewsPerDay)}
            onChange={(e) =>
              revOverride != null ? setRevOverride(e.target.value) : patch({ reviewsPerDay: parseInt(e.target.value, 10) || 0 })
            }
          />
        </label>
        <CheckField
          label="Override review limit for this deck only"
          checked={revOverride != null}
          onChange={(v) => setRevOverride(v ? String(deck.overrides.reviewsPerDayOverride ?? d.reviewsPerDay) : null)}
        />
        <CheckField label="New cards ignore review limit" checked={d.newIgnoreReviewLimit} onChange={(v) => patch({ newIgnoreReviewLimit: v })} />

        <SectionHead>New cards</SectionHead>
        <label className="opt-field">
          <span>Learning steps</span>
          <input value={learn} placeholder="1m 10m" onChange={(e) => setLearn(e.target.value)} />
        </label>
        <SelectField<InsertionOrder> label="Insertion order" value={d.insertionOrder} options={INSERTION_ORDER_LABELS} onChange={(v) => patch({ insertionOrder: v })} />

        <SectionHead>Lapses</SectionHead>
        <label className="opt-field">
          <span>Relearning steps</span>
          <input value={relearn} placeholder="10m" onChange={(e) => setRelearn(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Leech threshold (lapses)</span>
          <input type="number" min={1} value={String(d.leechThreshold)} onChange={(e) => patch({ leechThreshold: parseInt(e.target.value, 10) || 8 })} />
        </label>
        <SelectField<LeechAction> label="Leech action" value={d.leechAction} options={LEECH_ACTION_LABELS} onChange={(v) => patch({ leechAction: v })} />

        <SectionHead>Display order</SectionHead>
        <SelectField<NewGatherPriority> label="New card gather order" value={d.newGatherPriority} options={GATHER_PRIORITY_LABELS} onChange={(v) => patch({ newGatherPriority: v })} />
        <SelectField<NewSortOrder> label="New card sort order" value={d.newSortOrder} options={NEW_SORT_ORDER_LABELS} onChange={(v) => patch({ newSortOrder: v })} />
        <SelectField<ReviewMix> label="New/review order" value={d.newReviewMix} options={REVIEW_MIX_LABELS} onChange={(v) => patch({ newReviewMix: v })} />
        <SelectField<ReviewMix> label="Interday learning/review order" value={d.interdayLearningMix} options={REVIEW_MIX_LABELS} onChange={(v) => patch({ interdayLearningMix: v })} />
        <SelectField<ReviewSortOrder> label="Review sort order" value={d.reviewSortOrder} options={REVIEW_SORT_ORDER_LABELS} onChange={(v) => patch({ reviewSortOrder: v })} />

        <SectionHead>Burying</SectionHead>
        <CheckField label="Bury new siblings" checked={d.buryNewSiblings} onChange={(v) => patch({ buryNewSiblings: v })} />
        <CheckField label="Bury review siblings" checked={d.buryReviewSiblings} onChange={(v) => patch({ buryReviewSiblings: v })} />
        <CheckField label="Bury interday learning siblings" checked={d.buryInterdayLearningSiblings} onChange={(v) => patch({ buryInterdayLearningSiblings: v })} />

        <SectionHead>FSRS</SectionHead>
        <label className="opt-field">
          <span>Desired retention (%)</span>
          <input type="number" min={70} max={99} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </label>
        <label className="opt-field">
          <span>Maximum interval (days)</span>
          <input type="number" min={1} value={String(d.maximumInterval)} onChange={(e) => patch({ maximumInterval: parseInt(e.target.value, 10) || 36500 })} />
        </label>
        <OptimizeRow presetId={preset.id} deckId={deck.id} />
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => void save()}>Save</Btn>
      </div>
    </Modal>
  );
}

/** Trains personalized FSRS weights from the preset's combined review history (all its decks). */
function OptimizeRow({ presetId, deckId }: { presetId: string | null; deckId: string }) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setRunning(true);
    setMsg(null);
    try {
      const r = presetId ? await optimizePreset(presetId) : await optimizeDeck(deckId);
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
