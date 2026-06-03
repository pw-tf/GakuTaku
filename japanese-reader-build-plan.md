# Japanese Reading & SRS App — Build Plan & Technical Spec

> Handoff document for Claude Code. Each milestone is independently shippable and testable. Build in order; M2 (the Japanese core) is the keystone everything else consumes.

---

## 1. Overview

A Progressive Web App for learning Japanese through immersion reading. Users upload books (ePUB first) or read articles from RSS feeds, get automatic furigana and instant tap-to-lookup dictionary on any text, mine unknown words into flashcards, and review them with an FSRS spaced-repetition engine — all working offline and syncing in real time across devices. Anki `.apkg` decks can be imported.

**Locked decisions**

| Decision | Choice |
|---|---|
| Audience | Personal first, multi-user from day one (signup built in) |
| Platform | PWA (installable, offline-capable) |
| Backend | Supabase (Postgres + Auth + Storage + RLS) |
| Sync | PowerSync — real-time, offline-first, multi-device merge |
| SRS algorithm | FSRS (via `ts-fsrs`) |
| Anki interop | `.apkg` import |
| First reader format | ePUB |
| Target language | Japanese |

---

## 2. Tech Stack (locked)

- **Frontend:** React + TypeScript, Vite, `vite-plugin-pwa` (Workbox service worker), Tailwind for styling, Zustand for UI state.
- **Backend / auth / storage:** Supabase (Postgres, Auth, Storage buckets, Row-Level Security).
- **Sync:** PowerSync web SDK (local SQLite via WASM) ↔ Supabase. Native Supabase Auth integration; per-user sync rules; conflict resolution in the backend connector.
- **Japanese core (client-side, in a Web Worker):**
  - Tokenizer: a maintained Kuromoji fork / ESM build (returns surface form, reading, base form, part-of-speech).
  - Dictionary: JMdict + KANJIDIC + JMnedict, preprocessed into a local queryable store (sql.js or Dexie), Yomitan/Yomichan dictionary format as reference.
  - Deinflection: Yomitan-style rule engine to map conjugated forms to dictionary entries.
- **SRS:** `ts-fsrs` for scheduling; `@open-spaced-repetition/binding` for optimizing FSRS parameters from the user's own review logs (powers personalized intervals + analytics).
- **Reader:** `epub.js` (M3). Later: `pdf.js` (PDF), `mammoth.js` (docx→HTML).
- **RSS:** Supabase Edge Function as feed proxy (avoids browser CORS) + parser + readability extraction.

---

## 3. Architecture

### 3.1 Two local data layers (do not conflate these)

1. **PowerSync SQLite** — *user data only*: decks, notes, cards, review_logs, document metadata, reading_positions, feeds, settings. Synced in real time with Supabase Postgres.
2. **IndexedDB / sql.js / Cache API** — *large static or binary data that must NOT go through Postgres*: the dictionary + tokenizer dictionaries (static assets, cached on first run) and cached document blobs. Syncing these through PowerSync would be wasteful and is unnecessary.

Document binaries (the actual ePUB files) live in a **Supabase Storage** bucket; their metadata lives in the synced `documents` table; the blob is cached locally for offline reading.

### 3.2 Sync model

Reads and writes go to the local SQLite DB, so the app is fully usable offline. PowerSync's upload queue flushes to Supabase when connectivity returns and streams remote changes back. Sync rules (buckets) scope every row to its `user_id` so users only ever sync their own data.

### 3.3 Conflict strategy — event-sourced reviews

`review_logs` is **append-only** and is the source of truth for scheduling. A card's FSRS state (due date, stability, difficulty, reps, lapses) is **derived by replaying its logs through `ts-fsrs`**, not edited in place. Consequence: reviewing the same card on two offline devices produces two log rows that simply union on sync, after which both devices recompute identical card state. No conflicts on the hardest path.

- `reading_positions`: latest-timestamp-wins (or furthest position) — trivial.
- `notes` / `decks` content edits: field-level last-write-wins (concurrent edits are rare).

### 3.4 Japanese core (Web Worker)

Tokenizing a chapter is CPU-heavy, so the tokenizer + dictionary live in a Web Worker and expose a small message API: `tokenize(text)`, `furiganaFor(text)`, `lookup(text)`. The UI thread never blocks. The worker loads its dictionary assets once and they persist in cache for offline use.

