import { useEffect, useState } from 'react';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import { hasKanji } from '../jp-core/furigana';

interface Props {
  text: string;
  showFurigana: boolean;
  onWordTap?: (token: FuriToken, anchor: DOMRect) => void;
}

/** Renders Japanese text as tokenized, tappable units with optional furigana ruby. */
export function FuriganaText({ text, showFurigana, onWordTap }: Props) {
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
      .then((result) => {
        if (!cancelled) setTokens(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (error) {
    return <p className="text-sm text-red-400">Tokenizer error: {error}</p>;
  }

  return (
    <p className="text-2xl leading-loose" lang="ja">
      {tokens.map((token, i) => {
        const tappable = !!onWordTap && (hasKanji(token.surface) || token.pos === '名詞' || token.pos === '動詞' || token.pos === '形容詞');
        return (
          <span
            key={i}
            onClick={
              tappable
                ? (e) => onWordTap!(token, (e.currentTarget as HTMLElement).getBoundingClientRect())
                : undefined
            }
            className={
              tappable
                ? 'cursor-pointer rounded hover:bg-indigo-500/30'
                : undefined
            }
          >
            {showFurigana ? (
              token.segments.map((seg, j) =>
                seg.reading ? (
                  <ruby key={j}>
                    {seg.text}
                    <rt className="text-xs text-slate-400">{seg.reading}</rt>
                  </ruby>
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )
            ) : (
              <span>{token.surface}</span>
            )}
          </span>
        );
      })}
    </p>
  );
}
