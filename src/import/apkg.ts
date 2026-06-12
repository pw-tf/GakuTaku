import JSZip from 'jszip';
import initSqlJs, { type Database } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { decompress } from 'fzstd';
import { decodeFields, pbMessages, pbString, pbUint } from './proto';

/**
 * Parse an Anki `.apkg` (build plan M6). An `.apkg` is a ZIP holding a SQLite "collection", a media
 * map, and numbered media blobs, in one of Anki's three export versions (the `meta` protobuf entry):
 *
 * - v1/v2 (legacy, what "Support older Anki versions" exports): uncompressed `collection.anki2` /
 *   `collection.anki21` with schema-11 JSON blobs in `col`, and a JSON `media` map
 *   (`{ "0": "img.jpg", ... }`).
 * - v3 (the current Anki default): `collection.anki21b` — a zstd-compressed schema-18 SQLite file
 *   with normalized `notetypes`/`fields`/`templates`/`decks` tables (protobuf config blobs), a
 *   zstd-compressed protobuf `media` map, and each numbered media file individually
 *   zstd-compressed.
 *
 * Both forms are parsed here so decks import with their authors' templates and styling intact.
 */

/** Thrown for files we can't read (not an Anki package, or a corrupt one). */
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
  /** The note type's stylesheet (Anki model `css`) — applied verbatim at render time. */
  css: string;
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
  factor: number;
  time: number;
  type: number;
}

export interface ParsedApkg {
  models: ApkgModel[];
  decks: ApkgDeck[];
  notes: ApkgNote[];
  cards: ApkgCard[];
  revlog: ApkgRevlog[];
  /** numbered-file -> original filename (from the `media` map, either JSON or protobuf form). */
  media: Record<string, string>;
  /** True for v3 packages, whose numbered media files are individually zstd-compressed. */
  mediaCompressed: boolean;
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
const blob = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(0));

/** Anki joins a note's field values (and schema-18 deck name components) with the Unit Separator. */
const FIELD_SEP = String.fromCharCode(0x1f);

/** Note types/decks from the schema-11 `col` JSON blobs. */
function parseColJson(db: Database): { models: ApkgModel[]; decks: ApkgDeck[] } {
  const col = rows(db, 'SELECT models, decks FROM col LIMIT 1')[0];
  const models: ApkgModel[] = [];
  const decks: ApkgDeck[] = [];
  if (col) {
    const modelsObj = JSON.parse(str(col.models) || '{}') as Record<string, {
      id: number; name: string; css?: string; flds: { name: string; ord: number }[]; tmpls: { name: string; qfmt: string; afmt: string; ord: number }[];
    }>;
    for (const m of Object.values(modelsObj)) {
      models.push({
        id: str(m.id),
        name: m.name,
        fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
        templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
        css: str(m.css),
      });
    }
    const decksObj = JSON.parse(str(col.decks) || '{}') as Record<string, { id: number; name: string }>;
    for (const d of Object.values(decksObj)) decks.push({ id: str(d.id), name: d.name });
  }
  return { models, decks };
}

/**
 * Note types/decks from the normalized schema-18 tables. The `config` blobs are protobuf:
 * `Notetype.Config` (css = field 3) for `notetypes`, `Notetype.Template.Config`
 * (q_format = 1, a_format = 2) for `templates` — so authors' templates and styling import intact.
 */
