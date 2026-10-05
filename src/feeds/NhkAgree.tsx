import { useState } from 'react';
import { agreeToNhk, canAgreeToNhk } from '../native/nhk';
import { Btn } from '../ui/atoms';

/**
 * Shown when NHK refuses a page because the reader hasn't agreed to its terms yet (NHK ONE, since
 * Oct 2025). Agreeing happens once, on NHK's own page; afterwards NHK's pages load normally.
 */
export function NhkAgreeNotice({ onAgreed }: { onAgreed: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!canAgreeToNhk) {
    return <p style={{ color: 'var(--ink-faint)' }}>NHK only shows this after you agree to its terms, which works in the Android app.</p>;
  }
  return (
    <div className="nhk-agree">
      <p>NHK asks readers to agree to its terms of use before showing its news. Open NHK’s page, tap 同意 (agree), then Done.</p>
      <Btn
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await agreeToNhk();
            onAgreed();
          } finally {
            setBusy(false);
          }
        }}
      >
        Agree on NHK
      </Btn>
    </div>
  );
}
