// M6 — .apkg (Anki) import. Entry point: parse the archive, then map + persist into our schema.
import { parseApkg, UnsupportedApkgError } from './apkg';
import { importApkg, type ImportProgress, type ImportSummary } from './importApkg';

export { UnsupportedApkgError };
export type { ImportProgress, ImportSummary };

/** Parse and import an `.apkg` File, reporting progress through the parse→map→media phases. */
export async function importApkgFile(
  file: File,
  userId: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportSummary> {
  const parsed = await parseApkg(await file.arrayBuffer());
  return importApkg(parsed, userId, onProgress);
}
