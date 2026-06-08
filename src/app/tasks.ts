import { create } from 'zustand';

/**
 * Global background-task tracker. Long-running jobs (ePUB upload, .apkg import, dictionary download)
 * are kicked off from screens that unmount when the user navigates away — keeping their progress in
 * component-local state means the indicator vanishes mid-job. Routing them through this store lets a
 * persistent banner (`<BackgroundTasks/>` in the shell) show progress regardless of the current view.
 */

export type TaskStatus = 'running' | 'success' | 'error';

export interface BgTask {
  id: string;
  label: string;
  status: TaskStatus;
  /** Items done / total. total === 0 means indeterminate (show a busy bar, no percentage). */
  done: number;
  total: number;
  message?: string;
}

interface TasksState {
  tasks: BgTask[];
  /** True while any task is still running — used to disable re-triggering controls across navigation. */
  start: (id: string, label: string) => void;
  update: (id: string, patch: Partial<Omit<BgTask, 'id'>>) => void;
  finish: (id: string, status: Exclude<TaskStatus, 'running'>, message?: string) => void;
  dismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 4500;

export const useTasks = create<TasksState>((set, get) => ({
  tasks: [],
  start: (id, label) =>
    set((s) => ({
      tasks: [
        ...s.tasks.filter((t) => t.id !== id),
        { id, label, status: 'running', done: 0, total: 0 },
      ],
    })),
  update: (id, patch) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  finish: (id, status, message) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status, message } : t)) }));
    if (status === 'success') {
      setTimeout(() => {
        // Only auto-dismiss if it's still the same finished task (not restarted since).
        const t = get().tasks.find((x) => x.id === id);
        if (t && t.status === 'success') get().dismiss(id);
      }, AUTO_DISMISS_MS);
    }
  },
  dismiss: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
}));

/** Whether a task with the given id is currently running (read outside React via getState). */
export function isTaskRunning(id: string): boolean {
  return useTasks.getState().tasks.some((t) => t.id === id && t.status === 'running');
}
