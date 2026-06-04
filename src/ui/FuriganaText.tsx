import { useEffect, useState } from 'react';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import { hasKanji } from '../jp-core/furigana';
import type { FuriganaDensity } from '../app/prefs';

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

  return (
    <>
      {tokens.map((token, i) => {
        const key = indexOffset + i;
        const segs = token.segments.map((seg, j) =>
          seg.reading ? (
            <ruby key={j} className={showFuri(token) ? undefined : 'furi-off'}>
              {seg.text}
              <rt>{seg.reading}</rt>
            </ruby>
          ) : (
            <span key={j}>{seg.text}</span>
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
