import { useEffect, useState } from 'react';
import { col } from '../anki/appCollection';
import type { CustomStudyRequest } from '../anki/collection';
import { deckSearch } from '../anki/search';
import { defaultFilteredConfig, type FilteredDeckConfig, type FilteredOrder, type FilteredTerm } from '../anki/types';
import { Btn } from '../ui/atoms';
import { Modal } from '../ui/Modal';

/** Anki's filtered deck dialog and Custom Study dialog. */

const ORDERS: Record<FilteredOrder, string> = {
  random: 'Random',
  due: 'Order due',
  added: 'Order added',
  reverseAdded: 'Latest added first',
  oldestSeen: 'Oldest seen first',
  ivlAsc: 'Increasing intervals',
  ivlDesc: 'Decreasing intervals',
  lapses: 'Most lapses',
};

function TermEditor({ term, onChange, label }: { term: FilteredTerm; onChange: (t: FilteredTerm) => void; label: string }) {
  return (
    <fieldset className="fd-term">
      <legend>{label}</legend>
      <label className="opt-field col">
        <span>Search</span>
        <input value={term.search} placeholder="e.g. deck:Japanese is:due" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange({ ...term, search: e.target.value })} />
      </label>
      <div className="fd-row">
        <label className="opt-field col">
          <span>Limit to</span>
          <input type="number" min={1} value={term.limit} onChange={(e) => onChange({ ...term, limit: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label className="opt-field col" style={{ flex: 1 }}>
          <span>Cards selected by</span>
          <select value={term.order} onChange={(e) => onChange({ ...term, order: e.target.value as FilteredOrder })}>
            {(Object.keys(ORDERS) as FilteredOrder[]).map((o) => <option key={o} value={o}>{ORDERS[o]}</option>)}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

/**
 * Create (deckId undefined) or edit a filtered deck. `initialSearch` seeds a new deck's search (Anki
 * starts from the current deck: `deck:"…" is:due`).
 */
export function FilteredDeckModal({ deckId, initialSearch = '', onClose, onSaved }: { deckId?: number; initialSearch?: string; onClose: () => void; onSaved?: (id: number) => void }) {
  const [name, setName] = useState('');
  const [cfg, setCfg] = useState<FilteredDeckConfig | null>(null);
  const [second, setSecond] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      if (deckId != null) {
        const d = await col.deck(deckId);
        if (!d?.filtered) return onClose();
        setName(d.name);
        setCfg(d.filtered);
        setSecond(d.filtered.terms.length > 1);
      } else {
        const now = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        setName(`Filtered Deck ${p(now.getHours())}:${p(now.getMinutes())}`);
        const d = defaultFilteredConfig();
        setCfg({ ...d, terms: [{ ...d.terms[0], search: initialSearch }] });
      }
    })();
  }, [deckId, initialSearch, onClose]);

  if (!cfg) return null;
  const terms = cfg.terms;
  const secondTerm: FilteredTerm = terms[1] ?? { search: '', limit: 20, order: 'due' };

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setErr(null);
    const next = { ...cfg, terms: second ? [terms[0], secondTerm] : [terms[0]] };
    try {
      if (deckId != null) {
        await col.updateFilteredDeck(deckId, name, next);
        onSaved?.(deckId);
      } else {
        const { id } = await col.addFilteredDeck(name, next);
        onSaved?.(id);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={deckId != null ? 'Filtered deck options' : 'Create filtered deck'} onClose={onClose} wide>
      <div className="modal-body">
        <label className="opt-field col">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <TermEditor label="Filter" term={terms[0]} onChange={(t) => setCfg({ ...cfg, terms: [t, ...terms.slice(1)] })} />
        <label className="opt-check"><input type="checkbox" checked={second} onChange={(e) => setSecond(e.target.checked)} /> Second filter</label>
        {second && <TermEditor label="Second filter" term={secondTerm} onChange={(t) => setCfg({ ...cfg, terms: [terms[0], t] })} />}
        <label className="opt-check">
          <input type="checkbox" checked={cfg.reschedule} onChange={(e) => setCfg({ ...cfg, reschedule: e.target.checked })} /> Reschedule cards based on my answers in this deck
        </label>
        {!cfg.reschedule && (
          <div className="fd-row">
            {([['previewAgainSecs', 'Again delay'], ['previewHardSecs', 'Hard delay'], ['previewGoodSecs', 'Good delay']] as const).map(([k, label]) => (
              <label key={k} className="opt-field col">
                <span>{label} (seconds)</span>
                <input type="number" min={0} value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>
          Searches use the browser’s syntax. Suspended and buried cards, and cards already in another filtered deck, are left out.
          {!cfg.reschedule && ' Without rescheduling, a delay of 0 returns the card to its deck unchanged.'}
        </p>
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Building…' : deckId != null ? 'Rebuild' : 'Build'}</Btn>
      </div>
    </Modal>
  );
}

type Choice = 'newLimit' | 'reviewLimit' | 'forgot' | 'ahead' | 'preview' | 'cram';

const CHOICES: Record<Choice, string> = {
  newLimit: 'Increase today’s new card limit',
  reviewLimit: 'Increase today’s review card limit',
  forgot: 'Review forgotten cards',
  ahead: 'Review ahead',
  preview: 'Preview new cards',
  cram: 'Study by card state or tag',
};

/** Anki's Custom Study for a deck. Calls `onStudy` with the session deck when one is built. */
export function CustomStudyModal({ deckId, deckName, onClose, onStudy }: { deckId: number; deckName: string; onClose: () => void; onStudy?: (id: number, name: string) => void }) {
  const [choice, setChoice] = useState<Choice>('newLimit');
  const [amount, setAmount] = useState('10');
  const [cram, setCram] = useState<'new' | 'due' | 'review' | 'all'>('due');
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [exclude, setExclude] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<{ newAvailable: number; reviewAvailable: number; tags: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void col.customStudyInfo(deckId).then(setInfo);
  }, [deckId]);

  useEffect(() => {
    setAmount(choice === 'newLimit' || choice === 'reviewLimit' ? '10' : choice === 'cram' ? '100' : choice === 'forgot' ? '1' : choice === 'ahead' ? '1' : '1');
  }, [choice]);

  const amountLabel: Record<Choice, string> = {
    newLimit: 'Increase by',
    reviewLimit: 'Increase by',
    forgot: 'Forgotten in the last … days',
    ahead: 'Days ahead',
    preview: 'Added in the last … days',
    cram: 'Number of cards',
  };

  async function go() {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n < 1) return setErr('Enter a number of at least 1.');
    let req: CustomStudyRequest;
    switch (choice) {
      case 'newLimit':
      case 'reviewLimit':
        req = { kind: choice, delta: n };
        break;
      case 'forgot':
      case 'ahead':
      case 'preview':
        req = { kind: choice, days: n };
        break;
      case 'cram':
        req = { kind: 'cram', cram, limit: n, includeTags: [...include], excludeTags: [...exclude] };
        break;
    }
    setBusy(true);
    setErr(null);
    try {
      const session = await col.customStudy(deckId, req);
      onClose();
      if (session) onStudy?.(session.id, 'Custom Study Session');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, tag: string) => {
    const next = new Set(set);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setter(next);
  };

  return (
    <Modal title={`Custom study · ${deckName.split('::').pop()}`} onClose={onClose}>
      <div className="modal-body">
        {(Object.keys(CHOICES) as Choice[]).map((c) => (
          <label key={c} className="opt-check">
            <input type="radio" name="custom-study" checked={choice === c} onChange={() => setChoice(c)} /> {CHOICES[c]}
          </label>
        ))}
        <label className="opt-field col">
          <span>{amountLabel[choice]}</span>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {choice === 'newLimit' && info && <p className="muted cs-note">New cards available: {info.newAvailable.toLocaleString()}</p>}
        {choice === 'reviewLimit' && info && <p className="muted cs-note">Reviews due: {info.reviewAvailable.toLocaleString()}</p>}
        {choice === 'cram' && (
          <>
            <label className="opt-field col">
              <span>Cards</span>
              <select value={cram} onChange={(e) => setCram(e.target.value as typeof cram)}>
                <option value="new">New cards only</option>
                <option value="due">Due cards only</option>
                <option value="review">All review cards in random order</option>
                <option value="all">All cards in random order (don’t reschedule)</option>
              </select>
            </label>
            {info && info.tags.length > 0 && (
              <div className="cs-tags">
                <span className="muted cs-note">Tap a tag once to require it, twice to exclude it.</span>
                <div className="tag-suggest">
                  {info.tags.map((t) => {
                    const state = include.has(t) ? 'inc' : exclude.has(t) ? 'exc' : '';
                    return (
                      <button
                        key={t}
                        type="button"
                        className={'cs-tag ' + state}
                        onClick={() => {
                          if (state === '') toggle(include, setInclude, t);
                          else if (state === 'inc') {
                            toggle(include, setInclude, t);
                            toggle(exclude, setExclude, t);
                          } else toggle(exclude, setExclude, t);
                        }}
                      >
                        {state === 'exc' ? '−' : state === 'inc' ? '+' : ''}{t}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
        {choice !== 'newLimit' && choice !== 'reviewLimit' && (
          <p className="muted cs-note">Builds a “Custom Study Session” filtered deck from {deckSearch(deckName)}.</p>
        )}
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy} onClick={() => void go()}>OK</Btn>
      </div>
    </Modal>
  );
}
