/**
 * Note types (Anki "models") and the field/card helpers that depend on them. Fields are stored the
 * way Anki stores them: one string joined with U+001F.
 */

export const FIELD_SEP = '\x1f';

export interface NotetypeField {
  name: string;
  ord: number;
}

export interface NotetypeTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
}

export interface Notetype {
  id: number;
  name: string;
  /** 0 = standard, 1 = cloze. */
  kind: 0 | 1;
  fields: NotetypeField[];
  templates: NotetypeTemplate[];
  css: string;
  /** Index of the field the browser sorts by. */
  sortIdx: number;
  latexPre?: string;
  latexPost?: string;
}

export const splitFields = (flds: string) => flds.split(FIELD_SEP);
export const joinFields = (fields: string[]) => fields.join(FIELD_SEP);

/** Field values keyed by field name. */
export function fieldMap(nt: Notetype, flds: string | string[]): Record<string, string> {
  const values = typeof flds === 'string' ? splitFields(flds) : flds;
  const out: Record<string, string> = {};
  [...nt.fields].sort((a, b) => a.ord - b.ord).forEach((f, i) => (out[f.name] = values[i] ?? ''));
  return out;
}

/** Plain text of the sort field (HTML stripped), as Anki stores in `notes.sfld`. */
export function sortFieldValue(nt: Notetype, fields: string[]): string {
  const raw = fields[nt.sortIdx] ?? fields[0] ?? '';
  return raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
