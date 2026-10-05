import { useEffect, useMemo, useState } from 'react';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import { hasKanji } from '../jp-core/furigana';
import type { FuriganaDensity } from '../app/prefs';

/**
 * Half-width numbers and capitals lie on their side in vertical text. Mark them so tategaki reads
 * the way print does: one or two digits (or a short decimal like 3.5) sit side by side in a single
 * upright cell (縦中横, class `tcy`); longer numbers and acronyms stand each character upright
 * (`upr`). Both classes are inert in horizontal text.
 *
 * Runs are found over the whole paragraph because the tokenizer splits "3.5" or "1,000" into
 * several tokens. A run that crosses a segment boundary can't be one combined cell, so it stands
 * upright instead.
 */
const LATIN_RUN = /[0-9]+(?:[.,][0-9]+)*|[A-Z]+(?![a-z])/g;
interface UprightRun {
  start: number;
  end: number;
  cls: 'tcy' | 'upr';
}
export function uprightRuns(text: string, boundaries: number[]): UprightRun[] {
  if (!/[0-9A-Z]/.test(text)) return [];
  const out: UprightRun[] = [];
  for (const m of text.matchAll(LATIN_RUN)) {
    const run = m[0];
    const start = m.index ?? 0;
    const end = start + run.length;
    // A capital that starts a lowercase word ("Tokyo") stays as Latin text.
    if (/^[A-Z]/.test(run) && /[a-z]/.test(text[start - 1] ?? '')) continue;
    const split = boundaries.some((b) => b > start && b < end);
    const short = run.length <= 2 || (run.length === 3 && /^[0-9][.,][0-9]$/.test(run));
    out.push({ start, end, cls: short && !split ? 'tcy' : 'upr' });
  }
  return out;
}

/** `text` (which starts at `offset` in the paragraph) with the parts inside `runs` wrapped. */
function wrapRuns(text: string, offset: number, runs: UprightRun[]): React.ReactNode {
  const end = offset + text.length;
  const hits = runs.filter((r) => r.start < end && r.end > offset);
  if (hits.length === 0) return text;
  const out: React.ReactNode[] = [];
  let at = offset;
  for (const r of hits) {
    const s = Math.max(r.start, offset);
    const e = Math.min(r.end, end);
    if (s > at) out.push(text.slice(at - offset, s - offset));
    out.push(<span key={s} className={r.cls}>{text.slice(s - offset, e - offset)}</span>);
    at = e;
  }
  if (at < end) out.push(text.slice(at - offset));
  return out;
}

function tappable(token: FuriToken): boolean {
  return hasKanji(token.surface) || token.pos === '名詞' || token.pos === '動詞' || token.pos === '形容詞';
}

interface TokenizedProps {
  tokens: FuriToken[];
  density: FuriganaDensity;
  /** True if any token carries an advanced flag (dictionary loaded) — enables real N3+ behavior. */
  advAvailable?: boolean;
  activeKey?: number | null;
  /** Offset added to a token's local index when reporting taps (lets a paragraph map into a chapter). */
  indexOffset?: number;
  onWordTap?: (token: FuriToken, key: number, anchor: DOMRect) => void;
}

/** Pure renderer: turns pre-tokenized text into tappable .rd-word units with density-controlled furigana. */
export function TokenizedText({ tokens, density, advAvailable, activeKey, indexOffset = 0, onWordTap }: TokenizedProps) {
  const hasAdv = advAvailable ?? tokens.some((t) => t.adv !== undefined);
  const effective: FuriganaDensity = density === 'n3' && !hasAdv ? 'all' : density;
  const showFuri = (t: FuriToken) => (effective === 'off' ? false : effective === 'all' ? true : !!t.adv);

  // Paragraph text and segment starts, for the vertical-text Latin runs.
  const { runs, starts } = useMemo(() => {
    let text = '';
    const starts: number[][] = [];
    for (const t of tokens) {
      starts.push(t.segments.map((seg) => {
        const at = text.length;
        text += seg.text;
        return at;
      }));
    }
    return { runs: uprightRuns(text, starts.flat()), starts };
  }, [tokens]);

  return (
    <>
      {tokens.map((token, i) => {
        const key = indexOffset + i;
        const segs = token.segments.map((seg, j) =>
          seg.reading ? (
            <ruby key={j} className={showFuri(token) ? undefined : 'furi-off'}>
              {wrapRuns(seg.text, starts[i][j], runs)}
              <rt>{seg.reading}</rt>
            </ruby>
          ) : (
            <span key={j}>{wrapRuns(seg.text, starts[i][j], runs)}</span>
          ),
        );
        if (!onWordTap || !tappable(token)) return <span key={i}>{segs}</span>;
        return (
          <span
            key={i}
            className={'rd-word' + (activeKey === key ? ' rd-word-active' : '')}
            role="button"
            tabIndex={0}
            onClick={(e) => onWordTap(token, key, (e.currentTarget as HTMLElement).getBoundingClientRect())}
          >
            {segs}
          </span>
        );
      })}
    </>
  );
}

interface Props {
  text: string;
  density: FuriganaDensity;
  activeKey?: number | null;
  onWordTap?: (token: FuriToken, key: number, anchor: DOMRect) => void;
}

/** Self-tokenizing convenience wrapper for one-off snippets (tokenizes `text` via the worker). */
export function FuriganaText({ text, density, activeKey, onWordTap }: Props) {
  const [tokens, setTokens] = useState<FuriToken[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!text.trim()) {
      setTokens([]);
      return;
    }
    jpCore
      .furiganaFor(text)
      .then((r) => !cancelled && setTokens(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (error) return <p className="text-sm" style={{ color: 'var(--rate-again)' }}>Tokenizer error: {error}</p>;
  return <TokenizedText tokens={tokens} density={density} activeKey={activeKey} onWordTap={onWordTap} />;
}
