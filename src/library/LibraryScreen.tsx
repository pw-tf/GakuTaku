import { useMemo, useRef, useState } from 'react';
import { LOCAL_USER_ID } from '../app/localUser';
import { fileAccept } from '../app/platform';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { importFile, useImporting } from '../import/runImport';
import { db } from '../db';
import { useDocuments, useQuery } from '../db/hooks';
import type { DocumentRecord } from '../db/schema';
import { removeBook } from '../reader/addBook';
import { ConfirmModal, Modal, PromptModal } from '../ui/Modal';
import { BOOK_ACCEPT, BookCard, useCovers, useProgress } from './shelf';

interface Category { id: string; name: string }
type Sort = 'recent' | 'added' | 'title' | 'progress';
const SORTS: Record<Sort, string> = { recent: 'Last read', added: 'Date added', title: 'Title', progress: 'Progress' };
/** The category filter: everything, one category, or books in none. */
const ALL = '';
const NONE = '\u0000none';

// ---- Category writes --------------------------------------------------------

/** An error message for a bad category name, or null when it's fine. */
function nameProblem(name: string, cats: Category[], self?: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the category a name.';
  const dup = cats.find((c) => c.id !== self && c.name.toLowerCase() === n.toLowerCase());
  if (dup) return `There's already a “${dup.name}” category.`;
  return null;
}
async function createCategory(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute('INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)', [id, name.trim(), new Date().toISOString()]);
  return id;
}
const renameCategory = (id: string, name: string) => db.execute('UPDATE categories SET name = ? WHERE id = ?', [name.trim(), id]);
const deleteCategory = (id: string) =>
  db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM document_categories WHERE category_id = ?', [id]);
    await tx.execute('DELETE FROM categories WHERE id = ?', [id]);
  });
const setInCategory = (docId: string, catId: string, on: boolean) =>
  on
    ? db.execute('INSERT OR IGNORE INTO document_categories (document_id, category_id) VALUES (?, ?)', [docId, catId])
    : db.execute('DELETE FROM document_categories WHERE document_id = ? AND category_id = ?', [docId, catId]);

// ---- Screen -----------------------------------------------------------------

/** Every book, with search, sorting and categories. */
export function LibraryScreen({ onOpenBook }: { onOpenBook: (doc: DocumentRecord) => void }) {
  const { data: docs } = useDocuments();
  const { data: cats } = useQuery<Category>('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE');
  const { data: links } = useQuery<{ document_id: string; category_id: string }>('SELECT document_id, category_id FROM document_categories');
  const { pct, readAt } = useProgress();
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = useImporting();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [cat, setCat] = useState(ALL);
  const [editing, setEditing] = useState<DocumentRecord | null>(null);
  const [managing, setManaging] = useState(false);

  const catsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of links) (m.get(l.document_id) ?? m.set(l.document_id, new Set()).get(l.document_id)!).add(l.category_id);
    return m;
  }, [links]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = docs.filter((d) => {
      if (needle && !(d.title ?? '').toLowerCase().includes(needle)) return false;
      if (cat === NONE) return !catsOf.get(d.id)?.size;
      return cat === ALL || !!catsOf.get(d.id)?.has(cat);
    });
    const by: Record<Sort, (a: DocumentRecord, b: DocumentRecord) => number> = {
      recent: (a, b) => (readAt.get(b.id) ?? '').localeCompare(readAt.get(a.id) ?? ''),
      added: () => 0, // docs already come newest first
      title: (a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'ja'),
      progress: (a, b) => (pct.get(b.id) ?? 0) - (pct.get(a.id) ?? 0),
    };
    return list.sort(by[sort]);
  }, [docs, q, cat, sort, catsOf, readAt, pct]);
  const covers = useCovers(shown.map((d) => d.id));
  // A deleted category can't stay selected.
  const activeCat = cat === ALL || cat === NONE || cats.some((c) => c.id === cat) ? cat : ALL;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await importFile(file, LOCAL_USER_ID);
  }

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept={fileAccept(BOOK_ACCEPT)} hidden onChange={onFile} />
      <div className="lib-tools">
        <div className="browse-search">
          <Icon.search s={16} />
          <input type="search" placeholder="Search your books" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {(Object.keys(SORTS) as Sort[]).map((s) => <option key={s} value={s}>{SORTS[s]}</option>)}
        </select>
        <Btn size="sm" disabled={busy} title="Add a book (ePUB, PDF, TXT) or an Anki deck (.apkg, .colpkg)" onClick={() => fileRef.current?.click()}>
          <Icon.upload s={15} /> {busy ? 'Working…' : 'Add'}
        </Btn>
      </div>

      <div className="chip-row">
        <button className={'fchip' + (activeCat === ALL ? ' on' : '')} onClick={() => setCat(ALL)}>All</button>
        {cats.map((c) => <button key={c.id} className={'fchip' + (activeCat === c.id ? ' on' : '')} onClick={() => setCat(c.id)}>{c.name}</button>)}
        {cats.length > 0 && <button className={'fchip' + (activeCat === NONE ? ' on' : '')} onClick={() => setCat(NONE)}>Uncategorised</button>}
        <button className="fchip" onClick={() => setManaging(true)}><Icon.plus s={12} w={2.2} style={{ display: 'inline-block', verticalAlign: '-1px' }} /> {cats.length ? 'Categories' : 'New category'}</button>
      </div>

      <p className="lib-count">{shown.length === docs.length ? `${docs.length} ${docs.length === 1 ? 'book' : 'books'}` : `${shown.length} of ${docs.length} books`}</p>

      {docs.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>No books yet. Add a Japanese ePUB, PDF or TXT file to start reading.</p>
      ) : shown.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>No books match.</p>
      ) : (
        <div className="book-grid">
          {shown.map((b) => <BookCard key={b.id} doc={b} pct={pct.get(b.id) ?? 0} cover={covers.get(b.id)} onOpen={() => onOpenBook(b)} onMore={() => setEditing(b)} />)}
        </div>
      )}

      {editing && <BookOptions doc={editing} cats={cats} inCats={catsOf.get(editing.id) ?? new Set()} onClose={() => setEditing(null)} />}
      {managing && <ManageCategories cats={cats} links={links} onClose={() => setManaging(false)} />}
    </div>
  );
}

