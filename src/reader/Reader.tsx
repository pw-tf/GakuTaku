import { useEffect, useMemo, useRef, useState } from 'react';
import { jpCore, proxy } from '../jp-core/client';
import type { LoadProgress } from '../dictionary/loader';
import type { FuriToken } from '../jp-core/worker';
import { usePrefs } from '../app/prefs';
import { useLookup } from '../jp-core/lookupService';
import { TokenizedText } from '../ui/FuriganaText';
import { LookupPopup, type MinedItem } from '../ui/LookupPopup';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';

type FontScale = 's' | 'm' | 'l';
const NEXT_SCALE: Record<FontScale, FontScale> = { s: 'm', m: 'l', l: 's' };

interface Props {
  title: string;
  chapterIndex: number;
  chapterCount: number;
  paragraphs: FuriToken[][];
  loadingChapter: boolean;
  restoreScroll: number;
  mined: MinedItem[];
  onMine: (item: MinedItem) => void;
  onReviewMined: () => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onScrollFraction: (f: number) => void;
  onClose: () => void;
}

export function Reader(props: Props) {
  const { furigana, setFurigana } = usePrefs();
  const lookup = useLookup();
  const [vertical, setVertical] = useState(false);
  const [fontScale, setFontScale] = useState<FontScale>('m');
  const [railOpen, setRailOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [scrollFrac, setScrollFrac] = useState(props.restoreScroll);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pct = props.chapterCount ? Math.round(((props.chapterIndex + Math.min(scrollFrac, 1)) / props.chapterCount) * 100) : 0;

  const [dictStatus, setDictStatus] = useState<'checking' | 'need' | 'loading' | 'ready'>('checking');
  const [dictPct, setDictPct] = useState(0);
  useEffect(() => {
    jpCore.isDictionaryLoaded().then((l) => setDictStatus(l ? 'ready' : 'need'));
  }, []);
  async function downloadDict() {
    setDictStatus('loading');
    try {
      await jpCore.ensureDictionary(proxy((p: LoadProgress) => setDictPct(p.total ? Math.round((p.loaded / p.total) * 100) : 0)));
      setDictStatus('ready');
    } catch {
      setDictStatus('need');
    }
  }

  // Token-key offsets per paragraph (global key across the chapter for active-word highlight).
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const p of props.paragraphs) {
      out.push(acc);
      acc += p.length;
    }
    return out;
  }, [props.paragraphs]);
  const advAvailable = useMemo(
    () => props.paragraphs.some((p) => p.some((t) => t.adv !== undefined)),
    [props.paragraphs],
  );

  // Restore scroll position once a chapter's paragraphs render (horizontal mode only).
  useEffect(() => {
    if (vertical || props.loadingChapter || !scrollRef.current || props.restoreScroll <= 0) return;
    const el = scrollRef.current;
    setScrollFrac(props.restoreScroll);
    requestAnimationFrame(() => {
      el.scrollTop = props.restoreScroll * (el.scrollHeight - el.clientHeight);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.paragraphs, props.loadingChapter]);

  function handleTap(token: FuriToken, key: number, anchor: DOMRect) {
    setActiveKey(key);
    lookup.lookupTerm(token.surface, anchor, token.basic);
  }
  function closeLook() {
    lookup.close();
    setActiveKey(null);
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const frac = max > 0 ? el.scrollTop / max : 0;
    setScrollFrac(frac);
    props.onScrollFraction(frac);
  }

  const renderParagraphs = () =>
    props.paragraphs.map((tokens, pi) => (
      <TokenizedText
        key={pi}
        tokens={tokens}
        density={furigana}
        advAvailable={advAvailable}
        activeKey={activeKey}
        indexOffset={offsets[pi]}
        onWordTap={handleTap}
      />
    ));

  return (
    <div className="reader">
      <div className="rd-top">
        <span className="back" onClick={props.onClose}>
          <Icon.chevL s={18} /> Library
        </span>
        <span style={{ width: 1, height: 22, background: 'var(--rule)' }} />
        <span className="rtitle" lang="ja">{props.title}</span>
        <button className="icon-btn" title="Previous chapter" onClick={props.onPrevChapter} disabled={props.chapterIndex <= 0}>
          <Icon.chevL s={16} />
        </button>
        <Chip>{props.chapterIndex + 1} / {props.chapterCount || '…'}</Chip>
        <button className="icon-btn" title="Next chapter" onClick={props.onNextChapter} disabled={props.chapterIndex >= props.chapterCount - 1}>
          <Icon.chevR s={16} />
        </button>
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
        {props.loadingChapter ? (
          <div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--ink-faint)' }}>Loading chapter…</p></div></div>
        ) : vertical ? (
          <div className="rd-vert">
            <div className={'vcol fs-' + fontScale} lang="ja">
              {props.paragraphs.map((tokens, pi) => (
                <span key={pi}>
                  <TokenizedText tokens={tokens} density={furigana} advAvailable={advAvailable} activeKey={activeKey} indexOffset={offsets[pi]} onWordTap={handleTap} />
                  {pi < props.paragraphs.length - 1 ? '　　' : ''}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="rd-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="rd-col">
              <Kicker accent style={{ display: 'block', textAlign: 'center', marginBottom: 18 }}>
                Chapter {props.chapterIndex + 1} · {pct}%
              </Kicker>
              <div className={'rd-body fs-' + fontScale} lang="ja">
                {props.paragraphs.length === 0 ? (
                  <p style={{ color: 'var(--ink-faint)' }}>(No text on this page.)</p>
                ) : (
                  renderParagraphs().map((node, pi) => <p key={pi}>{node}</p>)
                )}
              </div>
            </div>
          </div>
        )}

        {railOpen && (
          <div className="rail">
            <div className="rail-head">
              <span className="rh-t">Study</span>
              <button className="icon-btn" onClick={() => setRailOpen(false)}><Icon.close s={18} /></button>
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
                    <div style={{ height: 8, width: '100%', overflow: 'hidden', borderRadius: 99, background: 'var(--rule)' }}>
                      <div style={{ height: '100%', width: `${dictPct}%`, background: 'var(--accent)', transition: 'width .3s' }} />
                    </div>
                  ) : (
                    <Btn size="sm" onClick={downloadDict} disabled={dictStatus === 'checking'} style={{ justifyContent: 'center' }}>
                      Download dictionary
                    </Btn>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6 }}>Needed for word lookup. One-time, then offline.</div>
                </div>
              )}

              <hr className="hr" />
              <div className="rail-sec">
                <div className="rs-h"><Kicker>Mined this session</Kicker><Chip accent>{props.mined.length}</Chip></div>
                <div className="mined-list">
                  {props.mined.length === 0 && (
                    <div style={{ color: 'var(--ink-faint)', fontSize: 13, padding: '6px 2px' }}>Tap any word, then ＋ Add to deck.</div>
                  )}
                  {props.mined.map((m, i) => (
                    <div className="m-item" key={i}>
                      <span className="mt" lang="ja">{m.term}</span>
                      <span className="mr" lang="ja">{m.reading}</span>
                      <span className="mg">{m.gloss.split(';')[0]}</span>
                    </div>
                  ))}
                </div>
              </div>
              {props.mined.length > 0 && (
                <Btn variant="primary" style={{ justifyContent: 'center' }} onClick={props.onReviewMined}>
                  Review {props.mined.length} mined →
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

        <div className="rd-progress"><i style={{ width: pct + '%' }} /></div>
      </div>

      {lookup.isOpen && (
        <LookupPopup
          result={lookup.result}
          loading={lookup.loading}
          anchor={lookup.anchor}
          error={lookup.error}
          onClose={closeLook}
          onMine={props.onMine}
        />
      )}
    </div>
  );
}
