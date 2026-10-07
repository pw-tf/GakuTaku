import { appSql } from '../anki/appCollection';
import { useLive } from '../db/useLive';

/** A note's sort field as a plain word: no furigana brackets (食[た]べる) or spaces. */
export function plainWord(sfld: string): string {
  return sfld.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
}

/**
 * Every word you already have a note for (each note's sort field), refreshed when notes change,
 * so a word mined while reading stops being marked straight away. Undefined while off or loading.
 */
export function useKnownWords(enabled: boolean): Set<string> | undefined {
  const { data } = useLive(
    async () => (enabled ? new Set((await appSql.all<{ sfld: string }>('SELECT sfld FROM notes')).map((r) => plainWord(String(r.sfld)))) : undefined),
    [enabled],
    ['notes'],
  );
  return data;
}