/** One book's categories (ticked on/off right away), and removing the book. */
function BookOptions({ doc, cats, inCats, onClose }: { doc: DocumentRecord; cats: Category[]; inCats: Set<string>; onClose: () => void }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  if (adding) {
    return (
      <PromptModal
        title="New category"
        label="Name"
        confirmLabel="Add"
        onClose={() => setAdding(false)}
        onSubmit={async (name) => {
          const bad = nameProblem(name, cats);
          if (bad) return bad;
          await setInCategory(doc.id, await createCategory(name), true);
        }}
      />
    );
  }
  if (removing) {
    return (
      <ConfirmModal
        title="Remove book?"
        message={`“${doc.title}” and your place in it will be removed from this device. Cards you mined from it stay.`}
        confirmLabel="Remove"
        danger
        onClose={onClose}
        onConfirm={() => removeBook(doc.id)}
      />
    );
  }
  return (
    <Modal title={doc.title ?? 'Book'} onClose={onClose}>
      <div className="modal-body">
        <div className="cat-list">
          {cats.length === 0 && <p className="cat-empty">No categories yet. Add one to sort your books, like “Novels” or “Manga”.</p>}
          {cats.map((c) => (
            <label key={c.id} className="cat-row">
              <input type="checkbox" checked={inCats.has(c.id)} onChange={(e) => void setInCategory(doc.id, c.id, e.target.checked)} />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
        <Btn size="sm" onClick={() => setAdding(true)}><Icon.plus s={14} /> New category</Btn>
      </div>
      <div className="modal-foot">
        <Btn variant="ghost" style={{ color: 'var(--rate-again)', marginRight: 'auto' }} onClick={() => setRemoving(true)}><Icon.trash s={15} /> Remove book</Btn>
        <Btn variant="primary" onClick={onClose}>Done</Btn>
      </div>
    </Modal>
  );
}

/** Create, rename and delete categories. */
function ManageCategories({ cats, links, onClose }: { cats: Category[]; links: { category_id: string }[]; onClose: () => void }) {
  const [prompt, setPrompt] = useState<null | { cat?: Category }>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const count = (id: string) => links.filter((l) => l.category_id === id).length;
  if (prompt) {
    return (
      <PromptModal
        title={prompt.cat ? 'Rename category' : 'New category'}
        label="Name"
        initial={prompt.cat?.name}
        confirmLabel={prompt.cat ? 'Rename' : 'Add'}
        onClose={() => setPrompt(null)}
        onSubmit={async (name) => {
          const bad = nameProblem(name, cats, prompt.cat?.id);
          if (bad) return bad;
          await (prompt.cat ? renameCategory(prompt.cat.id, name) : createCategory(name));
        }}
      />
    );
  }
  if (deleting) {
    const n = count(deleting.id);
    return (
      <ConfirmModal
        title="Delete category?"
        message={`“${deleting.name}” will be deleted.${n ? ` Its ${n} ${n === 1 ? 'book stays' : 'books stay'} in your library.` : ''}`}
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={() => deleteCategory(deleting.id)}
      />
    );
  }
  return (
    <Modal title="Categories" onClose={onClose}>
      <div className="modal-body">
        <div className="cat-list">
          {cats.length === 0 && <p className="cat-empty">No categories yet. Add one, then tick books into it from their ⋯ menu.</p>}
          {cats.map((c) => (
            <div key={c.id} className="cat-row">
              <span>{c.name}</span>
              <span className="n">{count(c.id)}</span>
              <button className="icon-btn" aria-label={`Rename ${c.name}`} onClick={() => setPrompt({ cat: c })}><Icon.edit s={16} /></button>
              <button className="icon-btn" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Icon.trash s={16} /></button>
            </div>
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <Btn onClick={() => setPrompt({})}><Icon.plus s={15} /> New category</Btn>
        <Btn variant="primary" onClick={onClose}>Done</Btn>
      </div>
    </Modal>
  );
}
