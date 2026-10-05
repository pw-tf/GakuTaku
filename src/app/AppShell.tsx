import { lazy, Suspense, useEffect, useState } from 'react';
import { useBackHandler } from './back';
import { usePrefs } from './prefs';
import { refreshReminders } from '../native/reminders';
import { col } from '../anki/appCollection';
import { ensureStockNotetypes } from '../anki/stock';
import { WHOLE_COLLECTION } from '../anki/queue';
import { Icon, type IconName } from '../ui/icons';
import { SettingsScreen } from '../ui/Settings';
import { Attribution } from '../ui/Attribution';
import { BackgroundTasks } from '../ui/BackgroundTasks';
import { LibraryScreen } from '../library/LibraryScreen';
import { DecksScreen, useDeckTree } from '../decks/DecksScreen';
import { AnalyticsScreen } from '../analytics/AnalyticsScreen';
import { ReviewScreen } from '../study/ReviewScreen';
import { useStreak } from '../analytics/analyticsHooks';
import type { MinedItem } from '../ui/LookupPopup';
import type { DocumentRecord } from '../db/schema';
import type { FeedArticle } from '../feeds/parse';
import type { FeedView } from '../feeds/useFeeds';

type View = 'library' | 'decks' | 'analytics' | 'settings' | 'credits';
type Overlay = null | 'reader' | 'article' | 'review';

const NAV: { id: 'library' | 'review' | 'decks' | 'analytics'; label: string; icon: IconName; overlay?: boolean }[] = [
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'review', label: 'Review', icon: 'review', overlay: true },
  { id: 'decks', label: 'Decks', icon: 'decks' },
  { id: 'analytics', label: 'Analytics', icon: 'chart' },
];

const TITLES: Record<View, [string, string]> = {
  library: ['Library', '本棚 · フィード'],
  decks: ['Decks', 'カード'],
  analytics: ['Analytics', '統計'],
  settings: ['Settings', '設定'],
  credits: ['Credits', 'クレジット'],
};

// Lazy-loaded so the heavy ePUB stack (epubjs/jszip) only loads when a book is opened.
const BookReader = lazy(() => import('../reader/BookReader').then((m) => ({ default: m.BookReader })));
const ArticleReader = lazy(() => import('../feeds/ArticleReader').then((m) => ({ default: m.ArticleReader })));

