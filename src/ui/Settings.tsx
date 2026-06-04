import { useEffect, useRef } from 'react';
import { ACCENTS, usePrefs } from '../app/prefs';

interface ContentProps {
  onOpenCredits: () => void;
}

/** The settings controls (accent / dark / furigana / credits), reused by the desktop popover and the mobile menu. */
export function SettingsContent({ onOpenCredits }: ContentProps) {
  const { accent, dark, furigana, setAccent, setDark, setFurigana } = usePrefs();
  return (
    <>
      <div className="set-sec">
        <div className="set-h">Accent</div>
        <div className="accent-swatches">
          {ACCENTS.map((c) => (
            <div
              key={c}
              className={'sw' + (accent === c ? ' on' : '')}
              style={{ background: c }}
              onClick={() => setAccent(c)}
            />
          ))}
        </div>
      </div>

      <div className="set-sec">
        <div className="toggle-row">
          <span>Dark mode</span>
          <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
        </div>
      </div>

      <div className="set-sec">
        <div className="set-h">Furigana</div>
        <div className="density-seg">
          {(['all', 'n3', 'off'] as const).map((v) => (
            <div key={v} className={'d' + (furigana === v ? ' on' : '')} onClick={() => setFurigana(v)}>
              {v === 'all' ? 'All' : v === 'n3' ? 'N3+' : 'Off'}
            </div>
          ))}
        </div>
      </div>

      <div className="set-sec">
        <a
          style={{ color: 'var(--accent)', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
          onClick={onOpenCredits}
        >
          Credits &amp; licenses →
        </a>
      </div>
    </>
  );
}

interface Props {
  onClose: () => void;
  onOpenCredits: () => void;
}

/** Desktop settings popover (anchored above the sidebar user row). */
export function Settings({ onClose, onOpenCredits }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement;
      // Ignore clicks on the user row (it toggles the popover itself).
      if (ref.current && !ref.current.contains(t) && !t.closest('.user-row')) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div className="settings-pop" ref={ref}>
      <SettingsContent
        onOpenCredits={() => {
          onOpenCredits();
          onClose();
        }}
      />
    </div>
  );
}
