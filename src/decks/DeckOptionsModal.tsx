import { useEffect, useState, type ReactNode } from 'react';
import { col } from '../anki/appCollection';
import { DEFAULT_CONFIG_ID, type DeckConfigRow } from '../anki/collection';
import { DEFAULT_PARAMETERS } from '../anki/fsrs';
import { defaultDeckConfig, type CollectionConfig, type Deck, type DeckConfig, type NewGatherPriority, type NewSortOrder, type ReviewMix, type ReviewOrder } from '../anki/types';
import { Btn } from '../ui/atoms';
import { Modal, PromptModal, ConfirmModal } from '../ui/Modal';

/**
 * Anki's Deck Options screen: the deck's preset (shared by every deck that uses it) with Anki's
 * sections and defaults, the "this deck" limit overrides, and the collection-wide FSRS switch.
 */

const GATHER: Record<NewGatherPriority, string> = {
  deck: 'Deck', deckThenRandomNotes: 'Deck, then random notes', lowestPosition: 'Ascending position', highestPosition: 'Descending position',
  randomNotes: 'Random notes', randomCards: 'Random cards',
};
const NEW_SORT: Record<NewSortOrder, string> = {
  template: 'Card type, then order gathered', noSort: 'Order gathered', templateThenRandom: 'Card type, then random',
  randomNoteThenTemplate: 'Random note, then card type', randomCard: 'Random',
};
const MIX: Record<ReviewMix, string> = { mix: 'Mix with reviews', afterReviews: 'Show after reviews', beforeReviews: 'Show before reviews' };
const REVIEW_ORDER: Record<ReviewOrder, string> = {
  day: 'Due date, then random', dayThenDeck: 'Due date, then deck', deckThenDay: 'Deck, then due date', intervalsAscending: 'Ascending intervals',
  intervalsDescending: 'Descending intervals', easeAscending: 'Ascending ease / descending difficulty', easeDescending: 'Descending ease / ascending difficulty',
  retrievabilityAscending: 'Ascending retrievability', retrievabilityDescending: 'Descending retrievability', relativeOverdueness: 'Relative overdueness',
  random: 'Random', added: 'Order added', reverseAdded: 'Reverse order added',
};

/** "1m 10m 1h 2d" ⇄ minutes (Anki's step syntax). */
export function formatSteps(mins: number[]): string {
  return mins
    .map((m) => {
      if (m >= 1440 && m % 1440 === 0) return `${m / 1440}d`;
      if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
      if (m < 1) return `${Math.round(m * 60)}s`;
      return `${+m.toFixed(2)}m`;
    })
    .join(' ');
}

export function parseSteps(text: string): number[] | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(p);
    if (!m) return null;
    const v = Number(m[1]);
    const unit = (m[2] || 'm').toLowerCase();
    out.push(unit === 's' ? v / 60 : unit === 'h' ? v * 60 : unit === 'd' ? v * 1440 : v);
  }
  return out;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="opt-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="opt-row">
      <span className="opt-label">
        {label}
        {help && <small>{help}</small>}
      </span>
      <span className="opt-control">{children}</span>
    </label>
  );
}

function NumberInput({ value, onChange, step = 1, min = 0, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      value={text}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)}>
      {(Object.keys(options) as T[]).map((k) => (
        <option key={k} value={k}>{options[k]}</option>
      ))}
    </select>
  );
}

function StepsInput({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const [text, setText] = useState(formatSteps(value));
  const [bad, setBad] = useState(false);
  return (
    <input
      value={text}
      className={bad ? 'invalid' : ''}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseSteps(e.target.value);
        setBad(parsed == null);
        if (parsed) onChange(parsed);
      }}
    />
  );
}

