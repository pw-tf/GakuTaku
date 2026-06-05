import JSZip from 'jszip';
import initSqlJs, { type Database } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/**
 * Parse an Anki `.apkg` (build plan M6). An `.apkg` is a ZIP holding a SQLite "collection"
 * (`collection.anki2` schema 11, or `collection.anki21` schema 18), a `media` JSON map
 * (`{ "0": "img.jpg", ... }`), and numbered media blobs. We read the legacy/uncompressed form
 * (what AnkiWeb decks and "Support older Anki versions" exports use). The modern
 * `collection.anki21b` is zstd-compressed with a protobuf media map — detected and rejected with a
 * friendly message rather than parsed (see {@link UnsupportedApkgError}).
 */

/** Thrown for `.apkg` variants we can't read yet (modern zstd `collection.anki21b`). */
export class UnsupportedApkgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedApkgError';
  }
}

export interface ApkgModel {
  id: string;
  name: string;
  /** Field names in display order. */
  fields: string[];
  templates: { name: string; qfmt: string; afmt: string }[];
}
export interface ApkgDeck {
  id: string;
  name: string;
}
export interface ApkgNote {
  id: number;
  mid: string;
  tags: string;
  /** Field values, positionally aligned with the model's `fields`. */
  flds: string[];
}
export interface ApkgCard {
  id: string;
  nid: string;
  did: string;
  ord: number;
}
export interface ApkgRevlog {
  id: number;
  cid: string;
  ease: number;
  ivl: number;
  time: number;
  type: number;
}

export interface ParsedApkg {
  models: ApkgModel[];
  decks: ApkgDeck[];
  notes: ApkgNote[];
  cards: ApkgCard[];
  revlog: ApkgRevlog[];
  /** numbered-file -> original filename (from the `media` JSON map). */
  media: Record<string, string>;
  /** The open archive, so media blobs can be pulled lazily during upload. */
  zip: JSZip;
}

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function loadSql() {
  if (!sqlPromise) sqlPromise = initSqlJs({ locateFile: () => sqlWasmUrl });
  return sqlPromise;
}

/** Run a query and return rows as plain objects. */
function rows(db: Database, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql);
  if (res.length === 0) return [];
  const { columns, values } = res[0];
  return values.map((row) => Object.fromEntries(row.map((v, i) => [columns[i], v])));
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/** Anki joins a note's field values with the Unit Separator control char. */
const FIELD_SEP = String.fromCharCode(0x1f);

/** Note types/decks from the schema-11 `col` JSON blobs. */
function parseColJson(db: Database): { models: ApkgModel[]; decks: ApkgDeck[] } {
  const col = rows(db, 'SELECT models, decks FROM col LIMIT 1')[0];
  const models: ApkgModel[] = [];
  const decks: ApkgDeck[] = [];
  if (col) {
    const modelsObj = JSON.parse(str(col.models) || '{}') as Record<string, {
      id: number; name: string; flds: { name: string; ord: number }[]; tmpls: { name: string; qfmt: string; afmt: string; ord: number }[];
    }>;
    for (const m of Object.values(modelsObj)) {
      models.push({
        id: str(m.id),
        name: m.name,
        fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
        templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
      });
    }
    const decksObj = JSON.parse(str(col.decks) || '{}') as Record<string, { id: number; name: string }>;
    for (const d of Object.values(decksObj)) decks.push({ id: str(d.id), name: d.name });
  }
  return { models, decks };
}

/** Note types/decks from the normalized schema-18 tables (when `col` JSON is empty). */
function parseNormalized(db: Database): { models: ApkgModel[]; decks: ApkgDeck[] } {
  const fieldsByNt = new Map<string, { name: string; ord: number }[]>();
  for (const f of rows(db, 'SELECT ntid, ord, name FROM fields')) {
    const k = str(f.ntid);
    (fieldsByNt.get(k) ?? fieldsByNt.set(k, []).get(k)!).push({ name: str(f.name), ord: num(f.ord) });
  }
  const tmplByNt = new Map<string, { name: string; qfmt: string; afmt: string; ord: number }[]>();
  for (const t of rows(db, 'SELECT ntid, ord, name, config FROM templates')) {
    // Schema-18 templates store qfmt/afmt in a protobuf `config` blob we can't decode here; fall back
    // to empty front/back (fields still import). Most legacy exports use the schema-11 col JSON path.
    const k = str(t.ntid);
    (tmplByNt.get(k) ?? tmplByNt.set(k, []).get(k)!).push({ name: str(t.name), qfmt: '', afmt: '', ord: num(t.ord) });
  }
  const models: ApkgModel[] = rows(db, 'SELECT id, name FROM notetypes').map((nt) => {
    const k = str(nt.id);
    return {
      id: k,
      name: str(nt.name),
      fields: (fieldsByNt.get(k) ?? []).sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: (tmplByNt.get(k) ?? []).sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
    };
  });
  const decks: ApkgDeck[] = rows(db, 'SELECT id, name FROM decks').map((d) => ({ id: str(d.id), name: str(d.name) }));
  return { models, decks };
}

/** Parse an `.apkg` file's bytes into typed collection data. */
export async function parseApkg(data: ArrayBuffer): Promise<ParsedApkg> {
  const zip = await JSZip.loadAsync(data);

  const collectionFile = zip.file('collection.anki21') ?? zip.file('collection.anki2');
  if (!collectionFile) {
    if (zip.file('collection.anki21b')) {
      throw new UnsupportedApkgError(
        'This deck uses Anki’s newest export format. In Anki, re-export with “Support older Anki versions” enabled, then import that file.',
      );
    }
    throw new UnsupportedApkgError('Not a valid .apkg — no Anki collection found inside.');
  }

  const SQL = await loadSql();
  const db = new SQL.Database(new Uint8Array(await collectionFile.async('arraybuffer')));
  try {
    let { models, decks } = parseColJson(db);
    if (models.length === 0) ({ models, decks } = parseNormalized(db));

    const notes: ApkgNote[] = rows(db, 'SELECT id, mid, tags, flds FROM notes').map((n) => ({
      id: num(n.id),
      mid: str(n.mid),
      tags: str(n.tags).trim(),
      flds: str(n.flds).split(FIELD_SEP),
    }));
    const cards: ApkgCard[] = rows(db, 'SELECT id, nid, did, ord FROM cards').map((c) => ({
      id: str(c.id),
      nid: str(c.nid),
      did: str(c.did),
      ord: num(c.ord),
    }));
    const revlog: ApkgRevlog[] = rows(db, 'SELECT id, cid, ease, ivl, time, type FROM revlog').map((r) => ({
      id: num(r.id),
      cid: str(r.cid),
      ease: num(r.ease),
      ivl: num(r.ivl),
      time: num(r.time),
      type: num(r.type),
    }));

    const mediaEntry = zip.file('media');
    const media = mediaEntry ? (JSON.parse(await mediaEntry.async('string')) as Record<string, string>) : {};

    return { models, decks, notes, cards, revlog, media, zip };
  } finally {
    db.close();
  }
}
