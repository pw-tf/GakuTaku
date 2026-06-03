import { useState } from 'react';
import { FuriganaText } from './FuriganaText';
import { LookupPopup } from './LookupPopup';
import { DictionaryLoader } from './DictionaryLoader';
import { useLookup } from '../jp-core/lookupService';

const SAMPLE = '今日は学校で日本語を勉強した。田中さんも来た。';

/**
 * M2 deliverable surface: paste Japanese → tokens + togglable furigana → tap any word for an
 * offline dictionary lookup. Throwaway test harness; the reader (M3) reuses these same pieces.
 */
export function JpCoreTestPage() {
  const [text, setText] = useState(SAMPLE);
  const [showFurigana, setShowFurigana] = useState(true);
  const lookup = useLookup();

  return (
    <div className="mx-auto max-w-2xl p-6 text-slate-100">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">Japanese core</h1>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={showFurigana}
            onChange={(e) => setShowFurigana(e.target.checked)}
          />
          Furigana
        </label>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        lang="ja"
        className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-base outline-none focus:border-indigo-500"
      />

      <DictionaryLoader>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <FuriganaText text={text} showFurigana={showFurigana} onWordTap={lookup.lookupToken} />
          <p className="mt-3 text-xs text-slate-500">Tap a highlighted word to look it up.</p>
        </div>
      </DictionaryLoader>

      {lookup.isOpen && (
        <LookupPopup
          result={lookup.result}
          loading={lookup.loading}
          anchor={lookup.anchor}
          error={lookup.error}
          onClose={lookup.close}
        />
      )}
    </div>
  );
}