### 3.5 Universal lookup service

A single app-level handler captures text selection / tap on any surface (reader, RSS article, furigana'd text), routes it through the worker (tokenize → deinflect → dictionary query), and renders one shared popup with definitions and a **＋ Add to deck** button. "Dictionary across the board" is therefore one service, not per-page code.

---

## 4. Data Model

**Synced via PowerSync (Postgres tables, RLS by `user_id`):**

- `decks` — `id, user_id, name, fsrs_params (jsonb), created_at`
- `note_types` — `id, user_id, name, fields (jsonb), card_templates (jsonb)` (mirrors Anki's model so import is a clean map)
- `notes` — `id, user_id, deck_id, note_type_id, fields (jsonb), tags, created_at`
- `cards` — `id, user_id, note_id, template_index, due, stability, difficulty, reps, lapses, state, last_review` (these FSRS fields are *derived* from logs — see 3.3)
- `review_logs` — `id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days` **(append-only)**
- `documents` — `id, user_id, title, type, source ('upload'|'rss'), storage_path, language, added_at`
- `reading_positions` — `id, user_id, document_id, locator (CFI), percent, updated_at`
- `feeds` — `id, user_id, url, title, added_at`
- `mined_words` — `id, user_id, term, reading, context, document_id, looked_up_at` (optional history → one-click cards)
- `user_settings` — `id, user_id, furigana_default, theme, vertical_text, ...`

**Supabase Storage:** uploaded ePUB/media files, imported `.apkg` media.

**Local-only (IndexedDB / sql.js):** dictionary entries (JMdict/KANJIDIC/JMnedict), tokenizer dictionary, cached document blobs.

---

## 5. Milestones

### M0 — Scaffold & infrastructure
- **Goal:** Empty but deployable PWA with backend wired up.
- **Tasks:** Vite + React + TS project; Tailwind; `vite-plugin-pwa` configured (installable, app shell cached); Supabase project + initial migrations for the tables in §4; PowerSync instance connected to Supabase with per-user sync rules.
- **Deliverable:** App installs as a PWA and loads offline (shell only); Supabase + PowerSync handshake works.
- **Acceptance:** Lighthouse PWA-installable check passes; an empty synced table round-trips a test row across two browser sessions.

### M1 — Auth & synced data layer
- **Goal:** Real signup and a working local-first data layer.
- **Tasks:** Supabase Auth (email/password + at least one OAuth provider); RLS policies on every table; PowerSync backend connector with conflict resolution; local SQLite read/write hooks; offline write → reconnect → sync verified.
- **Deliverable:** A user can sign up, log in, and create/read a record offline that later appears on a second device.
- **Acceptance:** Create a deck offline on Device A; it appears on Device B after reconnect without manual refresh.

### M2 — Japanese core (KEYSTONE)
- **Goal:** Offline tokenization, furigana, and dictionary lookup.
- **Tasks:** Web Worker hosting the tokenizer; load + cache tokenizer dict assets; `tokenize()` API; furigana generator (tokens → `<ruby>`, katakana→hiragana conversion); build script to preprocess JMdict/KANJIDIC/JMnedict into the local store; deinflection engine; `lookup()` API; shared lookup popup component with "＋ Add to deck" stub.
- **Deliverable:** A test page where pasting Japanese text yields tokens + togglable furigana, and tapping any word shows dictionary entries — all offline.
- **Acceptance:** Works with airplane mode on; ambiguous-reading sanity checks pass (e.g. 今日 → きょう in context); deinflected verb (e.g. 食べた → 食べる) resolves to the dictionary entry.

### M3 — ePUB reader
- **Goal:** Read uploaded ePUBs with furigana + universal lookup, position synced.
- **Tasks:** Upload flow (file → Supabase Storage, metadata → `documents`, blob cached locally); `epub.js` render (paginated + scrolled modes; evaluate vertical-text/tategaki support); selectable text wired to the lookup popup; furigana toggle applied to rendered content; reading position (CFI) persisted to `reading_positions`.
- **Deliverable:** Upload an ePUB, read it, toggle furigana, tap words to look up, resume position on another device.
- **Acceptance:** Position set on Device A resumes on Device B; furigana toggle persists per user setting; lookup popup works inside the rendered book.

### M4 — SRS engine, review UI & mining
- **Goal:** Turn looked-up words into reviewable cards with FSRS.
- **Tasks:** `ts-fsrs` integration; review UI (Again/Hard/Good/Easy) with FSRS preview of next intervals; write `review_logs` and derive card state per §3.3; wire the popup's "＋ Add to deck" to create notes + cards; basic deck list / browser.
- **Deliverable:** Mine a word while reading, then review it; scheduling advances correctly.
- **Acceptance:** Review the same card offline on two devices, reconnect, and both converge to identical derived state (proves the event-sourcing design).

### M5 — Analytics
- **Goal:** Insight into review performance, computed locally from logs.
- **Tasks:** Review heatmap, true-retention, upcoming-review forecast, mature/young counts, time-of-day stats; optional FSRS parameter optimization via `@open-spaced-repetition/binding` retraining from the user's logs.
- **Deliverable:** An analytics dashboard.
- **Acceptance:** Stats match a hand-computed sample; optimized FSRS params write back to `decks.fsrs_params` and affect future scheduling.

### M6 — `.apkg` import
- **Goal:** Bring existing Anki decks in.
- **Tasks:** Client-side `.apkg` parse with sql.js (read embedded SQLite collection); map note types/notes/cards into the schema; import media to Storage; preserve FSRS scheduling state where present, else schedule fresh.
- **Deliverable:** Import a real `.apkg` and review its cards.
- **Acceptance:** A multi-note-type deck imports with fields, media, and review history intact and is immediately reviewable.

### M7 — RSS / articles
- **Goal:** Daily reading material in the same reader surface.
- **Tasks:** Supabase Edge Function feed proxy + parser + readability extraction; feed management UI; article → reader view (furigana + lookup + mining reuse from M2/M3).
- **Deliverable:** Add a Japanese RSS feed and read an article with furigana and lookup.
- **Acceptance:** A feed's latest articles list and open cleanly with working furigana + lookup. (Note: Todaii has no public API — this is generic RSS; Todaii-style sources are added as feeds or via readability scraping.)

### M8 — Polish, hardening & extra formats
- **Goal:** Production readiness.
- **Tasks:** Offline audits and error/empty states; PDF reader (`pdf.js`) and docx (`mammoth.js`); optional `.apkg` export (round-trip to Anki); settings; onboarding; attribution screen (see §6).
- **Acceptance:** Full offline-to-online lifecycle is smooth; all reader formats support lookup + (where applicable) furigana.

---

## 6. Licensing & attribution (set up early, not at the end)

- **JMdict / JMnedict / KANJIDIC:** free under the EDRDG license **but require visible attribution** — include a credits screen from M2 onward.
- **Kuromoji dictionary (IPADIC):** permissive.
- **`ts-fsrs`:** open source.
- **User content:** uploaded books and imported `.apkg` decks are the user's own copies — fine. Do **not** build sharing/redistribution of copyrighted books or third-party decks.

---

## 7. Risks & decisions deferred to implementation

- **Dictionary bundle size** (tens of MB) — decide on lazy first-run download + progress UI; consider splitting JMnedict (names) as an optional add-on.
- **Vertical text (tategaki)** in `epub.js` — confirm support depth in M3; may constrain furigana rendering.
- **Auto-furigana accuracy** (~95%) — plan a "correct this reading" affordance; ambiguous and name readings will occasionally be wrong.
- **PowerSync free-tier limits** — verify against expected dictionary-independent row counts (the dictionary is *not* synced, which keeps synced volume small).
- **`.apkg` scheduling formats** — Anki has multiple historical scheduler versions; M6 should detect version and degrade gracefully.

---

## 8. Suggested repo structure

```
/src
  /app            # routing, providers, PWA setup
  /auth           # Supabase auth
  /sync           # PowerSync schema, connector, conflict resolution
  /jp-core        # worker: tokenizer, furigana, deinflection, dictionary
  /dictionary     # build scripts + loader for JMdict/KANJIDIC/JMnedict
  /reader         # epub.js integration, furigana overlay, position tracking
  /srs            # ts-fsrs scheduling, review UI, mining
  /analytics
  /import         # .apkg parser
  /feeds          # RSS UI (proxy lives in /supabase/functions)
  /ui             # shared components incl. lookup popup
/supabase
  /migrations
  /functions      # rss-proxy edge function
```
