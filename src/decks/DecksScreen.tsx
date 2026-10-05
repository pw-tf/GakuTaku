import { useEffect, useMemo, useRef, useState } from 'react';
import { appSql, col } from '../anki/appCollection';
import { stripHtml } from '../anki/template';
import { findDeckNode, type DeckTreeNode } from '../anki/deckTree';
import { deckSearch } from '../anki/search';
import { fileAccept } from '../app/platform';
import { LOCAL_USER_ID } from '../app/localUser';
import { useBackHandler } from '../app/back';
import { useLive } from '../db/useLive';
import { importFile, useImporting } from '../import/runImport';
import { Btn, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { ConfirmModal, PromptModal } from '../ui/Modal';
import { AddNoteModal } from './AddNoteModal';
import { BrowseCards } from './BrowseCards';
import { DeckOptionsModal } from './DeckOptionsModal';
import { NotetypesModal } from './NotetypesModal';

const DECK_TABLES = ['cards', 'decks', 'deck_config', 'config'];

/** The deck tree with Anki's due counts, refreshed on every change and once a minute (learning cards come due). */
export function useDeckTree() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  return useLive(() => col.deckTree(), [tick], DECK_TABLES, { deferWhileStudying: true });
}

interface Props {
  onStudy: (deckId: number, name: string) => void;
}

export function DecksScreen({ onStudy }: Props) {
  const { data: roots, loading } = useDeckTree();
  const [openId, setOpenId] = useState<number | null>(null);
  const node = openId != null && roots ? findDeckNode(roots, openId) : null;

  useBackHandler(openId != null, () => setOpenId(null));
  useEffect(() => {
    if (openId != null && roots && !node) setOpenId(null); // deleted
  }, [openId, roots, node]);

  if (node) return <DeckOverview node={node} onBack={() => setOpenId(null)} onOpen={setOpenId} onStudy={onStudy} />;
  return <DeckList roots={roots ?? []} loading={loading} onOpen={setOpenId} />;
}

function Counts({ n }: { n: Pick<DeckTreeNode, 'newCount' | 'learnCount' | 'reviewCount'> }) {
  return (
    <span className="dr-counts">
      <span className={'c new' + (n.newCount ? '' : ' zero')} title="New">{n.newCount}</span>
      <span className={'c learn' + (n.learnCount ? '' : ' zero')} title="Learning">{n.learnCount}</span>
      <span className={'c due' + (n.reviewCount ? '' : ' zero')} title="To review">{n.reviewCount}</span>
    </span>
  );
}

function flatten(roots: DeckTreeNode[], depth = 0): { node: DeckTreeNode; depth: number }[] {
  return roots.flatMap((n) => [{ node: n, depth }, ...(n.collapsed ? [] : flatten(n.children, depth + 1))]);
}