export function DeckOptionsModal({ deckId, onClose }: { deckId: number; onClose: () => void }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [presets, setPresets] = useState<DeckConfigRow[]>([]);
  const [presetId, setPresetId] = useState<number>(DEFAULT_CONFIG_ID);
  const [cfg, setCfg] = useState<DeckConfig>(defaultDeckConfig());
  const [colCfg, setColCfg] = useState<CollectionConfig | null>(null);
  const [usage, setUsage] = useState<Map<number, number>>(new Map());
  const [newLimit, setNewLimit] = useState<string>('');
  const [reviewLimit, setReviewLimit] = useState<string>('');
  const [dr, setDr] = useState<string>('');
  const [paramsText, setParamsText] = useState('');
  const [dialog, setDialog] = useState<null | 'add' | 'rename' | 'delete'>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(selectId?: number) {
    const [d, ps, c, decks] = await Promise.all([col.deck(deckId), col.deckConfigs(), col.config(), col.decks()]);
    if (!d) return onClose();
    setDeck(d);
    setPresets(ps);
    setColCfg(c);
    const u = new Map<number, number>();
    for (const x of decks) u.set(x.conf_id, (u.get(x.conf_id) ?? 0) + 1);
    setUsage(u);
    const pid = selectId ?? d.conf_id;
    const p = ps.find((x) => x.id === pid) ?? ps.find((x) => x.id === DEFAULT_CONFIG_ID)!;
    setPresetId(p.id);
    setCfg(p.config);
    setParamsText(p.config.fsrsParams.map((x) => +x.toFixed(4)).join(', '));
    setNewLimit(d.new_limit == null ? '' : String(d.new_limit));
    setReviewLimit(d.review_limit == null ? '' : String(d.review_limit));
    setDr(d.desired_retention == null ? '' : String(d.desired_retention));
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const set = <K extends keyof DeckConfig>(k: K, v: DeckConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const preset = presets.find((p) => p.id === presetId);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      let params: number[] = [];
      if (paramsText.trim()) {
        params = paramsText.split(/[\s,]+/).filter(Boolean).map(Number);
        if (params.some((x) => !Number.isFinite(x)) || ![17, 19, 21].includes(params.length)) throw new Error('FSRS parameters must be 17, 19 or 21 numbers (or empty for the defaults).');
      }
      await col.updateDeckConfig(presetId, preset?.name ?? 'Default', { ...cfg, fsrsParams: params });
      const num = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.round(Number(s))));
      await col.updateDeck(deckId, {
        conf_id: presetId,
        new_limit: num(newLimit),
        review_limit: num(reviewLimit),
        desired_retention: dr.trim() === '' ? null : Number(dr),
      });
      if (colCfg) await col.setConfig({ fsrs: colCfg.fsrs, rollover: colCfg.rollover, learnAheadSecs: colCfg.learnAheadSecs, newCardsIgnoreReviewLimit: colCfg.newCardsIgnoreReviewLimit, applyAllParentLimits: colCfg.applyAllParentLimits });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={`Options · ${deck?.name ?? ''}`} onClose={onClose} wide>
      <div className="modal-body opt-body">
        <div className="preset-bar">
          <select value={presetId} onChange={(e) => { const p = presets.find((x) => x.id === Number(e.target.value)); if (p) { setPresetId(p.id); setCfg(p.config); setParamsText(p.config.fsrsParams.join(', ')); } }}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({usage.get(p.id) ?? 0} {usage.get(p.id) === 1 ? 'deck' : 'decks'})</option>
            ))}
          </select>
          <Btn size="sm" onClick={() => setDialog('add')}>Add / clone</Btn>
          <Btn size="sm" onClick={() => setDialog('rename')}>Rename</Btn>
          {presetId !== DEFAULT_CONFIG_ID && <Btn size="sm" onClick={() => setDialog('delete')}>Remove</Btn>}
        </div>
        <p className="opt-note">Changes to a preset apply to every deck that uses it.</p>

        <Section title="Daily limits">
          <Row label="New cards/day"><NumberInput value={cfg.newPerDay} onChange={(v) => set('newPerDay', v)} /></Row>
          <Row label="Maximum reviews/day"><NumberInput value={cfg.reviewsPerDay} onChange={(v) => set('reviewsPerDay', v)} /></Row>
          <Row label="This deck: new cards/day" help="Overrides the preset for this deck only. Empty = use preset.">
            <input inputMode="numeric" value={newLimit} onChange={(e) => setNewLimit(e.target.value)} placeholder="—" />
          </Row>
          <Row label="This deck: reviews/day" help="Empty = use preset.">
            <input inputMode="numeric" value={reviewLimit} onChange={(e) => setReviewLimit(e.target.value)} placeholder="—" />
          </Row>
          {colCfg && (
            <>
              <Row label="New cards ignore review limit">
                <input type="checkbox" checked={colCfg.newCardsIgnoreReviewLimit} onChange={(e) => setColCfg({ ...colCfg, newCardsIgnoreReviewLimit: e.target.checked })} />
              </Row>
              <Row label="Limits start from top" help="Apply parent decks’ limits when studying a subdeck.">
                <input type="checkbox" checked={colCfg.applyAllParentLimits} onChange={(e) => setColCfg({ ...colCfg, applyAllParentLimits: e.target.checked })} />
              </Row>
            </>
          )}
        </Section>

        <Section title="New cards">
          <Row label="Learning steps" help="e.g. 1m 10m"><StepsInput key={`l${presetId}`} value={cfg.learnSteps} onChange={(v) => set('learnSteps', v)} /></Row>
          <Row label="Graduating interval (days)"><NumberInput value={cfg.graduatingIntervalGood} onChange={(v) => set('graduatingIntervalGood', v)} min={1} /></Row>
          <Row label="Easy interval (days)"><NumberInput value={cfg.graduatingIntervalEasy} onChange={(v) => set('graduatingIntervalEasy', v)} min={1} /></Row>
          <Row label="Insertion order">
            <Select value={cfg.newCardInsertOrder} options={{ due: 'Sequential (oldest cards first)', random: 'Random' }} onChange={(v) => set('newCardInsertOrder', v)} />
          </Row>
        </Section>

        <Section title="Lapses">
          <Row label="Relearning steps" help="e.g. 10m"><StepsInput key={`r${presetId}`} value={cfg.relearnSteps} onChange={(v) => set('relearnSteps', v)} /></Row>
          <Row label="Minimum interval (days)"><NumberInput value={cfg.minimumLapseInterval} onChange={(v) => set('minimumLapseInterval', v)} min={1} /></Row>
          <Row label="Leech threshold"><NumberInput value={cfg.leechThreshold} onChange={(v) => set('leechThreshold', v)} /></Row>
          <Row label="Leech action">
            <Select value={cfg.leechAction} options={{ tagOnly: 'Tag only', suspend: 'Suspend card' }} onChange={(v) => set('leechAction', v)} />
          </Row>
        </Section>

        <Section title="Display order">
          <Row label="New card gather order"><Select value={cfg.newCardGatherPriority} options={GATHER} onChange={(v) => set('newCardGatherPriority', v)} /></Row>
          <Row label="New card sort order"><Select value={cfg.newCardSortOrder} options={NEW_SORT} onChange={(v) => set('newCardSortOrder', v)} /></Row>
          <Row label="New/review order"><Select value={cfg.newMix} options={MIX} onChange={(v) => set('newMix', v)} /></Row>
          <Row label="Interday learning/review order"><Select value={cfg.interdayLearningMix} options={MIX} onChange={(v) => set('interdayLearningMix', v)} /></Row>
          <Row label="Review sort order"><Select value={cfg.reviewOrder} options={REVIEW_ORDER} onChange={(v) => set('reviewOrder', v)} /></Row>
        </Section>

        <Section title="FSRS">
          {colCfg && (
            <Row label="FSRS" help="Collection-wide. Off = Anki’s classic SM-2 algorithm.">
              <input type="checkbox" checked={colCfg.fsrs} onChange={(e) => setColCfg({ ...colCfg, fsrs: e.target.checked })} />
            </Row>
          )}
          <Row label="Desired retention"><NumberInput value={cfg.desiredRetention} step={0.01} min={0.7} max={0.99} onChange={(v) => set('desiredRetention', v)} /></Row>
          <Row label="This deck: desired retention" help="Empty = use preset.">
            <input inputMode="decimal" value={dr} onChange={(e) => setDr(e.target.value)} placeholder="—" />
          </Row>
          <Row label="FSRS parameters" help={`Empty = defaults. Paste the parameters from Anki’s deck options to keep your optimised values.`}>
            <textarea rows={3} value={paramsText} placeholder={DEFAULT_PARAMETERS.slice(0, 4).join(', ') + ', …'} onChange={(e) => setParamsText(e.target.value)} />
          </Row>
          <Row label="Historical retention" help="Used for cards whose review history is incomplete."><NumberInput value={cfg.historicalRetention} step={0.01} onChange={(v) => set('historicalRetention', v)} /></Row>
        </Section>

        <Section title="Burying">
          <Row label="Bury new siblings"><input type="checkbox" checked={cfg.buryNew} onChange={(e) => set('buryNew', e.target.checked)} /></Row>
          <Row label="Bury review siblings"><input type="checkbox" checked={cfg.buryReviews} onChange={(e) => set('buryReviews', e.target.checked)} /></Row>
          <Row label="Bury interday learning siblings"><input type="checkbox" checked={cfg.buryInterdayLearning} onChange={(e) => set('buryInterdayLearning', e.target.checked)} /></Row>
        </Section>

        <Section title="Audio">
          <Row label="Don’t play audio automatically"><input type="checkbox" checked={cfg.disableAutoplay} onChange={(e) => set('disableAutoplay', e.target.checked)} /></Row>
        </Section>

        <Section title="Advanced">
          <Row label="Maximum interval (days)"><NumberInput value={cfg.maximumReviewInterval} onChange={(v) => set('maximumReviewInterval', v)} min={1} /></Row>
          <Row label="Maximum answer seconds"><NumberInput value={cfg.capAnswerTimeToSecs} onChange={(v) => set('capAnswerTimeToSecs', v)} min={1} /></Row>
          <Row label="Starting ease" help="SM-2 only"><NumberInput value={cfg.initialEase} step={0.05} onChange={(v) => set('initialEase', v)} /></Row>
          <Row label="Easy bonus" help="SM-2 only"><NumberInput value={cfg.easyMultiplier} step={0.05} onChange={(v) => set('easyMultiplier', v)} /></Row>
          <Row label="Interval modifier" help="SM-2 only"><NumberInput value={cfg.intervalMultiplier} step={0.05} onChange={(v) => set('intervalMultiplier', v)} /></Row>
          <Row label="Hard interval" help="SM-2 only"><NumberInput value={cfg.hardMultiplier} step={0.05} onChange={(v) => set('hardMultiplier', v)} /></Row>
          <Row label="New interval" help="SM-2 only"><NumberInput value={cfg.lapseMultiplier} step={0.05} onChange={(v) => set('lapseMultiplier', v)} /></Row>
          {colCfg && (
            <>
              <Row label="Next day starts at" help="Hour of the day. Collection-wide.">
                <select value={colCfg.rollover} onChange={(e) => setColCfg({ ...colCfg, rollover: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
              </Row>
              <Row label="Learn ahead limit (minutes)" help="Collection-wide.">
                <NumberInput value={Math.round(colCfg.learnAheadSecs / 60)} onChange={(v) => setColCfg({ ...colCfg, learnAheadSecs: Math.round(v * 60) })} />
              </Row>
            </>
          )}
        </Section>
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Btn>
      </div>

      {dialog === 'add' && (
        <PromptModal
          title="Add preset"
          label="Name"
          initial={`${preset?.name ?? 'Preset'} copy`}
          help="The new preset starts as a copy of the current settings."
          confirmLabel="Add"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            if (!v.trim()) return 'Enter a name.';
            const id = await col.addDeckConfig(v.trim(), cfg);
            await load(id);
          }}
        />
      )}
      {dialog === 'rename' && (
        <PromptModal
          title="Rename preset"
          label="Name"
          initial={preset?.name ?? ''}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            if (!v.trim()) return 'Enter a name.';
            await col.updateDeckConfig(presetId, v.trim(), cfg);
            await load(presetId);
          }}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmModal
          title="Remove preset?"
          message={`Decks using “${preset?.name}” will switch to the Default preset.`}
          confirmLabel="Remove"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await col.removeDeckConfig(presetId);
            await load(DEFAULT_CONFIG_ID);
          }}
        />
      )}
    </Modal>
  );
}
