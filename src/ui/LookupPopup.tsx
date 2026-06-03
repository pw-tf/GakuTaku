import { useState } from 'react';
import type { LookupState } from '../jp-core/lookupService';
import { useAuth } from '../auth/AuthProvider';
import { db } from '../sync/system';

interface Props extends LookupState {
  onClose: () => void;
}

/**
 * Single shared dictionary popup (build plan §3.5). Shows word / name / kanji results for the
 * tapped term. The ＋ Add to deck button is an M2 stub: it records the term in the synced
 * `mined_words` table; real note/card creation arrives in M4.
 */
export function LookupPopup({ result, loading, anchor, error, onClose }: Props) {
  const { session } = useAuth();
  const [added, setAdded] = useState(false);

  if (!anchor) return null;

  const top = Math.min(anchor.bottom + 8, window.innerHeight - 320);
  const left = Math.min(anchor.left, window.innerWidth - 340);

  async function addToDeck() {
    if (!result || !session) return;
    const reading = result.words[0]?.kana[0] ?? result.names[0]?.kana[0] ?? '';
    await db.execute(
      `INSERT INTO mined_words (id, user_id, term, reading, context, document_id, looked_up_at)
       VALUES (uuid(), ?, ?, ?, ?, NULL, ?)`,
      [session.user.id, result.query, reading, '', new Date().toISOString()],
    );
    setAdded(true);
  }

  return (
    <>
      {/* click-away */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 max-h-80 w-80 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 text-slate-100 shadow-2xl"
        style={{ top, left }}
      >
        {loading && <p className="text-sm text-slate-400">Looking up…</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        {result && !loading && (
          <>
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 className="text-xl font-bold" lang="ja">
                {result.query}
              </h2>
              <button
                onClick={addToDeck}
                disabled={added || (!result.words.length && !result.names.length)}
                className="shrink-0 rounded-lg bg-indigo-600 px-2 py-1 text-xs font-semibold hover:bg-indigo-500 disabled:opacity-50"
              >
                {added ? 'Added ✓' : '＋ Add to deck'}
              </button>
            </div>

            {result.words.length === 0 && result.names.length === 0 && result.kanji.length === 0 && (
              <p className="text-sm text-slate-400">No dictionary entry found.</p>
            )}

            {result.words.map((w, i) => (
              <div key={`w${i}`} className="mb-3 border-b border-slate-800 pb-2 last:border-0">
                <div className="text-sm text-slate-300" lang="ja">
                  {w.kanji.length > 0 && <span className="mr-2 font-semibold">{w.kanji.join('、')}</span>}
                  <span className="text-slate-400">{w.kana.join('、')}</span>
                  {w.common && <span className="ml-2 rounded bg-emerald-700/60 px-1 text-[10px]">common</span>}
                </div>
                <ol className="ml-4 list-decimal text-sm text-slate-200">
                  {w.senses.slice(0, 4).map((s, j) => (
                    <li key={j}>
                      {s.pos.length > 0 && <span className="text-[11px] italic text-slate-500">{s.pos.join(', ')} · </span>}
                      {s.gloss.join('; ')}
                    </li>
                  ))}
                </ol>
              </div>
            ))}

            {result.names.length > 0 && (
              <div className="mb-3">
                <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-500">Names</h3>
                {result.names.slice(0, 5).map((n, i) => (
                  <div key={`n${i}`} className="text-sm" lang="ja">
                    <span className="font-semibold">{n.kanji.join('、') || n.kana.join('、')}</span>
                    <span className="ml-2 text-slate-400">{n.kana.join('、')}</span>
                    <span className="ml-2 text-slate-300">
                      {n.translations.map((t) => t.text.join(', ')).join('; ')}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {result.kanji.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-500">Kanji</h3>
                {result.kanji.map((k, i) => (
                  <div key={`k${i}`} className="mb-1 text-sm">
                    <span className="mr-2 text-lg font-bold" lang="ja">{k.literal}</span>
                    <span className="text-slate-300">{k.meanings.slice(0, 4).join(', ')}</span>
                    <div className="text-xs text-slate-500" lang="ja">
                      {k.onyomi.length > 0 && <span className="mr-2">音 {k.onyomi.join('、')}</span>}
                      {k.kunyomi.length > 0 && <span>訓 {k.kunyomi.join('、')}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
