import { LOCAL_USER_ID } from '../app/localUser';
import type { DocumentRecord } from '../db/schema';
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
  const book = useBook(doc, LOCAL_USER_ID);

  if (book.status === 'loading') {
    return (
      <div className="reader">
        <div className="rd-top">
          <span className="back" onClick={onClose}><Icon.chevL s={18} /> <span className="back-lbl">Library</span></span>
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
          <span className="back" onClick={onClose}><Icon.chevL s={18} /> <span className="back-lbl">Library</span></span>
        </div>
        <div className="rd-stage"><div className="rd-scroll"><div className="rd-col"><p style={{ color: 'var(--rate-again)' }}>Couldn't open this book: {book.error}</p></div></div></div>
      </div>
    );
  }

  return (
    <Reader
      title={book.title}
      direction={book.direction}
      chapterIndex={book.chapterIndex}
      chapterCount={book.chapterCount}
      toc={book.toc}
      sourceLabel={book.title}
      documentId={doc.id}
      onGoChapter={(i) => book.goChapter(i, 'top')}
      paragraphs={book.paragraphs}
      images={book.images}
      loadingChapter={book.loadingChapter}
      chapterError={book.chapterError}
      onRetryChapter={book.retryChapter}
      restore={book.restore}
      mined={mined}
      onMine={onMine}
      onReviewMined={onReviewMined}
      onPrevChapter={book.prevChapter}
      onNextChapter={book.nextChapter}
      onPrevChapterEnd={book.prevChapterEnd}
      onProgress={book.saveProgress}
      onClose={onClose}
    />
  );
}
