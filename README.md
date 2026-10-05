# GakuTaku

A personal Android app (plus a desktop web build) for learning Japanese: read books and NHK news
with furigana and tap-to-lookup, mine words into flashcards, and review them with FSRS — a
replacement for Anki/AnkiDroid. Everything is stored **on the device**; there are no accounts and no
server.

## Install on Android

Every merge to `main` builds a signed APK and publishes it as a
[GitHub Release](../../releases). Install it with **[Obtainium](https://github.com/ImranR98/Obtainium)**
(add this repository's URL) so updates arrive automatically, or download the APK from the latest
release.

Every release is signed with the same key, so updates install over the previous version and keep your
data. Uninstalling the app **deletes its data** — make a backup first.

## Stack

- React + TypeScript + Vite, Tailwind, Zustand
- **Capacitor** wraps the web app as the Android APK (native HTTP for feeds, hardware back button)
- **SQLite** (official WASM build) in a Web Worker, stored in the Origin Private File System — one
  database file holding decks, notes, cards, review history, books and settings (`src/db/`)
- IndexedDB holds binary files: book files and imported Anki media
- Japanese core in a Web Worker: kuromoji tokenizer, furigana, deinflection, and a bundled
  JMdict + JMnedict + KANJIDIC dictionary (`src/jp-core/`, `src/dictionary/`)

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run lint         # typecheck
npm run verify       # scheduler, collection, import, analytics and dictionary checks
npm run build        # production web build (PWA)
```

The dictionary isn't committed. To get word lookup locally, download `jmdict-eng-*.json`,
`jmnedict-all-*.json` and `kanjidic2-en-*.json` from
[jmdict-simplified releases](https://github.com/scriptin/jmdict-simplified/releases/latest) into
`dict-src/` and run `npm run build:dict` (writes `public/dict/jmdict/`). CI does this for every APK.

### Android

```bash
npm run build:android            # web build without service worker + `cap sync android`
cd android && ./gradlew assembleDebug
```

Needs JDK 21 and the Android SDK. CI (`.github/workflows/ci.yml`) builds the release APK; it signs
with the keystore in the `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` repository
secrets (alias `gakutaku`). Without them CI still builds a debug APK as an artifact, but publishes no
release.

## Architecture notes

- **Database.** `src/db/index.ts` exposes `db.execute / getAll / getOptional / writeTransaction`;
  all statements run one at a time through a queue. Code inside `writeTransaction` must use its `tx`
  argument. `useQuery` (`src/db/useQuery.ts`) is a live query: SQLite's update hook reports which
  tables each write touched, and only queries reading those tables re-run.
- **Schema changes** are append-only migrations in `src/db/schema.ts` (tracked with
  `PRAGMA user_version`).
- **Anki media needs an explicit MIME type** on the stored Blob, or `<audio>` refuses to play it.
  See `src/import/mediaMime.ts`.
- **Anki engine** (`src/anki/`) is a port of Anki's Rust core, not a look-alike. It covers:
  - the collection model (decks, presets, note types, notes and cards with Anki's
    `type`/`queue`/`due` semantics, plus the revlog);
  - the v3 scheduler, including learning steps, FSRS-6, SM-2, fuzz, limits, sibling burying and
    learn-ahead;
  - deck-tree counts and the template renderer (furigana, cloze, type-in, `[sound:]`).

  Things that look odd are usually Anki's behaviour; check `rslib/src/scheduler` before changing them.
  The `scripts/verify-*.ts` checks pin the port to Anki's own test vectors and to
  `test_schedv3.py` scenarios.
- **Import** (`src/import/`) reads `.apkg` and `.colpkg` files, both legacy and schema-18/zstd. It
  keeps every card's scheduling state and FSRS memory state, plus the review history and the
  deck-options presets, so due counts match Anki after import. Day-based due dates are shifted from
  the source collection's day numbering to ours.
- **Cards render in a sandboxed iframe** (`src/study/CardView.tsx`). It uses Anki's reviewer
  document structure (`<body class="card cardN">`, `nightMode`), so a note type's CSS behaves as it
  does in Anki and AnkiDroid. Media is inlined from the local store.
- **Feeds** are fetched with Capacitor's native HTTP on Android, which isn't subject to CORS and
  decodes Shift_JIS / EUC-JP feeds (`src/feeds/proxy.ts`). In a desktop browser only sites that allow
  cross-origin reads work.
