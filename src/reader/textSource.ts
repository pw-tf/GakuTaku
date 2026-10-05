import type { TextBookData } from '../books/textBook';
import type { BookSource } from './epub';

/** A TXT/PDF book's extracted text as a {@link BookSource}. */
export function textBookSource(data: TextBookData): BookSource {
  return {
    title: data.title,
    creator: data.creator,
    chapterCount: data.chapters.length,
    direction: 'ltr',
    toc: data.chapters.map((c, i) => ({ label: c.title || `Part ${i + 1}`, chapter: i, depth: 0 })),
    async loadChapter(index) {
      return data.chapters[index]?.paragraphs ?? [];
    },
    destroy() {},
  };
}
