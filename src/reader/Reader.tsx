import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { jpCore, proxy } from '../jp-core/client';
import type { LoadProgress } from '../dictionary/loader';
import type { FuriToken } from '../jp-core/worker';
import { usePrefs, type ReaderFontScale, type ReaderOrientation, type ReaderWidth } from '../app/prefs';
import { useTasks, isTaskRunning } from '../app/tasks';
import { useLookup } from '../jp-core/lookupService';
import { TokenizedText } from '../ui/FuriganaText';
import { LookupPopup, type MinedItem } from '../ui/LookupPopup';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import type { ReadingPos, RestoreTarget } from './useBook';

const NEXT_SCALE: Record<ReaderFontScale, ReaderFontScale> = { s: 'm', m: 'l', l: 's' };
/** Inter-page gutter for horizontal multi-column paging (px). */
const PAGE_GAP = 56;
const SWIPE_MIN = 44;
/** Wheel/trackpad paging: flip once this much delta accumulates… */
const WHEEL_MIN = 60;
/** …then swallow the gesture's inertia tail so one flick turns one page. */
const WHEEL_COOLDOWN_MS = 350;
/** A quiet gap this long starts a fresh gesture (drops a stale part-accumulated delta). */
const WHEEL_GESTURE_GAP_MS = 300;
/** Background-task id for the one-time offline dictionary download (shared with the shell banner). */
const DICT_TASK = 'dict-download';
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

interface Props {
  title: string;
  direction: 'ltr' | 'rtl';
  chapterIndex: number;
  chapterCount: number;
  paragraphs: FuriToken[][];
  loadingChapter: boolean;
  restore: RestoreTarget;
  mined: MinedItem[];
  onMine: (item: MinedItem) => void;
  onReviewMined: () => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onPrevChapterEnd: () => void;
  onProgress: (pos: ReadingPos, immediate?: boolean) => void;
  onClose: () => void;
}

/** Geometry of the paged content, read straight from the DOM (transform-independent). */
interface Geom {
  view: HTMLDivElement;
  pages: HTMLDivElement;
  W: number;
  stride: number;
  total: number;
  count: number;
  /** Vertical only: start-side (right) padding — where the first text line begins. 0 when horizontal. */
  padStart: number;
}
/** A paragraph anchor's position along the reading axis (px from the chapter's start). */
interface Anchor {
  pi: number;
  pos: number;
}

