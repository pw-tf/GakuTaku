import { useTasks } from '../app/tasks';
import { Icon } from './icons';

/**
 * Persistent banner for background jobs (upload / import / dictionary download). Lives at the shell
 * level so it stays visible while the user moves between views — the work outlives the screen that
 * started it. Running tasks show a progress bar; finished ones a status line (errors stay until
 * dismissed, successes auto-clear).
 */
export function BackgroundTasks() {
  const tasks = useTasks((s) => s.tasks);
  const dismiss = useTasks((s) => s.dismiss);
  if (tasks.length === 0) return null;

  return (
    <div className="bgtasks">
      {tasks.map((t) => {
        const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
        const indeterminate = t.status === 'running' && t.total === 0;
        return (
          <div key={t.id} className={'bgtask ' + t.status}>
            <div className="bt-row">
              <span className="bt-ic">
                {t.status === 'success' ? <Icon.check s={15} /> : t.status === 'error' ? <Icon.close s={15} /> : null}
              </span>
              <span className="bt-label">{t.label}</span>
              <span className="bt-spacer" />
              {t.status === 'running' && t.total > 0 && <span className="bt-pct">{pct}%</span>}
              {t.status !== 'running' && (
                <button className="bt-x" onClick={() => dismiss(t.id)} title="Dismiss"><Icon.close s={13} /></button>
              )}
            </div>
            {t.message && <div className="bt-msg">{t.message}</div>}
            {t.status === 'running' && (
              <div className="bt-bar">
                <i className={indeterminate ? 'indet' : ''} style={indeterminate ? undefined : { width: pct + '%' }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
