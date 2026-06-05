import ePub from 'epubjs';

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE']);

/** Extract readable paragraphs from a chapter document element (leaf block elements). */
function extractParagraphs(root: Element): string[] {
  const out: string[] = [];

  function leafText(el: Element): string {
    // Drop any source furigana (<rt>/<rp>) — we generate our own readings.
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('rt, rp').forEach((n) => n.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function walk(el: Element) {
    const childBlocks = Array.from(el.children).filter((c) => BLOCK.has(c.tagName));
    if (childBlocks.length === 0) {
      const t = leafText(el);
      if (t) out.push(t);
    } else {
      for (const c of childBlocks) walk(c);
    }
  }

  const body = root.querySelector('body') ?? root;
  const tops = Array.from(body.children).filter((c) => BLOCK.has(c.tagName));
  if (tops.length === 0) {
    const t = leafText(body);
    if (t) out.push(t);
  } else {
    tops.forEach(walk);
  }
  return out;
}

export interface EpubBook {
  title: string;
  creator: string;
  chapterCount: number;
  /** OPF spine page-progression-direction — 'rtl' for vertically-set Japanese books. */
  direction: 'ltr' | 'rtl';
  /** Load and extract a chapter's paragraphs (lazy). */
  loadChapter: (index: number) => Promise<string[]>;
  destroy: () => void;
}

/** Parse an ePUB from raw bytes for text extraction (no iframe rendering). */
export async function openEpub(data: ArrayBuffer): Promise<EpubBook> {
  const book = ePub();
  await book.open(data, 'binary');
  await book.ready;

  const meta = await book.loaded.metadata;
  // epub.js parses <spine page-progression-direction> into metadata.direction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const direction: 'ltr' | 'rtl' = (meta as any).direction === 'rtl' ? 'rtl' : 'ltr';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sections: any[] = (book.spine as any).spineItems ?? [];

  return {
    title: meta.title || 'Untitled',
    creator: meta.creator || '',
    chapterCount: sections.length,
    direction,
    async loadChapter(index: number) {
      const section = sections[index];
      if (!section) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contents = (await section.load((book as any).load.bind(book))) as Element;
      const paragraphs = extractParagraphs(contents);
      section.unload();
      return paragraphs;
    },
    destroy() {
      book.destroy();
    },
  };
}
