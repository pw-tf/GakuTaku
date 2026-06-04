import { useAuth } from '../auth/AuthProvider';
import type { DocumentRecord } from '../sync/AppSchema';
import { useBook } from './useBook';
import { Reader } from './Reader';
import type { MinedItem } from '../ui/LookupPopup';
import { Icon } from '../ui/icons';

interface Props {
  doc: DocumentRecord;
  mined: MinedItem[];
  onMine: (item: MinedItem) => void;
  onReviewMined: () => void;
  onClose: () => void;
}

/** Container: resolves the ePUB (cache/Storage), drives chapter state, and renders the Reader. */
export function BookReader({ doc, mined, onMine, onReviewMined, onClose }: Props) {
  const { session } = useAuth();
  const book = useBook(doc, session!.user.id);

  if (book.status === 'loading') {
    return (
      <div className="reader">
        <div className="rd-top">
          <span className="back" onClick={onClose}><Icon.chevL s={18} /> Library</span>
          <span className="rtitle" lang="ja">{book.title}</span>
        </div>
        <div className="rd-stage"><div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--ink-faint)' }}>Opening book…</p></div></div></div>
      </div>
    );
  }

  if (book.status === 'error') {
    return (
      <div className="reader">
        <div className="rd-top">
          <span className="back" onClick={onClose}><Icon.chevL s={18} /> Library</span>
        </div>
        <div className="rd-stage"><div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--rate-again)' }}>Couldn't open this book: {book.error}</p></div></div></div>
      </div>
    );
  }

  return (
    <Reader
      title={book.title}
      chapterIndex={book.chapterIndex}
      chapterCount={book.chapterCount}
      paragraphs={book.paragraphs}
      loadingChapter={book.loadingChapter}
      restoreScroll={book.restoreScroll}
      mined={mined}
      onMine={onMine}
      onReviewMined={onReviewMined}
      onPrevChapter={book.prevChapter}
      onNextChapter={book.nextChapter}
      onScrollFraction={book.saveScroll}
      onClose={onClose}
    />
  );
}
