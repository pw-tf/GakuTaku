import { useTasks } from '../app/tasks';

/**
 * Shared file-import driver used by both the Library and Decks screens. Branches on file type
 * (.apkg → Anki import, otherwise ePUB upload), reports progress through the global task store so
 * the `<BackgroundTasks/>` banner shows it regardless of which screen kicked it off, and dynamically
 * imports the heavy stacks so they stay out of the initial bundle.
 */

export const IMPORT_TASK_ID = 'library-import';

export async function importFile(file: File, userId: string): Promise<void> {
  const isApkg = /\.apkg$/i.test(file.name);
  const tasks = useTasks.getState();
  tasks.start(IMPORT_TASK_ID, isApkg ? `Importing ${file.name}` : `Uploading ${file.name}`);
  tasks.update(IMPORT_TASK_ID, { message: isApkg ? 'Reading deck…' : 'Uploading to your library…' });
  try {
    if (isApkg) {
      const { importApkgFile } = await import('./index');
      const s = await importApkgFile(file, userId, (p) => {
        if (p.phase === 'mapping') tasks.update(IMPORT_TASK_ID, { total: 0, message: 'Reading collection…' });
        else if (p.phase === 'writing') tasks.update(IMPORT_TASK_ID, { done: p.done ?? 0, total: p.total ?? 0, message: 'Importing cards…' });
        else if (p.phase === 'media') tasks.update(IMPORT_TASK_ID, { done: p.done ?? 0, total: p.total ?? 0, message: 'Uploading media…' });
      });
      const bits = [`${s.decks} deck${s.decks === 1 ? '' : 's'}`, `${s.cards} cards`];
      if (s.reviews) bits.push(`${s.reviews.toLocaleString()} reviews`);
      if (s.mediaFiles) bits.push(`${s.mediaFiles} media`);
      tasks.finish(IMPORT_TASK_ID, 'success', `Imported ${bits.join(', ')}.`);
    } else {
      const { uploadEpub } = await import('../reader/uploadEpub');
      await uploadEpub(file, userId);
      tasks.finish(IMPORT_TASK_ID, 'success', `“${file.name}” added to your library.`);
    }
  } catch (err) {
    tasks.finish(IMPORT_TASK_ID, 'error', err instanceof Error ? err.message : 'Import failed.');
  }
}

/** True while a file import/upload is in progress (reactive selector for disabling controls). */
export function useImporting(): boolean {
  return useTasks((s) => s.tasks.some((t) => t.id === IMPORT_TASK_ID && t.status === 'running'));
}
