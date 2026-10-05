import ePub from 'epubjs';

// Containers count too (SECTION, UL, …): a chapter whose body is one <section> must recurse into
// it, not collapse into a single giant "paragraph" — pagination anchors depend on real paragraphs.
const BLOCK = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
  'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'HEADER', 'FOOTER',
  'FIGURE', 'FIGCAPTION', 'UL', 'OL', 'DL', 'DT', 'DD', 'PRE', 'TABLE', 'CENTER',
]);

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

export interface TocEntry {
  label: string;
  /** Chapter (spine) index the entry opens. */
  chapter: number;
  depth: number;
}

/** A book the reader can show: chapters of plain-text paragraphs, loaded one at a time. */
export interface BookSource {
  title: string;
  creator: string;
  chapterCount: number;
  /** OPF spine page-progression-direction — 'rtl' for vertically-set Japanese books. */
  direction: 'ltr' | 'rtl';
  toc: TocEntry[];
  /** Load and extract a chapter's paragraphs (lazy). */
  loadChapter: (index: number) => Promise<string[]>;
  /** A chapter's pictures as object URLs — shown when it has no text (a cover page, an illustration). */
  loadImages?: (index: number) => Promise<string[]>;
  destroy: () => void;
}

interface NavItem {
  label?: string;
  href?: string;
  subitems?: NavItem[];
}

/** Parse an ePUB from raw bytes for text extraction (no iframe rendering). */
export async function openEpub(data: ArrayBuffer): Promise<BookSource & { cover: () => Promise<Blob | null> }> {
  const book = ePub();
  await book.open(data, 'binary');
  await book.ready;

  const meta = await book.loaded.metadata;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyBook = book as any;
  // epub.js parses <spine page-progression-direction> into metadata.direction.
  const direction: 'ltr' | 'rtl' = (meta as { direction?: string }).direction === 'rtl' ? 'rtl' : 'ltr';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sections: any[] = anyBook.spine.spineItems ?? [];

  const toc: TocEntry[] = [];
  try {
    const nav = await book.loaded.navigation;
    const walk = (items: NavItem[], depth: number) => {
      for (const it of items) {
        const href = (it.href ?? '').split('#')[0];
        const section = href ? anyBook.spine.get(href) : null;
        if (section && it.label?.trim()) toc.push({ label: it.label.trim(), chapter: section.index, depth });
        if (it.subitems?.length) walk(it.subitems, depth + 1);
      }
    };
    walk((nav as unknown as { toc: NavItem[] }).toc ?? [], 0);
  } catch {
    /* no table of contents */
  }

  const objectUrls: string[] = [];
  return {
    title: meta.title || 'Untitled',
    creator: meta.creator || '',
    chapterCount: sections.length,
    direction,
    toc,
    async loadChapter(index: number) {
      const section = sections[index];
      if (!section) return [];
      const contents = (await section.load(anyBook.load.bind(book))) as Element;
      const paragraphs = extractParagraphs(contents);
      section.unload();
      return paragraphs;
    },
    async loadImages(index: number) {
      const section = sections[index];
      if (!section) return [];
      const contents = (await section.load(anyBook.load.bind(book))) as Element;
      const base = `https://book${section.url ?? '/' + (section.href ?? '')}`;
      const refs = Array.from(contents.querySelectorAll('img[src], image'))
        .map((el) => el.getAttribute('src') ?? el.getAttribute('xlink:href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? el.getAttribute('href'))
        .filter((src): src is string => !!src && !/^(?:data|https?):/i.test(src));
      section.unload();
      const out: string[] = [];
      for (const ref of refs.slice(0, 6)) {
        try {
          const path = decodeURIComponent(new URL(ref, base).pathname);
          const blob = (await anyBook.archive.getBlob(path)) as Blob | undefined;
          if (blob) {
            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            out.push(url);
          }
        } catch {
          /* missing picture */
        }
      }
      return out;
    },
    async cover() {
      try {
        await book.loaded.cover;
        if (!anyBook.cover) return null;
        return (await anyBook.archive.getBlob(anyBook.cover)) as Blob;
      } catch {
        return null;
      }
    },
    destroy() {
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
      // epub.js finishes setting up the book's resources after it reports ready; destroying it before
      // then throws inside epub.js ("reading 'replaceCss'").
      const opened = anyBook.opened as Promise<unknown> | undefined;
      if (opened) void opened.then(() => book.destroy(), () => book.destroy());
      else book.destroy();
    },
  };
}