export function Reader(props: Props) {
  const { furigana, setFurigana } = usePrefs();
  const prefs = usePrefs();
  const lookup = useLookup();

  // Layout prefs seed from the persisted store (and, only when never chosen, the book's own
  // direction); they're owned locally while open and written back so choices survive sessions.
  const [orientation, setOrientationState] = useState<ReaderOrientation>(
    prefs.readerOrientation ?? (props.direction === 'rtl' ? 'vertical' : 'horizontal'),
  );
  const [flow, setFlowState] = useState(prefs.readerFlow);
  const [fontScale, setFontScaleState] = useState<ReaderFontScale>(prefs.readerFontScale);
  const [width, setWidthState] = useState<ReaderWidth>(prefs.readerWidth);
  const setOrientation = (o: ReaderOrientation) => { setOrientationState(o); prefs.setReaderOrientation(o); };
  const setFlow = (f: typeof flow) => { setFlowState(f); prefs.setReaderFlow(f); };
  const setFontScale = (s: ReaderFontScale) => { setFontScaleState(s); prefs.setReaderFontScale(s); };
  const setWidth = (w: ReaderWidth) => { setWidthState(w); prefs.setReaderWidth(w); };

  // Vertical text is always paged (a horizontal scroll of tategaki reads poorly).
  const paged = orientation === 'vertical' || flow === 'paged';
  const vertical = orientation === 'vertical';

  const [railOpen, setRailOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [metrics, setMetrics] = useState({ total: 0, viewSize: 0, stride: 0, padStart: 0 });
  // Only user page-turns animate; programmatic jumps (restore, chapter load, resize) are instant.
  const [instant, setInstant] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  /** Last known reading position, so a layout/mode change can re-anchor to the same spot. */
  const lastPos = useRef({ pi: 0, frac: 0 });
  /** Set by a user action that should persist the resulting position; consumed once on settle. */
  const pendingSave = useRef(false);
  /** Swallow the scroll event caused by a programmatic restore (so it can't clobber the saved spot). */
  const ignoreScroll = useRef(false);

  const [dictStatus, setDictStatus] = useState<'checking' | 'need' | 'loading' | 'ready'>('checking');
  const [dictPct, setDictPct] = useState(0);
  useEffect(() => {
    // If a download is already running (e.g. started, then the reader was reopened), reflect that.
    if (isTaskRunning(DICT_TASK)) {
      setDictStatus('loading');
      return;
    }
    jpCore.isDictionaryLoaded().then((l) => setDictStatus(l ? 'ready' : 'need'));
  }, []);
  // The download may have been started by an earlier Reader mount; the shared task is the source of
  // truth, so mirror its progress and completion here rather than only tracking our own call.
  const dictTask = useTasks((s) => s.tasks.find((t) => t.id === DICT_TASK));
  useEffect(() => {
    if (!dictTask) return;
    if (dictTask.status === 'running') {
      setDictStatus('loading');
      if (dictTask.total > 0) setDictPct(Math.round((dictTask.done / dictTask.total) * 100));
    } else if (dictTask.status === 'success') setDictStatus('ready');
    else setDictStatus('need');
  }, [dictTask]);
  async function downloadDict() {
    if (isTaskRunning(DICT_TASK)) return;
    setDictStatus('loading');
    const tasks = useTasks.getState();
    tasks.start(DICT_TASK, 'Downloading dictionary');
    tasks.update(DICT_TASK, { message: 'For offline word lookup — one time.' });
    try {
      await jpCore.ensureDictionary(proxy((p: LoadProgress) => {
        tasks.update(DICT_TASK, { done: p.loaded, total: p.total });
      }));
      tasks.finish(DICT_TASK, 'success', 'Dictionary ready — lookup works offline.');
    } catch (err) {
      tasks.finish(DICT_TASK, 'error', err instanceof Error ? err.message : 'Dictionary download failed.');
    }
  }

  // Global token-key offset per paragraph (active-word highlight maps across the whole chapter).
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

  // ---- Geometry & paragraph anchors ----------------------------------------

  function geom(): Geom | null {
    const view = viewRef.current;
    const pages = pagesRef.current;
    if (!view || !pages) return null;
    const W = Math.max(1, view.clientWidth);
    const total = pages.scrollWidth;
    if (vertical) {
      // Tategaki is a continuous vertical-rl flow (no CSS fragmentation), so a page is a window
      // over it. Quantize the window advance to whole line-heights or every page boundary slices
      // a line of text in half; the leftover margins are hidden by the edge masks.
      const cs = getComputedStyle(pages);
      const padStart = parseFloat(cs.paddingRight) || 0;
      const padEnd = parseFloat(cs.paddingLeft) || 0;
      let lineAdv = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineAdv) || lineAdv <= 0) lineAdv = 2.2;
      if (lineAdv < 8) lineAdv *= parseFloat(cs.fontSize) || 16; // unitless line-height
      const usable = Math.max(lineAdv, W - padStart - padEnd);
      const stride = Math.max(1, Math.floor(usable / lineAdv)) * lineAdv;
      const content = Math.max(1, total - padStart - padEnd);
      const count = Math.max(1, Math.ceil((content - 0.5) / stride));
      return { view, pages, W, stride, total, count, padStart };
    }
    const stride = W + PAGE_GAP;
    const count = Math.max(1, Math.round((total + PAGE_GAP) / stride));
    return { view, pages, W, stride, total, count, padStart: 0 };
  }

  /**
   * Rect of a paragraph's first glyph via a Range over its first character. A single glyph lives in
   * exactly one column, so this is fragmentation-proof — unlike a <p>'s bounding box, which spans
   * every page the paragraph crosses in multi-column layout.
   */
  function firstGlyphRect(p: HTMLElement): DOMRect | null {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const range = document.createRange();
    if (node && (node.textContent?.length ?? 0) > 0) {
      range.setStart(node, 0);
      range.setEnd(node, 1);
    } else {
      range.selectNodeContents(p);
      range.collapse(true);
    }
    const list = range.getClientRects();
    return list.length ? list[0] : range.getBoundingClientRect();
  }

  /** Each paragraph's start as a distance along the reading axis (handles RTL vertical). */
  function pagedAnchors(g: Geom): Anchor[] {
    const pr = g.pages.getBoundingClientRect();
    const out: Anchor[] = [];
    for (const el of g.pages.querySelectorAll<HTMLElement>('p[data-pi]')) {
      const r = firstGlyphRect(el);
      if (!r) continue;
      out.push({ pi: Number(el.dataset.pi), pos: vertical ? pr.left + g.total - r.right : r.left - pr.left });
    }
    return out;
  }

  function scrollAnchors(el: HTMLDivElement): Anchor[] {
    const top = el.getBoundingClientRect().top;
    const out: Anchor[] = [];
    for (const p of el.querySelectorAll<HTMLElement>('p[data-pi]')) {
      const r = firstGlyphRect(p);
      if (r) out.push({ pi: Number(p.dataset.pi), pos: r.top - top + el.scrollTop });
    }
    return out;
  }

  /** Leading paragraph (+ fraction into it) at a position along an axis. Robust to non-monotonic
   *  anchor positions: sorts and scans fully rather than breaking at the first one past `at`. */
  function leadAt(anchors: Anchor[], at: number, end: number): { paragraphIndex: number; fraction: number } {
    if (anchors.length === 0) return { paragraphIndex: 0, fraction: 0 };
    const sorted = [...anchors].sort((a, b) => a.pos - b.pos);
    let lead = sorted[0];
    for (const a of sorted) if (a.pos <= at + 1) lead = a;
    let nextPos = end;
    for (const a of sorted) if (a.pos > lead.pos + 1) { nextPos = a.pos; break; }
    const seg = nextPos - lead.pos;
    return { paragraphIndex: lead.pi, fraction: seg > 0 ? clamp01((at - lead.pos) / seg) : 0 };
  }

  /** Axis position of a paragraph anchor (+ fraction toward the next paragraph), for restoring. */
  function axisOf(anchors: Anchor[], pi: number, fraction: number, end: number): number {
    const a = anchors.find((x) => x.pi === pi);
    if (!a) return 0;
    let nextPos = end;
    for (const s of [...anchors].sort((x, y) => x.pos - y.pos)) if (s.pos > a.pos + 1) { nextPos = s.pos; break; }
    return a.pos + clamp01(fraction) * (nextPos - a.pos);
  }

  const translate = (() => {
    if (!paged) return undefined;
    // Vertical-rl content starts at the element's RIGHT edge; slide so the current page's first
    // line lands at the viewport's right margin, advancing right→left by one stride per page.
    if (vertical) return `translateX(${page * metrics.stride - (metrics.total - metrics.viewSize)}px)`;
    return `translateX(${-page * metrics.stride}px)`;
  })();

  // ---- Position reporting (paragraph-anchored, exact round-trip) -------------

  const reportProgress = useCallback((immediate = false) => {
    if (paged) {
      const g = geom();
      if (!g) return;
      const lead = leadAt(pagedAnchors(g), g.padStart + page * g.stride, g.total);
      lastPos.current = { pi: lead.paragraphIndex, frac: lead.fraction };
      props.onProgress({ ...lead, chapterFraction: g.count > 1 ? page / (g.count - 1) : 0 }, immediate);
    } else {
      const el = scrollRef.current;
      if (!el) return;
      const lead = leadAt(scrollAnchors(el), el.scrollTop, el.scrollHeight);
      lastPos.current = { pi: lead.paragraphIndex, frac: lead.fraction };
      const max = el.scrollHeight - el.clientHeight;
      props.onProgress({ ...lead, chapterFraction: max > 0 ? el.scrollTop / max : 0 }, immediate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, vertical, page]);

  /** Move the view to a restore target. Never persists — restoring must not overwrite the saved spot. */
  const applyRestore = useCallback((t: RestoreTarget) => {
    if (t.kind === 'anchor') lastPos.current = { pi: t.paragraphIndex, frac: t.fraction };
    else if (t.kind === 'top') lastPos.current = { pi: 0, frac: 0 };
    setInstant(true); // jump, don't slide, to a restored position
    if (paged) {
      const g = geom();
      if (!g) return;
      let target = 0;
      if (t.kind === 'end') target = g.count - 1;
      else if (t.kind === 'anchor') {
        const axis = axisOf(pagedAnchors(g), t.paragraphIndex, t.fraction, g.total);
        // Vertical positions are measured from the element edge, so shift past the start padding
        // and floor: an anchor N lines in is on page floor(N / linesPerPage), never the next one.
        target = vertical ? Math.floor((axis - g.padStart) / g.stride + 0.001) : Math.round(axis / g.stride);
      }
      setPage(Math.min(Math.max(0, target), g.count - 1));
    } else {
      const el = scrollRef.current;
      if (!el) return;
      ignoreScroll.current = true;
      if (t.kind === 'end') el.scrollTop = el.scrollHeight;
      else if (t.kind === 'top') el.scrollTop = 0;
      else el.scrollTop = axisOf(scrollAnchors(el), t.paragraphIndex, t.fraction, el.scrollHeight);
      requestAnimationFrame(() => (ignoreScroll.current = false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, vertical]);

  const measure = useCallback(() => {
    const view = viewRef.current;
    const pages = pagesRef.current;
    if (!paged || !view || !pages) return;
    const W = Math.max(1, view.clientWidth);
    if (vertical) {
      pages.style.columnWidth = '';
      pages.style.columnGap = '';
    } else {
      pages.style.columnWidth = `${W}px`;
      pages.style.columnGap = `${PAGE_GAP}px`;
    }
    const g = geom();
    if (!g) return;
    setInstant(true); // re-layout shouldn't animate the page jump
    setMetrics({ total: g.total, viewSize: g.W, stride: g.stride, padStart: g.padStart });
    setPageCount(g.count);
    setPage((p) => Math.min(p, g.count - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, vertical]);

  // Re-enable the slide one frame after an instant jump has painted (transform unchanged → no animation).
  useEffect(() => {
    if (!instant) return;
    const id = requestAnimationFrame(() => setInstant(false));
    return () => cancelAnimationFrame(id);
  }, [instant]);

  // Measure on layout-affecting changes (and when a chapter's content arrives).
  useLayoutEffect(() => {
    if (!props.loadingChapter) measure();
  }, [measure, fontScale, width, furigana, props.paragraphs, props.loadingChapter]);

  // Land on the saved/target position once a chapter's paragraphs are on screen (no persist).
  useLayoutEffect(() => {
    if (!props.loadingChapter) applyRestore(props.restore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.paragraphs, props.restore]);

  // Re-anchor to the current reading spot when the reading MODE actually changes under the reader.
  // Compares against the previous mode (StrictMode-proof) so it never fires on mount/remount, which
  // would otherwise clobber a fresh restore. Preserves the fraction so single-paragraph chapters
  // don't snap to the start.
  const prevMode = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = `${orientation}|${flow}|${fontScale}|${width}`;
    if (prevMode.current === null || prevMode.current === key) { prevMode.current = key; return; }
    prevMode.current = key;
    if (!props.loadingChapter) applyRestore({ kind: 'anchor', paragraphIndex: lastPos.current.pi, fraction: lastPos.current.frac });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orientation, flow, fontScale, width, props.loadingChapter]);

  // Persist only after a user-initiated move (page turn or chapter change) settles.
  useEffect(() => {
    if (props.loadingChapter || !pendingSave.current) return;
    pendingSave.current = false;
    const id = requestAnimationFrame(() => reportProgress(true));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, props.chapterIndex, props.loadingChapter]);

  // Re-measure on container resize.
  useEffect(() => {
    const view = viewRef.current;
    if (!paged || !view) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(view);
    return () => ro.disconnect();
  }, [paged, measure]);

  // ---- Navigation -----------------------------------------------------------

  const nextPage = useCallback(() => {
    pendingSave.current = true;
    if (page < pageCount - 1) setPage(page + 1);
    else props.onNextChapter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageCount]);
  const prevPage = useCallback(() => {
    pendingSave.current = true;
    if (page > 0) setPage(page - 1);
    else props.onPrevChapterEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  const goPrevChapter = () => { pendingSave.current = true; props.onPrevChapter(); };
  const goNextChapter = () => { pendingSave.current = true; props.onNextChapter(); };

  // Arrow keys (vertical RTL flips left/right).
  useEffect(() => {
    if (!paged) return;
    function onKey(e: KeyboardEvent) {
      const fwd = vertical ? ['ArrowLeft', 'ArrowDown'] : ['ArrowRight', 'ArrowDown'];
      const back = vertical ? ['ArrowRight', 'ArrowUp'] : ['ArrowLeft', 'ArrowUp'];
      if (fwd.includes(e.key)) { e.preventDefault(); nextPage(); }
      else if (back.includes(e.key)) { e.preventDefault(); prevPage(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paged, vertical, nextPage, prevPage]);

  function onTouchEnd(e: React.TouchEvent) {
    const sx = touchX.current;
    touchX.current = null;
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) < SWIPE_MIN) return;
    // Tategaki pages advance right→left (RTL), so a rightward swipe turns forward — same flip as
    // the on-screen nav arrows and the arrow keys.
    const fwd = vertical ? dx > 0 : dx < 0;
    if (fwd) nextPage();
    else prevPage();
  }

  /** Wheel/trackpad paging: the paged views clip (no native scroll), so map scroll to page turns. */
  const wheel = useRef({ acc: 0, until: 0, last: 0 });
  function onWheel(e: React.WheelEvent) {
    if (!paged) return;
    const now = performance.now();
    const w = wheel.current;
    if (now < w.until) {
      w.last = now;
      return; // inertia tail of the flip we just made
    }
    if (now - w.last > WHEEL_GESTURE_GAP_MS) w.acc = 0;
    w.last = now;
    const scale = e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? 120 : 1; // lines/pages → px
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    // Scrolling down always reads forward; a horizontal pan follows the page-advance direction
    // (leftward in vertical RTL, rightward in horizontal LTR).
    const delta = (horiz ? (vertical ? -e.deltaX : e.deltaX) : e.deltaY) * scale;
    w.acc += delta;
    if (Math.abs(w.acc) < WHEEL_MIN) return;
    const fwd = w.acc > 0;
    w.acc = 0;
    w.until = now + WHEEL_COOLDOWN_MS;
    if (fwd) nextPage();
    else prevPage();
  }

  function handleTap(token: FuriToken, key: number, anchor: DOMRect) {
    setActiveKey(key);
    lookup.lookupTerm(token.surface, anchor, token.basic);
  }
  function closeLook() {
    lookup.close();
    setActiveKey(null);
  }

  function onScroll() {
    if (paged) return;
    if (ignoreScroll.current) return;
    reportProgress(false);
  }

  const pct = props.chapterCount
    ? Math.round(((props.chapterIndex + (paged ? (pageCount > 1 ? page / (pageCount - 1) : 0) : 0)) / props.chapterCount) * 100)
    : 0;

  const paras = () =>
    props.paragraphs.map((tokens, pi) => (
      <p key={pi} data-pi={pi}>
        <TokenizedText
          tokens={tokens}
          density={furigana}
          advAvailable={advAvailable}
          activeKey={activeKey}
          indexOffset={offsets[pi]}
          onWordTap={handleTap}
        />
      </p>
    ));

  return (
    <div className="reader">
      <div className="rd-top">
        <span className="back" onClick={props.onClose}>
          <Icon.chevL s={18} /> <span className="back-lbl">Library</span>
        </span>
        <span style={{ width: 1, height: 22, background: 'var(--rule)' }} />
        <span className="rtitle" lang="ja">{props.title}</span>
        <button className="icon-btn" title="Previous chapter" onClick={goPrevChapter} disabled={props.chapterIndex <= 0}>
          <Icon.chevL s={16} />
        </button>
        <Chip>{props.chapterIndex + 1} / {props.chapterCount || '…'}</Chip>
        <button className="icon-btn" title="Next chapter" onClick={goNextChapter} disabled={props.chapterIndex >= props.chapterCount - 1}>
          <Icon.chevR s={16} />
        </button>
        <span className="spacer" />
        <div className="rd-ctrl">
          <button className="icon-btn" title="Text size" onClick={() => setFontScale(NEXT_SCALE[fontScale])}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: fontScale === 's' ? 14 : fontScale === 'm' ? 17 : 20, fontWeight: 600 }}>A</span>
          </button>
          <button className={'icon-btn' + (vertical ? ' on' : '')} title="Vertical / horizontal" onClick={() => setOrientation(vertical ? 'horizontal' : 'vertical')}>
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
        ) : paged ? (
          <div
            className={'rd-page-view' + (vertical ? ' vertical' : '')}
            ref={viewRef}
            onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
            onTouchEnd={onTouchEnd}
            onWheel={onWheel}
          >
            <div className={`rd-pages fs-${fontScale} w-${width}`} ref={pagesRef} lang="ja" style={{ transform: translate, transition: instant ? 'none' : 'transform .26s ease' }}>
              {props.paragraphs.length === 0 ? <p style={{ color: 'var(--ink-faint)' }}>(No text on this page.)</p> : paras()}
            </div>
            {vertical && metrics.stride > 0 && (
              <>
                {/* Continuous tategaki flow means the neighbouring page's edge line sits just past
                    the stride boundary — these opaque margins hide it instead of showing a sliver. */}
                <div className="rd-edge-mask" style={{ left: 0, width: Math.max(0, metrics.viewSize - metrics.padStart - metrics.stride) }} />
                <div className="rd-edge-mask" style={{ right: 0, width: metrics.padStart }} />
              </>
            )}
            {pageCount > 1 && (
              <>
                <button className="rd-page-nav left" aria-label="Page left" onClick={vertical ? nextPage : prevPage}>
                  <Icon.chevL s={22} />
                </button>
                <button className="rd-page-nav right" aria-label="Page right" onClick={vertical ? prevPage : nextPage}>
                  <Icon.chevR s={22} />
                </button>
              </>
            )}
            <div className="rd-page-count">{page + 1} / {pageCount}</div>
          </div>
        ) : (
          <div className="rd-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className={`rd-col w-${width}`}>
              <Kicker accent style={{ display: 'block', textAlign: 'center', marginBottom: 18 }}>
                Chapter {props.chapterIndex + 1} · {pct}%
              </Kicker>
              <div className={'rd-body fs-' + fontScale} lang="ja">
                {props.paragraphs.length === 0 ? (
                  <p style={{ color: 'var(--ink-faint)' }}>(No text on this page.)</p>
                ) : (
                  paras()
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
                  <div className={'d' + (!vertical ? ' on' : '')} onClick={() => setOrientation('horizontal')}>Horizontal</div>
                  <div className={'d' + (vertical ? ' on' : '')} onClick={() => setOrientation('vertical')} lang="ja">縦書き</div>
                </div>
              </div>

              {!vertical && (
                <div className="rail-sec">
                  <div className="rs-h"><Kicker>Page flow</Kicker></div>
                  <div className="density-seg">
                    <div className={'d' + (flow === 'paged' ? ' on' : '')} onClick={() => setFlow('paged')}>Paged</div>
                    <div className={'d' + (flow === 'scroll' ? ' on' : '')} onClick={() => setFlow('scroll')}>Scroll</div>
                  </div>
                </div>
              )}

              <div className="rail-sec">
                <div className="rs-h"><Kicker>Text width</Kicker></div>
                <div className="density-seg">
                  <div className={'d' + (width === 'normal' ? ' on' : '')} onClick={() => setWidth('normal')}>Normal</div>
                  <div className={'d' + (width === 'wide' ? ' on' : '')} onClick={() => setWidth('wide')}>Wide</div>
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
