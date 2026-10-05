/**
 * SQL functions the app's queries use (registered on every connection, app and tests alike):
 *
 *   regexp(pattern, text)   also makes `text REGEXP pattern` work; a leading (?i) means ignore case
 *   field_at(flds, i)       the i-th field of a note's 0x1f-separated fields
 */

interface FunctionHost {
  createFunction(name: string, fn: (ctx: number, ...args: unknown[]) => unknown, opts?: { deterministic?: boolean; arity?: number }): unknown;
}

const cache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  let re = cache.get(pattern);
  if (re !== undefined) return re;
  let src = pattern;
  let flags = 'u';
  if (src.startsWith('(?i)')) {
    src = src.slice(4);
    flags += 'i';
  }
  try {
    re = new RegExp(src, flags);
  } catch {
    try {
      re = new RegExp(src, flags.replace('u', ''));
    } catch {
      re = null;
    }
  }
  if (cache.size > 200) cache.clear();
  cache.set(pattern, re);
  return re;
}

export function regexpMatch(pattern: unknown, text: unknown): number {
  if (typeof pattern !== 'string' || text == null) return 0;
  const re = compile(pattern);
  return re && re.test(String(text)) ? 1 : 0;
}

export function fieldAt(flds: unknown, index: unknown): string {
  if (typeof flds !== 'string') return '';
  const i = Number(index);
  let start = 0;
  for (let k = 0; k < i; k++) {
    const next = flds.indexOf('\x1f', start);
    if (next < 0) return '';
    start = next + 1;
  }
  const end = flds.indexOf('\x1f', start);
  return end < 0 ? flds.slice(start) : flds.slice(start, end);
}

export function registerSqlFunctions(db: FunctionHost): void {
  db.createFunction('regexp', (_ctx, pattern, text) => regexpMatch(pattern, text), { deterministic: true, arity: 2 });
  db.createFunction('field_at', (_ctx, flds, index) => fieldAt(flds, index), { deterministic: true, arity: 2 });
}
