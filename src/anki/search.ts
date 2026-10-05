import type { Notetype } from './notetype';

/**
 * Anki's search syntax (rslib/src/search/{parser,sqlwriter}.rs), compiled to a SQL condition over
 * `cards c JOIN notes n ON n.id = c.nid`.
 *
 *   dog cat          both words (anywhere in the note's fields)
 *   dog or cat       either
 *   -cat             not
 *   (a or b) c       grouping
 *   "a dog"          exact phrase; d*g and d_g are wildcards (\* \_ for the characters themselves)
 *   front:dog        a field's whole content (front:*dog* contains; front: empty; front:_* not empty)
 *   deck:x  tag:x  note:x  card:1  card:Name  flag:1  is:due|new|learn|review|suspended|buried
 *   prop:ivl>=10 (ivl due reps lapses ease pos s d)  rated:7[:1]  added:7  edited:7  introduced:7
 *   re:regex  front:re:regex  nid:1,2  cid:1,2  resched:7
 *
 * Text matching relies on two SQL functions registered on the connection (src/db/sqlFunctions.ts):
 * `regexp(pattern, text)` and `field_at(flds, index)`.
 */

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

export interface SearchContext {
  decks: { id: number; name: string }[];
  notetypes: Notetype[];
  /** Today's day number, and the next rollover (unix secs). */
  today: number;
  nextDayAt: number;
  nowSecs: number;
  learnAheadSecs: number;
  /** The deck `deck:current` means. */
  currentDeckId?: number;
}

export interface CompiledSearch {
  where: string;
  params: unknown[];
}

type Node =
  | { kind: 'and' | 'or'; children: Node[] }
  | { kind: 'not'; child: Node }
  | { kind: 'text'; raw: string };

// ---- tokenizer + parser ------------------------------------------------------------------------

type Token = { t: 'open' } | { t: 'close' } | { t: 'not' } | { t: 'and' } | { t: 'or' } | { t: 'text'; raw: string };

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      out.push({ t: 'open' });
      i++;
      continue;
    }
    if (ch === ')') {
      out.push({ t: 'close' });
      i++;
      continue;
    }
    if (ch === '-' && i + 1 < n && !/\s/.test(input[i + 1]) && input[i + 1] !== ')') {
      out.push({ t: 'not' });
      i++;
      continue;
    }
    // A word: runs to whitespace or a paren outside quotes. Quotes are removed, escapes kept.
    let raw = '';
    let quoted = false;
    let wasQuoted = false;
    while (i < n) {
      const c = input[i];
      if (c === '\\' && i + 1 < n) {
        raw += c + input[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = !quoted;
        wasQuoted = true;
        i++;
        continue;
      }
      if (!quoted && (/\s/.test(c) || c === '(' || c === ')')) break;
      raw += c;
      i++;
    }
    if (quoted) throw new SearchError('A quote (") is missing its closing quote.');
    const lower = raw.toLowerCase();
    if (!wasQuoted && lower === 'or') out.push({ t: 'or' });
    else if (!wasQuoted && lower === 'and') out.push({ t: 'and' });
    else if (raw !== '' || wasQuoted) out.push({ t: 'text', raw });
  }
  return out;
}

export function parseSearch(input: string): Node | null {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];

  const parseOr = (): Node => {
    const parts = [parseAnd()];
    while (peek()?.t === 'or') {
      pos++;
      if (!peek() || peek().t === 'close' || peek().t === 'or') throw new SearchError('“or” needs something on both sides.');
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : { kind: 'or', children: parts };
  };
  const parseAnd = (): Node => {
    const parts = [parseUnary()];
    for (;;) {
      const tk = peek();
      if (!tk || tk.t === 'close' || tk.t === 'or') break;
      if (tk.t === 'and') {
        pos++;
        if (!peek() || peek().t === 'close' || peek().t === 'or' || peek().t === 'and') throw new SearchError('“and” needs something on both sides.');
        continue;
      }
      parts.push(parseUnary());
    }
    return parts.length === 1 ? parts[0] : { kind: 'and', children: parts };
  };
  const parseUnary = (): Node => {
    const tk = peek();
    if (!tk) throw new SearchError('The search ends unexpectedly.');
    if (tk.t === 'not') {
      pos++;
      return { kind: 'not', child: parseUnary() };
    }
    if (tk.t === 'open') {
      pos++;
      if (peek()?.t === 'close') throw new SearchError('Empty brackets ().');
      const inner = parseOr();
      if (peek()?.t !== 'close') throw new SearchError('A bracket ( is missing its closing ).');
      pos++;
      return inner;
    }
    if (tk.t === 'close') throw new SearchError('A closing bracket ) has no opening (.');
    if (tk.t === 'or' || tk.t === 'and') throw new SearchError(`“${tk.t}” needs something on both sides.`);
    pos++;
    return { kind: 'text', raw: tk.raw };
  };

  if (!tokens.length) return null;
  const node = parseOr();
  if (pos < tokens.length) throw new SearchError('A closing bracket ) has no opening (.');
  return node;
}

