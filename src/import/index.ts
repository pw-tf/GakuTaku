import { appSql, col } from '../anki/appCollection';
import { hasMediaFile, putMediaFiles, renamedForConflict } from '../media/store';
import { parseApkg, UnsupportedApkgError } from './apkg';
import { importPackage, type ImportProgress, type ImportSummary } from './importPackage';

export { UnsupportedApkgError };
export type { ImportProgress, ImportSummary };

/** Import an Anki `.apkg` (deck) or `.colpkg` (whole collection) file. */
export async function importAnkiFile(file: File, onProgress?: (p: ImportProgress) => void): Promise<ImportSummary> {
  onProgress?.({ phase: 'reading' });
  const pkg = await parseApkg(file);
  return importPackage(col, appSql, pkg, { has: hasMediaFile, putMany: putMediaFiles, rename: renamedForConflict }, {
    isCollection: /\.colpkg$/i.test(file.name),
    onProgress,
  });
}