function DeckList({ roots, loading, onOpen }: { roots: DeckTreeNode[]; loading: boolean; onOpen: (id: number) => void }) {
  const importing = useImporting();
  const fileRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [notetypes, setNotetypes] = useState(false);
  const rows = useMemo(() => flatten(roots), [roots]);
  useBackHandler(menuOpen, () => setMenuOpen(false));

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await importFile(file, LOCAL_USER_ID);
  }

  if (browsing) return <BrowseCards onBack={() => setBrowsing(false)} />;

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept={fileAccept('.apkg,.colpkg')} hidden onChange={onFile} />
      <div className="sec-bar">
        <h2>Decks</h2>
        <Btn size="sm" onClick={() => setBrowsing(true)} title="Browse all cards" style={{ marginLeft: 'auto' }}>
          <Icon.search s={15} /> Browse
        </Btn>
        <span className="more deck-add">
          <Btn size="sm" disabled={importing} onClick={() => setMenuOpen((o) => !o)}>
            <Icon.plus s={15} /> Add
          </Btn>
          {menuOpen && (
            <>
              <div className="popmenu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="popmenu">
                <button onClick={() => { setMenuOpen(false); setCreating(true); }}><Icon.plus s={15} /> Create deck</button>
                <button onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}><Icon.upload s={15} /> Import Anki deck or backup (.apkg / .colpkg)</button>
                <button onClick={() => { setMenuOpen(false); setNotetypes(true); }}><Icon.study s={15} /> Note types…</button>
              </div>
            </>
          )}
        </span>
      </div>

      {loading && !roots.length ? (
        <div className="deck-loading"><Spinner size={26} /></div>
      ) : roots.length === 0 ? (
        <div className="empty-state">
          <p>No decks yet.</p>
          <p>Import your Anki collection — in Anki, <b>File → Export → “Anki Collection Package (.colpkg)”</b>, copy the file to your phone, then tap <b>Add → Import</b> above. Or import a shared deck (.apkg).</p>
        </div>
      ) : (
        <div className="deck-tree">
          <div className="deck-row deck-head">
            <span className="dr-caret empty" />
            <span className="dr-name">Deck</span>
            <span className="dr-counts"><span className="c">New</span><span className="c">Learn</span><span className="c">Due</span></span>
          </div>
          {rows.map(({ node, depth }) => (
            <div key={node.deckId} className="deck-row" style={{ paddingLeft: 10 + depth * 18 }} onClick={() => onOpen(node.deckId)}>
              <button
                className={'dr-caret' + (node.children.length ? '' : ' empty')}
                aria-label={node.collapsed ? 'Expand' : 'Collapse'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (node.children.length) void col.updateDeck(node.deckId, { collapsed: !node.collapsed });
                }}
              >
                {node.children.length ? <Icon.chevR s={14} style={{ transform: node.collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s' }} /> : null}
              </button>
              <span className="dr-name">{node.name}</span>
              <Counts n={node} />
            </div>
          ))}
        </div>
      )}

      {notetypes && <NotetypesModal onClose={() => setNotetypes(false)} />}
      {creating && (
        <PromptModal
          title="Create deck"
          label="Name"
          initial=""
          placeholder="e.g. Japanese::Vocab"
          help="Use “::” to make a subdeck, e.g. “Japanese::Kaishi”."
          confirmLabel="Create"
          onClose={() => setCreating(false)}
          onSubmit={async (v) => {
            if (!v.trim()) return 'Enter a name.';
            await col.getOrCreateDeck(v);
          }}
        />
      )}
    </div>
  );
}

type Dialog = null | 'options' | 'add' | 'rename' | 'delete' | 'description';

