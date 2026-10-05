import { useEffect, useMemo, useRef, useState } from 'react';
import type { LookupState } from '../jp-core/lookupService';
import { usePrefs } from '../app/prefs';
import { col } from '../anki/appCollection';
import { useLive } from '../db/useLive';
import { mineWord } from '../study/mining';
import { speak } from '../native/tts';
import { DeckPicker } from './DeckPicker';
import { Btn, Chip } from './atoms';
import { Icon } from './icons';

export interface MinedItem {
  term: string;
  reading: string;
  gloss: string;
  cardId: number;
  deckId: number;
}

/** Where the looked-up word was found, captured onto the mined card. */
export interface MineContext {
  /** The sentence in Anki furigana syntax, word in <b>. */
  sentence: string;
  sentencePlain: string;
  source: string;
  documentId?: string | null;
}

interface Props extends LookupState {
  onClose: () => void;
  onMine?: (item: MinedItem) => void;
  context?: MineContext;
}

type AudioStatus = null | 'fetching' | 'done' | 'none';

/** The single shared dictionary popup (build plan §3.5), populated from the real LookupResult. */
export function LookupPopup({ result, loading, anchor, error, onClose, onMine, context }: Props) {
  const { data: decks = [] } = useLive(async () => (await col.decks()).filter((d) => !d.filtered), [], ['decks']);
  const { lastDeckId, setLastDeckId, mineWordAudio, mineSentenceAudio } = usePrefs();
  const [audio, setAudio] = useState<AudioStatus>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Reset "added" when the looked-up term changes.
  useEffect(() => {
    setAdded(false);
    setAudio(null);
  }, [result?.query]);

  // The remembered deck, if it still exists (one-tap add target).
  const targetDeck = useMemo(() => decks.find((d) => d.id === lastDeckId) ?? null, [decks, lastDeckId]);

  // Dismiss on outside click (ignoring other tappable words).
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest('.rd-word')) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const reading = useMemo(
    () => result?.words[0]?.kana[0] ?? result?.names[0]?.kana[0] ?? '',
    [result],
  );

  if (!anchor) return null;

  const below = anchor.bottom < window.innerHeight - 280;
  const left = Math.min(Math.max(anchor.left, 12), window.innerWidth - 360);
  const top = below ? anchor.bottom + 10 : anchor.top - 12;
  const style = below ? { left, top } : { left, top, transform: 'translateY(-100%)' };

  const firstWord = result?.words[0];
  const senses = result ? result.words.flatMap((w) => w.senses).slice(0, 8) : [];

  /** Best-effort meaning, falling back to name translations / kanji meanings for non-word entries. */
  function resolveGloss(): string {
    const wordGloss = senses[0]?.gloss.join('; ') ?? '';
    if (wordGloss) return wordGloss;
    const nameGloss = result?.names[0]?.translations.map((t) => t.text.join(', ')).join('; ') ?? '';
    if (nameGloss) return nameGloss;
    return result?.kanji[0]?.meanings.slice(0, 4).join(', ') ?? '';
  }

  async function addTo(deckId: number) {
    if (!result) return;
    const gloss = resolveGloss();
    // Create a real note + card (deduped per term) and record the lookup in mined_words history.
    const mined = await mineWord({
      deckId,
      term: result.query,
      reading,
      meaning: gloss,
      sentence: context?.sentence,
      sentencePlain: context?.sentencePlain,
      source: context?.source,
      documentId: context?.documentId,
      wordAudio: mineWordAudio,
      sentenceAudio: mineSentenceAudio,
    });
    const { cardId } = mined;
    if (mined.created && (mineWordAudio || mineSentenceAudio)) {
      setAudio('fetching');
      void mined.audio.then((a) => setAudio(a.word || a.sentence ? 'done' : 'none'));
    }
    setLastDeckId(deckId);
    setPickerOpen(false);
    onMine?.({ term: result.query, reading, gloss, cardId, deckId });
    setAdded(true);
  }

  function onAddClick() {
    if (targetDeck) void addTo(targetDeck.id);
    else setPickerOpen(true); // no remembered deck yet → choose/create one
  }

  function listen() {
    if (result) void speak(result.query);
  }

  const hasEntry = !!result && (result.words.length > 0 || result.names.length > 0);

  return (
    <div className="lookup-pop" ref={ref} style={style}>
      <div className="lk-head">
        <div className="lk-term">
          <span className="tm" lang="ja">{result?.query}</span>
          {reading && <span className="rd" lang="ja">{reading}</span>}
        </div>
        {firstWord && (
          <div className="lk-tags">
            {firstWord.common && <Chip>common</Chip>}
            {firstWord.senses[0]?.pos[0] && <Chip>{firstWord.senses[0].pos[0]}</Chip>}
          </div>
        )}
      </div>

      <div className="lk-body">
        {loading && <p style={{ color: 'var(--ink-faint)', fontSize: 14 }}>Looking up…</p>}
        {error && <p style={{ color: 'var(--rate-again)', fontSize: 14 }}>{error}</p>}
        {result && !loading && !hasEntry && result.kanji.length === 0 && (
          <p style={{ color: 'var(--ink-faint)', fontSize: 14 }}>No dictionary entry found.</p>
        )}

        {senses.map((s, i) => (
          <div className="lk-sense" key={i}>
            <span className="n">{i + 1}</span>
            <span>
              {s.pos[0] && <span className="pos">{s.pos[0]} </span>}
              {s.gloss.join('; ')}
            </span>
          </div>
        ))}

        {result && result.names.length > 0 && (
          <>
            <div className="lk-section-h">Names</div>
            {result.names.slice(0, 5).map((n, i) => (
              <div className="lk-name" key={i} lang="ja">
                <span className="nm">{n.kanji.join('、') || n.kana.join('、')}</span>
                <span style={{ color: 'var(--ink-faint)' }}>{n.kana.join('、')}</span>{' '}
                <span style={{ color: 'var(--ink-soft)' }}>
                  {n.translations.map((t) => t.text.join(', ')).join('; ')}
                </span>
              </div>
            ))}
          </>
        )}

        {result && result.kanji.length > 0 && (
          <>
            <div className="lk-section-h">Kanji</div>
            {result.kanji.map((k, i) => (
              <div className="lk-kanji" key={i} style={{ marginBottom: 6 }}>
                <span className="kl" lang="ja">{k.literal}</span>
                <span>
                  <span style={{ color: 'var(--ink-soft)' }}>{k.meanings.slice(0, 4).join(', ')}</span>
                  <div className="kr" lang="ja">
                    {k.onyomi.length > 0 && <span style={{ marginRight: 8 }}>音 {k.onyomi.join('、')}</span>}
                    {k.kunyomi.length > 0 && <span>訓 {k.kunyomi.join('、')}</span>}
                  </div>
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {context?.sentencePlain && hasEntry && !added && (
        <div className="lk-sentence" lang="ja" title="Saved on the card">{context.sentencePlain}</div>
      )}

      <div className="lk-foot">
        {added ? (
          <span className="lk-added">
            <Icon.check s={18} /> Added to {targetDeck?.name ?? 'deck'}
            {audio === 'fetching' && <span className="lk-audio"> · getting audio…</span>}
            {audio === 'done' && <span className="lk-audio"> · audio added</span>}
          </span>
        ) : (
          <>
            <Btn
              variant="primary"
              size="sm"
              style={{ flex: 1, justifyContent: 'center' }}
              disabled={!hasEntry}
              onClick={onAddClick}
            >
              ＋ Add{targetDeck ? ` to ${targetDeck.name}` : ' to deck'}
            </Btn>
            <Btn size="sm" aria-label="Choose deck" title="Choose deck" disabled={!hasEntry} onClick={() => setPickerOpen(true)}>
              <Icon.decks s={16} />
            </Btn>
            <Btn size="sm" aria-label="listen" onClick={listen}>
              <Icon.sound s={16} />
            </Btn>
          </>
        )}
      </div>

      {pickerOpen && (
        <DeckPicker
          currentDeckId={targetDeck?.id ?? null}
          onPick={(id) => void addTo(id)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
