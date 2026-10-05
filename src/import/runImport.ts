import { useTasks } from '../app/tasks';

/**
 * Shared file-import driver used by both the Library and Decks screens. Branches on file type
 * (.apkg/.colpkg → Anki import, .epub/.pdf/.txt → library), reports progress through the global task store so
 * the `<BackgroundTasks/>` banner shows it regardless of which screen kicked it off, and dynamically
 * imports the heavy stacks so they stay out of the initial bundle.
 */

export const IMPORT_TASK_ID = 'library-import';

export async function importFile(file: File, userId: string): Promise<void> {
  const isAnki = /\.(apkg|colpkg)$/i.test(file.name);
  const tasks = useTasks.getState();
  if (!isAnki && !/\.(epub|pdf|txt)$/i.test(file.name)) {
    tasks.start(IMPORT_TASK_ID, `Can’t open ${file.name}`);
    tasks.finish(IMPORT_TASK_ID, 'error', 'Pick a book (.epub, .pdf or .txt), an Anki deck (.apkg) or an Anki collection backup (.colpkg).');
    return;
  }
  tasks.start(IMPORT_TASK_ID, isAnki ? `Importing ${file.name}` : `Adding ${file.name}`);
  tasks.update(IMPORT_TASK_ID, { message: isAnki ? 'Reading the package…' : 'Adding to your library…' });
  try {
    if (isAnki) {
      const { importAnkiFile } = await import('./index');
      const s = await importAnkiFile(file, (p) => {
        if (p.phase === 'reading') tasks.update(IMPORT_TASK_ID, { total: 0, message: 'Reading the package…' });
        else if (p.phase === 'media') tasks.update(IMPORT_TASK_ID, { done: p.done ?? 0, total: p.total ?? 0, message: 'Saving images and audio…' });
        else if (p.phase === 'writing') tasks.update(IMPORT_TASK_ID, { done: p.done ?? 0, total: p.total ?? 0, message: 'Importing cards…' });
      });
      const bits = [`${s.cards.toLocaleString()} cards`];
      if (s.decks) bits.unshift(`${s.decks} deck${s.decks === 1 ? '' : 's'}`);
      if (s.reviews) bits.push(`${s.reviews.toLocaleString()} reviews`);
      if (s.mediaFiles) bits.push(`${s.mediaFiles.toLocaleString()} media files`);
      let msg = `Imported ${bits.join(', ')}.`;
      if (s.skippedNotes) msg += ` ${s.skippedNotes.toLocaleString()} notes were already here and were skipped.`;
      tasks.finish(IMPORT_TASK_ID, 'success', msg);
    } else {
      const { addBook } = await import('../reader/addBook');
      await addBook(file, userId, (message, done, total) => tasks.update(IMPORT_TASK_ID, { message, done: done ?? 0, total: total ?? 0 }));
      tasks.finish(IMPORT_TASK_ID, 'success', `“${file.name}” added to your library.`);
    }
  } catch (err) {
    console.error(err);
    tasks.finish(IMPORT_TASK_ID, 'error', err instanceof Error ? err.message : 'Import failed.');
  }
}

/** True while a file import/upload is in progress (reactive selector for disabling controls). */
export function useImporting(): boolean {
  return useTasks((s) => s.tasks.some((t) => t.id === IMPORT_TASK_ID && t.status === 'running'));
}
