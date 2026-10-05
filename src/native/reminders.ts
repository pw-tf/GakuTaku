import { LocalNotifications } from '@capacitor/local-notifications';
import { col } from '../anki/appCollection';
import { isNative } from '../app/platform';

/**
 * The daily study reminder (AnkiDroid's Settings › Notifications), as Android notifications. The
 * next week of reminders is scheduled ahead, each with the number of cards that will be due then
 * (days with nothing due get none); it's rescheduled whenever the app opens or a study session
 * ends, so the counts stay current.
 */

const FIRST_ID = 4100;
const DAYS_AHEAD = 7;
const ids = Array.from({ length: DAYS_AHEAD }, (_, i) => FIRST_ID + i);

export const remindersAvailable = isNative;

/** Ask Android for permission to post notifications (Android 13+). */
export async function requestReminderPermission(): Promise<boolean> {
  if (!isNative) return false;
  const cur = await LocalNotifications.checkPermissions();
  if (cur.display === 'granted') return true;
  const req = await LocalNotifications.requestPermissions();
  return req.display === 'granted';
}

/** The next `count` times at hh:mm (local), starting from the next one after now. */
export function reminderTimes(time: string, nowMs: number, count = DAYS_AHEAD): Date[] {
  const [h, m] = time.split(':').map(Number);
  const first = new Date(nowMs);
  first.setHours(h || 0, m || 0, 0, 0);
  if (first.getTime() <= nowMs) first.setDate(first.getDate() + 1);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    return d;
  });
}

let pending: Promise<void> = Promise.resolve();

/** (Re)schedule the reminders; turning them off cancels them. */
export function refreshReminders(enabled: boolean, time: string): Promise<void> {
  if (!isNative) return Promise.resolve();
  pending = pending.then(() => schedule(enabled, time)).catch((e) => console.warn('Reminders', e));
  return pending;
}

async function schedule(enabled: boolean, time: string): Promise<void> {
  await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
  if (!enabled) return;
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
  const notifications = [];
  for (const [i, at] of reminderTimes(time, Date.now()).entries()) {
    const due = await col.totalDue(at.getTime());
    const n = due.new + due.learning + due.review;
    if (n === 0) continue;
    notifications.push({
      id: ids[i],
      title: 'Time to study',
      body: `${n.toLocaleString()} card${n === 1 ? '' : 's'} to review in GakuTaku`,
      schedule: { at, allowWhileIdle: true },
    });
  }
  if (notifications.length) await LocalNotifications.schedule({ notifications });
}
