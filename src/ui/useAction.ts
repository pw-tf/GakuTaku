import { useRef, useState } from 'react';

/**
 * Run a dialog's action at most once at a time and keep its error for display. A double tap can't
 * start it twice (the guard is a ref, so even two taps in one frame are caught).
 */
export function useAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setErr(null);
    try {
      await action();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, err, setErr, run };
}