function parseNormalized(db: Database): { models: ApkgModel[]; decks: ApkgDeck[] } {
  const fieldsByNt = new Map<string, { name: string; ord: number }[]>();
  for (const f of rows(db, 'SELECT ntid, ord, name FROM fields')) {
    const k = str(f.ntid);
    (fieldsByNt.get(k) ?? fieldsByNt.set(k, []).get(k)!).push({ name: str(f.name), ord: num(f.ord) });
  }
  const tmplByNt = new Map<string, { name: string; qfmt: string; afmt: string; ord: number }[]>();
  for (const t of rows(db, 'SELECT ntid, ord, name, config FROM templates')) {
    const k = str(t.ntid);
    let qfmt = '';
    let afmt = '';
    try {
      const cfg = decodeFields(blob(t.config));
      qfmt = pbString(cfg, 1);
      afmt = pbString(cfg, 2);
    } catch {
      // A malformed blob still imports the fields; the template just renders empty.
    }
    (tmplByNt.get(k) ?? tmplByNt.set(k, []).get(k)!).push({ name: str(t.name), qfmt, afmt, ord: num(t.ord) });
  }
  const models: ApkgModel[] = rows(db, 'SELECT id, name, config FROM notetypes').map((nt) => {
    const k = str(nt.id);
    let css = '';
    try {
      css = pbString(decodeFields(blob(nt.config)), 3);
    } catch {
      // Missing CSS falls back to the renderer's base styles.
    }
    return {
      id: k,
      name: str(nt.name),
      fields: (fieldsByNt.get(k) ?? []).sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: (tmplByNt.get(k) ?? []).sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
      css,
    };
  });
  // Schema-18 deck names use \x1f between components where schema 11 used "::".
  const decks: ApkgDeck[] = rows(db, 'SELECT id, name FROM decks').map((d) => ({
    id: str(d.id),
    name: str(d.name).split(FIELD_SEP).join('::'),
  }));
  return { models, decks };
}

/** The media map: legacy JSON `{ "0": name }`, or v3's zstd protobuf MediaEntries (index = filename). */
async function parseMediaMap(zip: JSZip, v3: boolean): Promise<Record<string, string>> {
  const mediaEntry = zip.file('media');
  if (!mediaEntry) return {};
  if (!v3) return JSON.parse(await mediaEntry.async('string')) as Record<string, string>;
  const raw = decompress(new Uint8Array(await mediaEntry.async('arraybuffer')));
  const media: Record<string, string> = {};
  pbMessages(decodeFields(raw), 1).forEach((entry, i) => {
    const name = pbString(decodeFields(entry), 1);
    if (name) media[String(i)] = name;
  });
  return media;
}

/** Parse an `.apkg` file's bytes into typed collection data. */
export async function parseApkg(data: ArrayBuffer): Promise<ParsedApkg> {
  const zip = await JSZip.loadAsync(data);

  // The `meta` entry (PackageMetadata.version) says which export version this is; version 3 means
  // zstd. Trust the anki21b file itself too — v3 packages may carry a legacy placeholder collection.
  const metaFile = zip.file('meta');
  let version = 0;
  if (metaFile) {
    try {
      version = pbUint(decodeFields(new Uint8Array(await metaFile.async('arraybuffer'))), 1);
    } catch {
      version = 0;
    }
  }
  const modern = zip.file('collection.anki21b');
  const v3 = !!modern && (version >= 3 || !zip.file('collection.anki21'));

  let dbBytes: Uint8Array;
  if (v3 && modern) {
    try {
      dbBytes = decompress(new Uint8Array(await modern.async('arraybuffer')));
    } catch {
      throw new UnsupportedApkgError('Could not decompress this deck — the file may be corrupt.');
    }
  } else {
    const collectionFile = zip.file('collection.anki21') ?? zip.file('collection.anki2');
    if (!collectionFile) throw new UnsupportedApkgError('Not a valid .apkg — no Anki collection found inside.');
    dbBytes = new Uint8Array(await collectionFile.async('arraybuffer'));
  }

  const SQL = await loadSql();
  const db = new SQL.Database(dbBytes);
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
    const revlog: ApkgRevlog[] = rows(db, 'SELECT id, cid, ease, ivl, factor, time, type FROM revlog').map((r) => ({
      id: num(r.id),
      cid: str(r.cid),
      ease: num(r.ease),
      ivl: num(r.ivl),
      factor: num(r.factor),
      time: num(r.time),
      type: num(r.type),
    }));

    const media = await parseMediaMap(zip, v3);

    return { models, decks, notes, cards, revlog, media, mediaCompressed: v3, zip };
  } finally {
    db.close();
  }
}
