import { lazy, Suspense, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Icon, type IconName } from '../ui/icons';
import { Settings, SettingsContent } from '../ui/Settings';
import { Attribution } from '../ui/Attribution';
import { LibraryScreen } from '../library/LibraryScreen';
import { DecksScreen } from '../srs/DecksScreen';
import { AnalyticsScreen } from '../analytics/AnalyticsScreen';
import { ReviewScreen, type ReviewCard } from '../srs/ReviewScreen';
import type { MinedItem } from '../ui/LookupPopup';
import type { DocumentRecord } from '../sync/AppSchema';
import { SAMPLE_QUEUE, SAMPLE_STATS, type SampleDeck } from '../data/sample';

type View = 'library' | 'decks' | 'analytics' | 'credits';
type Overlay = null | 'reader' | 'review';

const NAV: { id: 'library' | 'review' | 'decks' | 'analytics'; label: string; icon: IconName; overlay?: boolean }[] = [
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'review', label: 'Review', icon: 'review', overlay: true },
  { id: 'decks', label: 'Decks', icon: 'decks' },
  { id: 'analytics', label: 'Analytics', icon: 'chart' },
];

const DUE = 53; // sample; real due count comes from FSRS in M4
const TITLES: Record<View, [string, string]> = {
  library: ['Library', '本棚 · フィード'],
  decks: ['Decks', 'カード'],
  analytics: ['Analytics', '統計'],
  credits: ['Credits', 'クレジット'],
};

// Lazy-loaded so the heavy ePUB stack (epubjs/jszip) only loads when a book is opened.
const BookReader = lazy(() => import('../reader/BookReader').then((m) => ({ default: m.BookReader })));

const sampleQueueCards = (): ReviewCard[] =>
  SAMPLE_QUEUE.map((e) => ({ term: e.term, reading: e.reading, pos: e.senses[0][0], gloss: e.senses[0][1], jlpt: e.jlpt }));

const minedToCards = (mined: MinedItem[]): ReviewCard[] =>
  mined.map((m) => ({ term: m.term, reading: m.reading, pos: '', gloss: m.gloss }));

export function AppShell() {
  const { session, signOut } = useAuth();
  const [view, setView] = useState<View>('library');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [book, setBook] = useState<DocumentRecord | null>(null);
  const [mined, setMined] = useState<MinedItem[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewCard[]>([]);
  const [reviewDeck, setReviewDeck] = useState('Reading · Mined');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  function openBook(b: DocumentRecord) {
    setBook(b);
    setOverlay('reader');
  }
  function mine(item: MinedItem) {
    setMined((m) => (m.find((x) => x.term === item.term) ? m : [...m, item]));
  }
  function startReview(queue: ReviewCard[], deckName: string) {
    setReviewQueue(queue);
    setReviewDeck(deckName);
    setOverlay('review');
  }
  function navTo(item: (typeof NAV)[number]) {
    if (item.id === 'review') {
      startReview(sampleQueueCards(), 'Reading · Mined');
      return;
    }
    setOverlay(null);
    setView(item.id);
  }

  const email = session?.user.email ?? '';
  const initial = (email[0] ?? 'A').toUpperCase();
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
              {it.id === 'review' && <span className="nav-badge">{DUE}</span>}
            </div>
          );
        })}
        <div className="side-foot">
          {settingsOpen && (
            <Settings
              onClose={() => setSettingsOpen(false)}
              onOpenCredits={() => {
                setOverlay(null);
                setView('credits');
              }}
            />
          )}
          <div className="user-row" style={{ cursor: 'pointer' }} onClick={() => setSettingsOpen((o) => !o)}>
            <div className="avatar">{initial}</div>
            <div className="sf-text">
              <div className="nm">{email.split('@')[0] || 'Reader'}</div>
              <div className="em">{email}</div>
            </div>
            <span style={{ marginLeft: 'auto', color: 'var(--ink-faint)' }}><Icon.gear s={18} /></span>
          </div>
          <a
            style={{ fontSize: 12, color: 'var(--ink-faint)', cursor: 'pointer', padding: '0 6px' }}
            onClick={() => signOut()}
          >
            Sign out
          </a>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)}><Icon.menu s={20} /></button>
          <h1>{title}</h1>
          <span className="sub" lang="ja">{subtitle}</span>
          <span className="spacer" />
          <div className="searchbox"><Icon.search s={16} /><input placeholder="Search words, books…" /></div>
        </div>
        <div className="scroll">
          {view === 'library' && <LibraryScreen onOpenBook={openBook} due={DUE} streak={SAMPLE_STATS.streak} />}
          {view === 'decks' && <DecksScreen onReviewDeck={(d: SampleDeck) => startReview(sampleQueueCards(), d.name)} />}
          {view === 'analytics' && <AnalyticsScreen />}
          {view === 'credits' && <Attribution />}
        </div>
      </div>

      {!overlay && (
        <nav className="mob-nav">
          {NAV.map((it) => {
            const I = Icon[it.icon];
            const on = !overlay && view === it.id;
            return (
              <div key={it.id} className={'mn' + (on ? ' on' : '')} onClick={() => navTo(it)}>
                <I s={20} /><span>{it.label}</span>
              </div>
            );
          })}
        </nav>
      )}

      {overlay === 'reader' && book && (
        <Suspense fallback={<div className="reader"><div className="rd-stage"><div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--ink-faint)' }}>Opening reader…</p></div></div></div></div>}>
          <BookReader
            doc={book}
            mined={mined}
            onMine={mine}
            onReviewMined={() => startReview(minedToCards(mined), 'Reading · Mined')}
            onClose={() => setOverlay(null)}
          />
        </Suspense>
      )}
      {overlay === 'review' && (
        <ReviewScreen queue={reviewQueue} deckName={reviewDeck} onExit={() => setOverlay(null)} />
      )}

      {/* Mobile menu drawer (surfaces the sidebar's settings/account, hidden on small screens). */}
      {menuOpen && (
        <div className="mobile-menu-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="mobile-menu" onClick={(e) => e.stopPropagation()}>
            <div className="mm-head">
              <span className="brand"><span className="mk" lang="ja">学</span><span className="wd">GakuTaku</span></span>
              <button className="icon-btn" onClick={() => setMenuOpen(false)}><Icon.close s={18} /></button>
            </div>
            <div className="user-row" style={{ padding: '4px 0 12px' }}>
              <div className="avatar">{initial}</div>
              <div className="sf-text"><div className="nm">{email.split('@')[0] || 'Reader'}</div><div className="em">{email}</div></div>
            </div>
            <SettingsContent
              onOpenCredits={() => {
                setOverlay(null);
                setView('credits');
                setMenuOpen(false);
              }}
            />
            <a
              style={{ fontSize: 13, color: 'var(--ink-faint)', cursor: 'pointer', marginTop: 6 }}
              onClick={() => {
                setMenuOpen(false);
                signOut();
              }}
            >
              Sign out
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
