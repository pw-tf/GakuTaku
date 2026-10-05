import { useEffect, useRef, useState } from 'react';
import { FEW_REVIEWS, evaluatePreset, optimizePreset } from '../anki/optimize';
import type { DeckConfig } from '../anki/types';
import { Btn } from '../ui/atoms';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; what: 'optimize' | 'evaluate'; fraction: number }
  | { kind: 'done'; text: string; warn?: string }
  | { kind: 'error'; text: string };

/**
 * Anki's "Optimize" and "Evaluate" for a preset. The preset's saved deck membership decides which
 * cards are used; the result is written into the parameter box, to be saved with the options.
 */
export function FsrsOptimizer({
  presetId,
  config,
  params,
  onParams,
}: {
  presetId: number;
  config: DeckConfig;
  /** The parameters currently in the box (parsed), for "Evaluate" and as the "current" set. */
  params: number[] | null;
  onParams: (params: number[]) => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function optimize() {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setStatus({ kind: 'running', what: 'optimize', fraction: 0 });
    try {
      const r = await optimizePreset(presetId, { ...config, fsrsParams: params ?? [] }, (fraction) => setStatus({ kind: 'running', what: 'optimize', fraction }), ctl.signal);
      if (!r) {
        setStatus({ kind: 'error', text: 'No review history to learn from yet. Cards need learning steps recorded in their history.' });
        return;
      }
      const reviews = `${r.reviews.toLocaleString()} reviews`;
      if (r.keptCurrent) setStatus({ kind: 'done', text: `Checked ${reviews}: the current parameters already fit best.` });
      else {
        onParams(r.params);
        setStatus({
          kind: 'done',
          text: `Optimized from ${reviews}. Log loss ${r.currentLogLoss.toFixed(4)} → ${r.optimizedLogLoss.toFixed(4)}. Save to apply.`,
          warn: r.items < FEW_REVIEWS ? 'There isn’t much history yet, so these parameters may change a lot as you review more.' : undefined,
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setStatus({ kind: 'idle' });
      else setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function evaluate() {
    setStatus({ kind: 'running', what: 'evaluate', fraction: 0 });
    try {
      const r = await evaluatePreset(presetId, config, params ?? []);
      if (!r) setStatus({ kind: 'error', text: 'No review history to evaluate yet.' });
      else setStatus({ kind: 'done', text: `Log loss ${r.logLoss.toFixed(4)}, RMSE (bins) ${(r.rmseBins * 100).toFixed(2)}%. Lower is better.` });
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  const running = status.kind === 'running';
  return (
    <div className="fsrs-opt">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn size="sm" variant="primary" disabled={running || !params} onClick={() => void optimize()}>Optimize</Btn>
        <Btn size="sm" disabled={running || !params} onClick={() => void evaluate()}>Evaluate</Btn>
        {running && status.what === 'optimize' && <Btn size="sm" onClick={() => abort.current?.abort()}>Cancel</Btn>}
      </div>
      {running && (
        <div className="fsrs-opt-progress">
          <div className="bar"><i style={{ width: `${Math.round(status.fraction * 100)}%` }} /></div>
          <span>{status.what === 'optimize' ? `Optimizing… ${Math.round(status.fraction * 100)}%` : 'Evaluating…'}</span>
        </div>
      )}
      {status.kind === 'done' && (
        <p className="opt-note" style={{ color: 'var(--ink-soft)' }}>
          {status.text}
          {status.warn && <><br /><span style={{ color: 'var(--amber)' }}>{status.warn}</span></>}
        </p>
      )}
      {status.kind === 'error' && <p className="opt-note" style={{ color: 'var(--rate-again)' }}>{status.text}</p>}
    </div>
  );
}
