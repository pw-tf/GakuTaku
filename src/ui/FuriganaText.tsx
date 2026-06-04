import { useEffect, useState } from 'react';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import { hasKanji } from '../jp-core/furigana';
import type { FuriganaDensity } from '../app/prefs';

interface Props {
  text: string;
  density: FuriganaDensity;
  activeIndex?: number | null;
  onWordTap?: (token: FuriToken, index: number, anchor: DOMRect) => void;
}

function tappable(token: FuriToken): boolean {
  return hasKanji(token.surface) || token.pos === '名詞' || token.pos === '動詞' || token.pos === '形容詞';
}

/** Renders Japanese text as tokenized, tappable units (.rd-word) with density-controlled furigana. */
export function FuriganaText({ text, density, activeIndex, onWordTap }: Props) {
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
      .then((result) => !cancelled && setTokens(result))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (error) return <p className="text-sm" style={{ color: 'var(--rate-again)' }}>Tokenizer error: {error}</p>;

  // If density is N3+ but no advanced-flag info is available (dictionary not loaded), fall back to "all".
  const advAvailable = tokens.some((t) => t.adv !== undefined);
  const effectiveDensity: FuriganaDensity = density === 'n3' && !advAvailable ? 'all' : density;

  function showFuri(token: FuriToken): boolean {
    if (effectiveDensity === 'off') return false;
    if (effectiveDensity === 'all') return true;
    return !!token.adv;
  }

  return (
    <>
      {tokens.map((token, i) => {
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
            className={'rd-word' + (activeIndex === i ? ' rd-word-active' : '')}
            role="button"
            tabIndex={0}
            onClick={(e) => onWordTap(token, i, (e.currentTarget as HTMLElement).getBoundingClientRect())}
          >
            {segs}
          </span>
        );
      })}
    </>
  );
}
