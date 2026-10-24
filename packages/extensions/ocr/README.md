# Text in marks (`ocr`)

Reads the words under a highlight, box or circle you draw on a picture in the annotator, **on the
phone**, in English and German, so the note to the agent says `box around "…"` (R-images-015). Nothing
is sent to the desktop or a cloud model for it (R-images-012).

Optional and **off by default** (`deploy/ship.json`: ships, off). Switch it on in Settings › Tools &
diagnostics › plugins. Switching it on downloads the reader once from your own desktop and keeps it
on the phone; switching it off stops it and its row offers to delete the download.

## How it works

- **Desktop (`host/`, `scripts/build-assets.mjs`)** — the host half does nothing. `npm run build`
  copies the engine from the root devDependencies (exact versions: `tesseract.js` 7.0.0,
  `tesseract.js-core` 7.0.0, `@tesseract.js-data/eng|deu` 1.0.0, `4.0.0_best_int`) into `assets/`
  (gitignored) with a `manifest.json` of `{file, role, bytes, sha256}`. The core serves that folder
  at `/api/plugin/ocr/asset/<file>` while the extension is on (manifest `assets`; the rule exception
  in docs/notes/plugins.md). A release ships the folder beside the manifest
  (`scripts/release/build.mjs`).
- **Phone, download (`web/assets.ts`)** — on enable, the manifest and the files THIS phone needs
  (the worker, ONE core — SIMD where the phone runs it, else the plain LSTM build — and both
  languages, about 8.3 MB) are fetched through the app's authenticated API, checked for size and
  sha256 (plain JS where `crypto.subtle` is absent), and stored as Blobs in IndexedDB
  (`sdk` `extAssets`). Not Cache Storage: the APK registers no service worker and a plain-http
  page has none and no Cache API, so the core's `/ext-asset/` service-worker route is unused here.
- **Phone, reading (`web/engine.ts`)** — a lazy worker started from blob URLs: a boot script
  imports the core, then tesseract.js's own worker script; the language data is gunzipped on the
  page and written into the worker's file system, so nothing is fetched. LSTM only, `eng+deu`,
  kept warm 60 s after the last read. The text is cleaned in `web/logic.ts`: words under
  confidence 60 dropped, whitespace flattened, capped at 200 characters with `…`; nothing ⇒ null.

## Checks

- `node --test packages/extensions/ocr/web/logic.test.mjs` (part of `npm run test:unit`).
- `node packages/extensions/ocr/scripts/browser-check.mjs` — the real engine in Chromium on a
  plain-http, non-secure page with no service worker, Cache API or `crypto.subtle`: verified
  download through IndexedDB, English and German text read back, both cores, abort and blank ⇒ null.
