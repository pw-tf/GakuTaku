import { useEffect, useState } from 'react';
import { jpCore, proxy } from '../jp-core/client';
import type { LoadProgress } from '../dictionary/loader';
import type { FuriToken } from '../jp-core/worker';
import { usePrefs } from '../app/prefs';
import { useLookup } from '../jp-core/lookupService';
import { FuriganaText } from '../ui/FuriganaText';
import { LookupPopup, type MinedItem } from '../ui/LookupPopup';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { SAMPLE_PARAGRAPHS } from './sampleText';
import type { SampleBook } from '../data/sample';

type FontScale = 's' | 'm' | 'l';
const NEXT_SCALE: Record<FontScale, FontScale> = { s: 'm', m: 'l', l: 's' };

interface Props {
  book: SampleBook;
  mined: MinedItem[];
  onMine: (item: MinedItem) => void;
  onReviewMined: () => void;
  onClose: () => void;
}

export function Reader({ book, mined, onMine, onReviewMined, onClose }: Props) {
  const { furigana, setFurigana } = usePrefs();
  const lookup = useLookup();
  const [vertical, setVertical] = useState(false);
  const [fontScale, setFontScale] = useState<FontScale>('m');
  const [railOpen, setRailOpen] = useState(false);
  const [active, setActive] = useState<{ p: number; i: number } | null>(null);

  // Dictionary download status (lookups need it; furigana/tokenize don't).
  const [dictStatus, setDictStatus] = useState<'checking' | 'need' | 'loading' | 'ready'>('checking');
  const [dictPct, setDictPct] = useState(0);
  useEffect(() => {
    jpCore.isDictionaryLoaded().then((l) => setDictStatus(l ? 'ready' : 'need'));
  }, []);
  async function downloadDict() {
    setDictStatus('loading');
    try {
      await jpCore.ensureDictionary(
        proxy((p: LoadProgress) => setDictPct(p.total ? Math.round((p.loaded / p.total) * 100) : 0)),
      );
      setDictStatus('ready');
    } catch {
      setDictStatus('need');
    }
  }

  function handleTap(p: number, token: FuriToken, i: number, anchor: DOMRect) {
    setActive({ p, i });
    lookup.lookupTerm(token.surface, anchor, token.basic);
  }
  function closeLook() {
    lookup.close();
    setActive(null);
  }

  const paras = SAMPLE_PARAGRAPHS;
  const renderPara = (text: string, pi: number) => (
    <FuriganaText
      text={text}
      density={furigana}
      activeIndex={active?.p === pi ? active.i : null}
      onWordTap={(tok, i, anchor) => handleTap(pi, tok, i, anchor)}
    />
  );

  return (
    <div className="reader">
      <div className="rd-top">
        <span className="back" onClick={onClose}>
          <Icon.chevL s={18} /> Library
        </span>
        <span style={{ width: 1, height: 22, background: 'var(--rule)' }} />
        <span className="rtitle" lang="ja">{book.title}</span>
        <Chip>{book.chapter}</Chip>
        <span className="spacer" />
        <div className="rd-ctrl">
          <button className="icon-btn" title="Text size" onClick={() => setFontScale(NEXT_SCALE[fontScale])}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: fontScale === 's' ? 14 : fontScale === 'm' ? 17 : 20, fontWeight: 600 }}>A</span>
          </button>
          <button className={'icon-btn' + (vertical ? ' on' : '')} title="Vertical / horizontal" onClick={() => setVertical((v) => !v)}>
            {vertical ? <Icon.vertical s={20} /> : <Icon.horizontal s={20} />}
          </button>
          <button className={'icon-btn' + (railOpen ? ' on' : '')} title="Study panel" onClick={() => setRailOpen((o) => !o)}>
            <Icon.study s={20} />
          </button>
        </div>
      </div>

      <div className="rd-stage">
        {vertical ? (
          <div className="rd-vert">
            <div className={'vcol fs-' + fontScale} lang="ja">
              <span className="ch-no">一　</span>
              {paras.map((p, pi) => (
                <span key={pi}>
                  {renderPara(p, pi)}
                  {pi < paras.length - 1 ? '　　' : ''}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="rd-scroll">
            <div className="rd-col">
              <Kicker accent style={{ display: 'block', textAlign: 'center', marginBottom: 18 }}>
                {book.chapter} · {book.pct}%
              </Kicker>
              <div className="ch-no">一</div>
              <div className={'rd-body fs-' + fontScale} lang="ja">
                {paras.map((p, pi) => (
                  <p key={pi}>{renderPara(p, pi)}</p>
                ))}
              </div>
            </div>
          </div>
        )}

        {railOpen && (
          <div className="rail">
            <div className="rail-head">
              <span className="rh-t">Study</span>
              <button className="icon-btn" onClick={() => setRailOpen(false)}>
                <Icon.close s={18} />
              </button>
            </div>
            <div className="rail-scroll">
              <div className="rail-sec">
                <div className="rs-h"><Kicker>Furigana density</Kicker></div>
                <div className="density-seg">
                  {(['all', 'n3', 'off'] as const).map((v) => (
                    <div key={v} className={'d' + (furigana === v ? ' on' : '')} onClick={() => setFurigana(v)}>
                      {v === 'all' ? 'All' : v === 'n3' ? 'N3+' : 'Off'}
                    </div>
                  ))}
                </div>
              </div>

              {dictStatus !== 'ready' && (
                <div className="rail-sec">
                  <div className="rs-h"><Kicker>Dictionary</Kicker></div>
                  {dictStatus === 'loading' ? (
                    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--rule)' }}>
                      <div style={{ height: '100%', width: `${dictPct}%`, background: 'var(--accent)', transition: 'width .3s' }} />
                    </div>
                  ) : (
                    <Btn size="sm" onClick={downloadDict} disabled={dictStatus === 'checking'} style={{ justifyContent: 'center' }}>
                      Download dictionary
                    </Btn>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6 }}>
                    Needed for word lookup. One-time, then offline.
                  </div>
                </div>
              )}

              <hr className="hr" />
              <div className="rail-sec">
                <div className="rs-h"><Kicker>Mined this session</Kicker><Chip accent>{mined.length}</Chip></div>
                <div className="mined-list">
                  {mined.length === 0 && (
                    <div style={{ color: 'var(--ink-faint)', fontSize: 13, padding: '6px 2px' }}>
                      Tap any word, then ＋ Add to deck.
                    </div>
                  )}
                  {mined.map((m, i) => (
                    <div className="m-item" key={i}>
                      <span className="mt" lang="ja">{m.term}</span>
                      <span className="mr" lang="ja">{m.reading}</span>
                      <span className="mg">{m.gloss.split(';')[0]}</span>
                    </div>
                  ))}
                </div>
              </div>
              {mined.length > 0 && (
                <Btn variant="primary" style={{ justifyContent: 'center' }} onClick={onReviewMined}>
                  Review {mined.length} mined →
                </Btn>
              )}

              <hr className="hr" />
              <div className="rail-sec">
                <div className="rs-h"><Kicker>Reading orientation</Kicker></div>
                <div className="density-seg">
                  <div className={'d' + (!vertical ? ' on' : '')} onClick={() => setVertical(false)}>Horizontal</div>
                  <div className={'d' + (vertical ? ' on' : '')} onClick={() => setVertical(true)} lang="ja">縦書き</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="rd-progress"><i style={{ width: book.pct + '%' }} /></div>
      </div>

      {lookup.isOpen && (
        <LookupPopup
          result={lookup.result}
          loading={lookup.loading}
          anchor={lookup.anchor}
          error={lookup.error}
          onClose={closeLook}
          onMine={onMine}
        />
      )}
    </div>
  );
}
