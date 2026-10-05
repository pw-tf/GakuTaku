import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackHandler } from '../app/back';
import { Btn } from './atoms';
import { Icon } from './icons';

/**
 * A centered dialog. Closes on backdrop tap and on the Android back button. Rendered into <body> so a
 * dialog opened from a popover or drawer isn't clipped or positioned by it.
 */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useBackHandler(true, onClose);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={wide ? { width: 'min(640px, 100%)' } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon.close s={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A one-field text prompt (replaces `window.prompt`). */
export function PromptModal({
  title,
  label,
  initial = '',
  placeholder,
  help,
  confirmLabel = 'OK',
  onSubmit,
  onClose,
}: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  help?: ReactNode;
  confirmLabel?: string;
  /** Return an error message to keep the dialog open. */
  onSubmit: (value: string) => Promise<string | void> | string | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const res = await onSubmit(value);
      if (typeof res === 'string' && res) setErr(res);
      else onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-body">
          <label className="opt-field col">
            {label && <span>{label}</span>}
            <input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
          </label>
          {help && <p style={{ fontSize: 12, color: 'var(--ink-faint)', margin: '8px 0 0', lineHeight: 1.5 }}>{help}</p>}
          {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
        </div>
        <div className="modal-foot">
          <Btn type="button" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" type="submit" disabled={busy}>{confirmLabel}</Btn>
        </div>
      </form>
    </Modal>
  );
}

/** A yes/no confirmation (replaces `window.confirm`). */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'OK',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        <p style={{ margin: 0, lineHeight: 1.55, color: 'var(--ink-soft)' }}>{message}</p>
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          disabled={busy}
          style={danger ? { background: 'var(--rate-again)', borderColor: 'var(--rate-again)' } : undefined}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </Btn>
      </div>
    </Modal>
  );
}