export function AppShell() {
  const [view, setView] = useState<View>('library');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [book, setBook] = useState<DocumentRecord | null>(null);
  const [articleView, setArticleView] = useState<{ article: FeedArticle; feed: FeedView } | null>(null);
  const [mined, setMined] = useState<MinedItem[]>([]);
  const [reviewSource, setReviewSource] = useState<{ deckId: number; title: string }>({ deckId: WHOLE_COLLECTION, title: 'All decks' });
  const [menuOpen, setMenuOpen] = useState(false);

  const { data: deckTree, loading: dueLoading } = useDeckTree();
  const dueCount = (deckTree ?? []).reduce((n, d) => n + d.newCount + d.learnCount + d.reviewCount, 0);
  const streak = useStreak();

  // Daily reminder counts and automatic backups follow the collection: refresh them on start, when
  // the app comes back, and after each study session.
  const reminder = usePrefs((p) => p.reminder);
  const reminderTime = usePrefs((p) => p.reminderTime);
  useEffect(() => {
    if (overlay === 'review') return;
    const id = setTimeout(() => {
      void refreshReminders(reminder, reminderTime);
      void import('../backup/auto').then((m) => m.maybeAutoBackup());
    }, 4000);
    return () => clearTimeout(id);
  }, [overlay, reminder, reminderTime]);

  // Collection housekeeping: the stock note types exist, and cards buried on an earlier day come
  // back (Anki's rollover unbury) — on start and whenever the app returns to the foreground.
  useEffect(() => {
    void ensureStockNotetypes(col).catch((e) => console.error(e));
    void col.unburyIfDayRolledOver().catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void col.unburyIfDayRolledOver().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Android back: close the innermost open thing; on a tab other than Library, go to Library.
  useBackHandler(view !== 'library', () => setView('library'));
  useBackHandler(overlay !== null, () => setOverlay(null));
  useBackHandler(menuOpen, () => setMenuOpen(false));

  function openBook(b: DocumentRecord) {
    setBook(b);
    setOverlay('reader');
  }
  function openArticle(article: FeedArticle, feed: FeedView) {
    setArticleView({ article, feed });
    setOverlay('article');
  }
  function mine(item: MinedItem) {
    setMined((m) => (m.find((x) => x.term === item.term) ? m : [...m, item]));
  }
  function startReview(deckId: number, title: string) {
    setReviewSource({ deckId, title });
    setOverlay('review');
  }
  function reviewMined() {
    const last = mined[mined.length - 1];
    if (last) startReview(last.deckId, 'Mined');
  }
  function navTo(item: (typeof NAV)[number]) {
    if (item.id === 'review') {
      startReview(WHOLE_COLLECTION, 'All decks');
      return;
    }
    setOverlay(null);
    setView(item.id);
  }

  const [title, subtitle] = TITLES[view];

  return (
    <div className={'shell' + (overlay ? ' reading' : '')}>
      <aside className="side">
        <div className="brand">
          <span className="mk" lang="ja">学</span>
          <span className="wd">GakuTaku</span>
        </div>
        {NAV.map((it) => {
          const I = Icon[it.icon];
          const on = it.id === 'review' ? overlay === 'review' : !overlay && view === it.id;
          return (
            <div key={it.id} className={'nav-item' + (on ? ' on' : '')} onClick={() => navTo(it)} title={it.label}>
              <span className="nav-ic"><I s={20} /></span>
              <span className="nav-lbl">{it.label}</span>
              {it.id === 'review' && dueCount > 0 && <span className="nav-badge">{dueCount}</span>}
            </div>
          );
        })}
        <div className="side-foot">
          <div className={'nav-item' + (!overlay && view === 'settings' ? ' on' : '')} onClick={() => { setOverlay(null); setView('settings'); }} title="Settings">
            <span className="nav-ic"><Icon.gear s={20} /></span>
            <span className="nav-lbl">Settings</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)}><Icon.menu s={20} /></button>
          <h1>{title}</h1>
          <span className="sub" lang="ja">{subtitle}</span>
          <span className="spacer" />
        </div>
        <div className="scroll">
          {view === 'library' && <LibraryScreen onOpenBook={openBook} onOpenArticle={openArticle} due={dueCount} dueLoading={dueLoading} streak={streak} />}
          {view === 'decks' && <DecksScreen onStudy={(id, name) => startReview(id, name)} />}
          {view === 'analytics' && <AnalyticsScreen />}
          {view === 'settings' && <SettingsScreen onOpenCredits={() => setView('credits')} />}
          {view === 'credits' && <Attribution />}
        </div>
      </div>

      {overlay === 'reader' && book && (
        <Suspense fallback={<div className="reader"><div className="rd-stage"><div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--ink-faint)' }}>Opening reader…</p></div></div></div></div>}>
          <BookReader
            doc={book}
            mined={mined}
            onMine={mine}
            onReviewMined={reviewMined}
            onClose={() => setOverlay(null)}
          />
        </Suspense>
      )}
      {overlay === 'article' && articleView && (
        <Suspense fallback={<div className="reader"><div className="rd-stage"><div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--ink-faint)' }}>Opening article…</p></div></div></div></div>}>
          <ArticleReader
            article={articleView.article}
            feed={articleView.feed}
            mined={mined}
            onMine={mine}
            onReviewMined={reviewMined}
            onClose={() => setOverlay(null)}
          />
        </Suspense>
      )}
      {overlay === 'review' && (
        <ReviewScreen deckId={reviewSource.deckId} title={reviewSource.title} onExit={() => setOverlay(null)} onStudy={(id, name) => startReview(id, name)} />
      )}

      <BackgroundTasks />

      {/* Phone side menu: the sidebar's destinations and settings (the sidebar is hidden on small screens). */}
      {menuOpen && (
        <div className="mobile-menu-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="mobile-menu" onClick={(e) => e.stopPropagation()}>
            <div className="mm-head">
              <span className="brand"><span className="mk" lang="ja">学</span><span className="wd">GakuTaku</span></span>
              <button className="icon-btn" aria-label="Close menu" onClick={() => setMenuOpen(false)}><Icon.close s={18} /></button>
            </div>
            <nav className="mm-nav">
              {NAV.map((it) => {
                const I = Icon[it.icon];
                const on = it.id === 'review' ? overlay === 'review' : !overlay && view === it.id;
                return (
                  <button
                    key={it.id}
                    className={'mm-item' + (on ? ' on' : '')}
                    onClick={() => {
                      setMenuOpen(false);
                      navTo(it);
                    }}
                  >
                    <I s={20} />
                    <span>{it.label}</span>
                    {it.id === 'review' && dueCount > 0 && <span className="nav-badge">{dueCount}</span>}
                  </button>
                );
              })}
            </nav>
            <div className="mm-sep" />
            <button
              className={'mm-item' + (!overlay && view === 'settings' ? ' on' : '')}
              onClick={() => {
                setMenuOpen(false);
                setOverlay(null);
                setView('settings');
              }}
            >
              <Icon.gear s={20} />
              <span>Settings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