function DeckOverview({ node, onBack, onOpen, onStudy }: { node: DeckTreeNode; onBack: () => void; onOpen: (id: number) => void; onStudy: (id: number, name: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [browsing, setBrowsing] = useState(false);
  useBackHandler(menuOpen, () => setMenuOpen(false));
  const { data: info } = useLive(
    async () => {
      const deck = await col.deck(node.deckId);
      const ids = [node.deckId, ...node.children.flatMap(function all(c): number[] { return [c.deckId, ...c.children.flatMap(all)]; })];
      const ph = ids.map(() => '?').join(',');
      const [{ buried, suspended }] = await appSql.all<{ buried: number; suspended: number }>(
        `SELECT SUM(queue IN (-2, -3)) AS buried, SUM(queue = -1) AS suspended FROM cards WHERE did IN (${ph})`,
        ids,
      );
      return { deck, buried: buried ?? 0, suspended: suspended ?? 0 };
    },
    [node.deckId, node.totalIncludingChildren],
    ['cards', 'decks'],
  );
  const due = node.newCount + node.learnCount + node.reviewCount;

  if (browsing) return <BrowseCards initialQuery={deckSearch(node.fullName)} title={node.fullName.split('::').pop()} currentDeckId={node.deckId} onBack={() => setBrowsing(false)} />;

  return (
    <div className="page">
      <div className="dd-bar">
        <button className="dd-back" onClick={onBack}><Icon.chevL s={18} /> Decks</button>
        <span style={{ flex: 1 }} />
        <span className="deck-add">
          <Btn size="sm" onClick={() => setMenuOpen((o) => !o)}><Icon.gear s={15} /> Deck</Btn>
          {menuOpen && (
            <>
              <div className="popmenu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="popmenu">
                <button onClick={() => { setMenuOpen(false); setDialog('options'); }}><Icon.gear s={15} /> Options</button>
                <button onClick={() => { setMenuOpen(false); setDialog('rename'); }}><Icon.study s={15} /> Rename</button>
                <button onClick={() => { setMenuOpen(false); setDialog('description'); }}><Icon.reader s={15} /> Description</button>
                <button className="danger" onClick={() => { setMenuOpen(false); setDialog('delete'); }}><Icon.trash s={15} /> Delete</button>
              </div>
            </>
          )}
        </span>
      </div>

      <div className="dd-head">
        <h2 className="dd-name">{node.fullName}</h2>
        {/* Shared decks' descriptions are HTML; show them as text so they can't run anything here. */}
        {info?.deck?.description && <p className="dd-desc">{stripHtml(info.deck.description.replace(/<br\s*\/?>|<\/(?:p|div)>/gi, '\n'))}</p>}
        <div className="overview-counts">
          <div><span className="c new">{node.newCount}</span><label>New</label></div>
          <div><span className="c learn">{node.learnCount}</span><label>Learning</label></div>
          <div><span className="c due">{node.reviewCount}</span><label>To review</label></div>
        </div>
        <div className="dd-actions">
          <Btn variant="primary" onClick={() => onStudy(node.deckId, node.fullName)} disabled={due === 0}>
            <Icon.review s={16} /> {due === 0 ? 'Nothing due' : 'Study now'}
          </Btn>
          <Btn onClick={() => setDialog('add')}><Icon.plus s={15} /> Add</Btn>
          <Btn onClick={() => setBrowsing(true)}><Icon.search s={15} /> Browse</Btn>
          {(info?.buried ?? 0) > 0 && (
            <Btn onClick={() => void col.unburyDeck(node.deckId)} title="Return buried cards to today's queue"><Icon.moon s={15} /> Unbury ({info!.buried})</Btn>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          {node.totalIncludingChildren.toLocaleString()} cards{info?.suspended ? ` · ${info.suspended} suspended` : ''}
        </p>
      </div>

      {node.children.length > 0 && (
        <>
          <div className="sec-bar"><h2>Subdecks</h2></div>
          <div className="deck-tree">
            {node.children.map((c) => (
              <div key={c.deckId} className="deck-row" onClick={() => onOpen(c.deckId)}>
                <span className="dr-caret empty" />
                <span className="dr-name">{c.name}</span>
                <Counts n={c} />
              </div>
            ))}
          </div>
        </>
      )}

      {dialog === 'options' && <DeckOptionsModal deckId={node.deckId} onClose={() => setDialog(null)} />}
      {dialog === 'add' && <AddNoteModal deckId={node.deckId} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && (
        <PromptModal
          title="Rename deck"
          label="Name"
          initial={node.fullName}
          help="Renaming also moves its subdecks. Use “::” to nest it under another deck."
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await col.renameDeck(node.deckId, v);
          }}
        />
      )}
      {dialog === 'description' && (
        <PromptModal
          title="Deck description"
          label="Description"
          initial={info?.deck?.description ?? ''}
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await col.updateDeck(node.deckId, { description: v });
          }}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmModal
          title="Delete deck?"
          message={`“${node.fullName}”${node.children.length ? ' and its subdecks' : ''} will be deleted with ${node.totalIncludingChildren.toLocaleString()} cards. This can’t be undone.`}
          confirmLabel="Delete"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await col.removeDeck(node.deckId);
            onBack();
          }}
        />
      )}
    </div>
  );
}
