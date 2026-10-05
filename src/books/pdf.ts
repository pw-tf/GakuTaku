import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { chapterize, pdfItemsToLines, pdfLinesToParas, type PdfTextItem, type TextBookData } from './textBook';

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Japanese PDFs often use CID fonts whose character maps aren't embedded, and pdf.js needs Adobe's
 * CMap files to turn their glyphs back into text. They are bundled as assets and loaded on demand.
 */
const CMAPS = import.meta.glob('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

class BundledCMapReaderFactory {
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    const load = CMAPS[`../../node_modules/pdfjs-dist/cmaps/${name}.bcmap`];
    if (!load) throw new Error(`Missing CMap ${name}`);
    const res = await fetch(await load());
    return { cMapData: new Uint8Array(await res.arrayBuffer()), isCompressed: true };
  }
}

export class ScannedPdfError extends Error {}

/** Extract a PDF's text into chapters. Reports progress per page. */
export async function pdfToBook(data: ArrayBuffer, fallbackTitle: string, onProgress?: (done: number, total: number) => void): Promise<TextBookData> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    CMapReaderFactory: BundledCMapReaderFactory as never,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  try {
    let title = fallbackTitle;
    let creator = '';
    try {
      const meta = (await doc.getMetadata()).info as { Title?: string; Author?: string };
      if (meta.Title?.trim()) title = meta.Title.trim();
      if (meta.Author?.trim()) creator = meta.Author.trim();
    } catch {
      /* no metadata */
    }
    const pages: string[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const vertical = new Set(Object.entries(content.styles).filter(([, st]) => (st as { vertical?: boolean }).vertical).map(([name]) => name));
      pages.push(pdfItemsToLines(content.items as PdfTextItem[], vertical));
      page.cleanup();
      onProgress?.(i, doc.numPages);
    }
    const chars = pages.reduce((n, p) => n + p.join('').replace(/\s/g, '').length, 0);
    if (chars < 20 * Math.min(doc.numPages, 5)) {
      throw new ScannedPdfError('This PDF has no text layer (it is scanned pages). Only PDFs with selectable text can be read.');
    }
    return { title, creator, chapters: chapterize(pdfLinesToParas(pages), title) };
  } finally {
    void doc.destroy();
  }
}