// ---- text helpers ------------------------------------------------------------------------------

/** Split `key:value` at the first unescaped colon. */
function splitKey(raw: string): [string, string] | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === ':') return i > 0 ? [raw.slice(0, i), raw.slice(i + 1)] : null;
  }
  return null;
}

/** Search text → a SQL LIKE pattern (escape char `\`): `*` any run, `_` any one character. */
export function toLike(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      out += next === '%' || next === '_' || next === '\\' ? '\\' + next : next;
    } else if (c === '*') out += '%';
    else if (c === '%') out += '\\%';
    else out += c;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Search text → a regex source (unanchored): `*` any run, `_` any one character. */
export function toRegexSource(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) out += escapeRe(raw[++i]);
    else if (c === '*') out += '.*';
    else if (c === '_') out += '.';
    else out += escapeRe(c);
  }
  return out;
}

/** Search text without its escapes. */
export function unescapeText(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** Whole-string, case-insensitive wildcard matcher for names (decks, notetypes, templates, fields). */
const nameMatcher = (raw: string) => new RegExp(`^${toRegexSource(raw)}$`, 'i');

const sqlList = (ids: number[]) => (ids.length ? ids.join(',') : 'NULL');

// ---- SQL writer --------------------------------------------------------------------------------

const DAY = 86_400;

export function compileSearch(input: string, ctx: SearchContext): CompiledSearch {
  const node = parseSearch(input);
  const params: unknown[] = [];
  if (!node) return { where: '1', params };

  const write = (n: Node): string => {
    switch (n.kind) {
      case 'and':
        return `(${n.children.map(write).join(' AND ')})`;
      case 'or':
        return `(${n.children.map(write).join(' OR ')})`;
      case 'not':
        return `(NOT ${write(n.child)})`;
      case 'text':
        return term(n.raw);
    }
  };

  const daysBack = (value: string, what: string): number => {
    const days = Number(value);
    if (!/^\d+$/.test(value) || days < 1) throw new SearchError(`${what} needs a number of days, like ${what}:7.`);
    return days;
  };

  const unqualified = (raw: string): string => {
    if (raw === '*' || raw === '') return '1';
    const like = `%${toLike(raw)}%`;
    params.push(like, like);
    return `(n.sfld LIKE ? ESCAPE '\\' OR n.flds LIKE ? ESCAPE '\\')`;
  };

  const term = (raw: string): string => {
    const kv = splitKey(raw);
    if (!kv) return unqualified(raw);
    const key = kv[0].toLowerCase();
    const value = kv[1];
    switch (key) {
      case 'deck':
        return deckTerm(value);
      case 'tag':
        return tagTerm(value);
      case 'note':
        return noteTerm(value);
      case 'card':
        return cardTerm(value);
      case 'flag': {
        if (!/^[0-7]$/.test(value)) throw new SearchError('flag: takes 0 (no flag) to 7.');
        return `((c.flags & 7) = ${Number(value)})`;
      }
      case 'is':
        return stateTerm(value.toLowerCase());
      case 'prop':
        return propTerm(value);
      case 'rated': {
        const [d, ease] = value.split(':');
        const cutoff = (ctx.nextDayAt - daysBack(d, 'rated') * DAY) * 1000;
        if (ease !== undefined && !/^[1-4]$/.test(ease)) throw new SearchError('rated:days:button takes a button from 1 to 4.');
        return `(c.id IN (SELECT cid FROM revlog WHERE id > ${cutoff} AND ${ease ? `ease = ${Number(ease)}` : 'ease BETWEEN 1 AND 4'}))`;
      }
      case 'resched': {
        const cutoff = (ctx.nextDayAt - daysBack(value, 'resched') * DAY) * 1000;
        return `(c.id IN (SELECT cid FROM revlog WHERE id > ${cutoff} AND ease = 0))`;
      }
      case 'added':
        return `(c.id > ${(ctx.nextDayAt - daysBack(value, 'added') * DAY) * 1000})`;
      case 'edited':
        return `(n.mod > ${ctx.nextDayAt - daysBack(value, 'edited') * DAY})`;
      case 'introduced': {
        const cutoff = (ctx.nextDayAt - daysBack(value, 'introduced') * DAY) * 1000;
        return `(c.id IN (SELECT cid FROM revlog WHERE ease BETWEEN 1 AND 4 GROUP BY cid HAVING MIN(id) > ${cutoff}))`;
      }
      case 'nid':
      case 'cid': {
        if (!/^\d+(,\d+)*$/.test(value)) throw new SearchError(`${key}: takes ids separated by commas.`);
        return `(${key === 'nid' ? 'n.id' : 'c.id'} IN (${value}))`;
      }
      case 're':
        params.push(regexSource(value));
        return `(regexp(?, n.flds))`;
      case 'dupe':
      case 'nc':
      case 'w':
      case 'preset':
        throw new SearchError(`${key}: searches aren’t supported yet.`);
      default:
        return fieldTerm(kv[0], value);
    }
  };

  /** A user regex, case-insensitive unless it starts with (?-i). */
  const regexSource = (raw: string): string => {
    const src = unescapeText(raw);
    try {
      new RegExp(src.replace(/^\(\?-?i\)/, ''));
    } catch {
      throw new SearchError(`“${src}” isn’t a valid regular expression.`);
    }
    return src.startsWith('(?-i)') ? src.slice(5) : src.startsWith('(?i)') ? src : `(?i)${src}`;
  };

  const deckTerm = (value: string): string => {
    if (value === '*') return '1';
    if (value.toLowerCase() === 'filtered') return '(c.odid != 0)';
    let ids: number[];
    if (value.toLowerCase() === 'current') {
      const cur = ctx.decks.find((d) => d.id === ctx.currentDeckId);
      ids = cur ? ctx.decks.filter((d) => d.id === cur.id || d.name.toLowerCase().startsWith(cur.name.toLowerCase() + '::')).map((d) => d.id) : [];
    } else {
      // A deck matches with its subdecks.
      const re = new RegExp(`^${toRegexSource(value)}(::.*)?$`, 'i');
      ids = ctx.decks.filter((d) => re.test(d.name)).map((d) => d.id);
    }
    const list = sqlList(ids);
    return `(c.did IN (${list}) OR c.odid IN (${list}))`;
  };

  const tagTerm = (value: string): string => {
    if (value.toLowerCase() === 'none') return `(trim(n.tags) = '')`;
    if (value === '*' || value === '_*') return `(trim(n.tags) != '')`;
    // A tag matches with its child tags (parent::child).
    params.push(`(?i) ${toRegexSource(value)}(::\\S*)? `);
    return `(regexp(?, ' ' || n.tags || ' '))`;
  };

  const noteTerm = (value: string): string => {
    const re = nameMatcher(value);
    return `(n.mid IN (${sqlList(ctx.notetypes.filter((nt) => re.test(nt.name)).map((nt) => nt.id))}))`;
  };

  const cardTerm = (value: string): string => {
    if (/^\d+$/.test(value)) return `(c.ord = ${Number(value) - 1})`;
    const re = nameMatcher(value);
    const parts: string[] = [];
    for (const nt of ctx.notetypes) {
      if (nt.kind === 1) continue;
      const ords = nt.templates.filter((t) => re.test(t.name)).map((t) => t.ord);
      if (ords.length) parts.push(`(n.mid = ${nt.id} AND c.ord IN (${ords.join(',')}))`);
    }
    return parts.length ? `(${parts.join(' OR ')})` : '(0)';
  };

  const stateTerm = (value: string): string => {
    switch (value) {
      case 'new':
        return '(c.type = 0)';
      case 'learn':
        return '(c.queue IN (1, 3))';
      case 'review':
        return '(c.type IN (2, 3))';
      case 'due':
        return `((c.queue IN (2, 3) AND c.due <= ${ctx.today}) OR (c.queue IN (1, 4) AND c.due <= ${ctx.nowSecs + ctx.learnAheadSecs}))`;
      case 'suspended':
        return '(c.queue = -1)';
      case 'buried':
        return '(c.queue IN (-2, -3))';
      case 'buried-sibling':
        return '(c.queue = -2)';
      case 'buried-manually':
        return '(c.queue = -3)';
      default:
        throw new SearchError(`is:${value} isn’t a search Anki knows. Try is:due, is:new, is:learn, is:review, is:suspended or is:buried.`);
    }
  };

  const propTerm = (value: string): string => {
    const m = /^([a-z]+)(<=|>=|!=|=|<|>)(-?\d+(?:\.\d+)?)$/i.exec(value);
    if (!m) throw new SearchError('prop: looks like prop:ivl>=10 (ivl, due, reps, lapses, ease, pos, s, d).');
    const [, rawProp, rawOp, num] = m;
    const op = rawOp === '=' ? '=' : rawOp;
    const x = Number(num);
    switch (rawProp.toLowerCase()) {
      case 'ivl':
        return `(c.ivl ${op} ${x})`;
      case 'reps':
        return `(c.reps ${op} ${x})`;
      case 'lapses':
        return `(c.lapses ${op} ${x})`;
      case 'ease':
        return `(c.factor > 0 AND c.factor / 1000.0 ${op} ${x})`;
      case 'pos':
        return `(c.type = 0 AND c.due ${op} ${x})`;
      case 'due':
        return `((c.queue IN (2, 3) AND (CASE WHEN c.odue != 0 THEN c.odue ELSE c.due END) - ${ctx.today} ${op} ${x}) OR (c.queue IN (1, 4) AND (c.due - ${ctx.nextDayAt}) / ${DAY} ${op} ${x}))`;
      case 's':
        return `(c.stability ${op} ${x})`;
      case 'd':
        return `((c.difficulty - 1.0) / 9.0 ${op} ${x})`;
      default:
        throw new SearchError(`prop:${rawProp} isn’t supported. Try ivl, due, reps, lapses, ease, pos, s or d.`);
    }
  };

  const fieldTerm = (rawName: string, value: string): string => {
    const re = nameMatcher(rawName);
    // Placeholders are pushed in the order they appear in the SQL.
    let match: (expr: string) => string;
    if (value.toLowerCase().startsWith('re:')) {
      const src = regexSource(value.slice(3));
      match = (expr) => (params.push(src), `regexp(?, ${expr})`);
    } else if (value === '') {
      match = (expr) => `${expr} = ''`;
    } else {
      const like = toLike(value);
      match = (expr) => (params.push(like), `${expr} LIKE ? ESCAPE '\\'`);
    }
    const parts: string[] = [];
    for (const nt of ctx.notetypes) {
      const ords = nt.fields.filter((f) => re.test(f.name)).map((f) => f.ord);
      if (ords.length) parts.push(`(n.mid = ${nt.id} AND (${ords.map((ord) => match(`field_at(n.flds, ${ord})`)).join(' OR ')}))`);
    }
    return parts.length ? `(${parts.join(' OR ')})` : '(0)';
  };

  return { where: write(node), params };
}

// ---- sorting -----------------------------------------------------------------------------------

export type SortColumn = 'sortField' | 'due' | 'created' | 'modified' | 'interval' | 'ease' | 'reviews' | 'lapses' | 'deck' | 'difficulty' | 'stability';

export const SORT_COLUMNS: Record<SortColumn, string> = {
  sortField: 'Sort field',
  due: 'Due',
  created: 'Created',
  modified: 'Modified',
  interval: 'Interval',
  ease: 'Ease',
  reviews: 'Reviews',
  lapses: 'Lapses',
  deck: 'Deck',
  difficulty: 'Difficulty',
  stability: 'Stability',
};

/** ORDER BY for a browser column (`d` is the joined decks table). */
export function sortSql(col: SortColumn, desc: boolean, t: { today: number; nextDayAt: number }): string {
  const dir = desc ? 'DESC' : 'ASC';
  switch (col) {
    case 'sortField':
      return `n.sfld COLLATE NOCASE ${dir}, c.ord ${dir}`;
    case 'due':
      // Reviews and learning by the day they're due, then new cards by position; suspended/buried last.
      return `(c.queue < 0) ASC, (c.type = 0) ${dir}, CASE WHEN c.queue IN (1, 4) THEN ${t.today} + (c.due - ${t.nextDayAt}) / ${DAY} ELSE c.due END ${dir}, c.id ${dir}`;
    case 'created':
      return `n.id ${dir}, c.ord ${dir}`;
    case 'modified':
      return `c.mod ${dir}, c.id ${dir}`;
    case 'interval':
      return `c.ivl ${dir}, c.id ${dir}`;
    case 'ease':
      return `(c.type = 0) ASC, c.factor ${dir}, c.id ${dir}`;
    case 'reviews':
      return `c.reps ${dir}, c.id ${dir}`;
    case 'lapses':
      return `c.lapses ${dir}, c.id ${dir}`;
    case 'deck':
      return `d.name COLLATE NOCASE ${dir}, n.sfld COLLATE NOCASE ${dir}`;
    case 'difficulty':
      return `(c.difficulty IS NULL) ASC, c.difficulty ${dir}, c.id ${dir}`;
    case 'stability':
      return `(c.stability IS NULL) ASC, c.stability ${dir}, c.id ${dir}`;
  }
}

/** A deck name quoted for a search (`deck:"My deck"`). */
export function deckSearch(name: string): string {
  return `deck:"${name.replace(/[\\"*_]/g, (c) => '\\' + c)}"`;
}
