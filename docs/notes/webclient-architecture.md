# The phone's HTTP client, the gallery and the repo-health words — the split

`api.ts` (1033 lines), `Gallery.tsx` (989) and `repoHealthWords.ts` (902) are cut into folders of
slices, each file at most 500 lines. The original path stays as a facade, so no importer changes.
Move-only; pinned by `tools/webclientpins.test.mjs` and held by `tools/webshape.test.mjs`
(facade ratchets + a per-file cap table). Basenames are prefixed (`webapi*`, …) because they must be
unique across packages.

## api.ts → `webapi/`

`api` was one 750-line object literal. It is now `{ ...sessionsApi, ...statsApi, ... }` over nine
slices, in the original member order (pinned). Each slice is `export const xApi = { ... }`:

| slice | holds |
|---|---|
| `webapiSessions` | repos, slash, transcript, scrollback, shell detail, context series |
| `webapiStats` | token stats, usage log, windows |
| `webapiFiles` | inbox/outbox, uploads, sweep, host store |
| `webapiRepos` | new folder/repo/worktree, onboarding, the `abs()` URLs |
| `webapiGit` | git review |
| `webapiTree` | conversation archive, worktree tree |
| `webapiRepoOps` | branches, secrets, compliance, setup prefs, repo health |
| `webapiHost` | host stat, screenshot, readText, dictate, clipboard |
| `webapiNet` | speed test, netstats, push, pair, peers, devices |

Support: `webapiFetch` (`nfetch`, `jget`, `jpost`, `jpostOk`, `jdel` — the counted, fused fetch),
`webapiBg` (`bgFetch`, `bgJson`), `webapiClipboard` (`copyText`), `webapiTypes` (every exported type).

Rules kept: every `/api/...` URL stays a literal direct call argument inside its slice (the demo
contract test reads them off the AST); `abs()` is still called by hand only for the URLs loaded as
`<img src>`/`<a download>` (`artifactUrl`, `inboxUrl`, in `webapiRepos`); the `webapi/**` folder is
in the lint `FETCH_OWNERS` list beside `api.ts`.

## Gallery.tsx → `gallery/`

`Gallery` was one 780-line component. It is now a composer: `useGallery(props)` builds one model, and
three regions read it — `GalleryBar` (head, search, tab/kind/time chips, notes), `GalleryGrid` (tiles,
load more), `GalleryViewer` (the open file and its action bar).

Hooks, in the original effect order (pinned): `useGalleryOpen` (the open file, `directRef`, the one
`showFile` writer, Back step) → the pull subscription → `useGalleryListing` (tabs, cuts, the listing
fetch with its cache seed, thumbnail warm, page reset) → `useGalleryViewer` (full-res opt-in, read
mark, document text with its saved copy) → the local-copy object URL → the keyboard. `galleryUrls`
holds the pure repo/original/thumb/view URL helpers so the listing hook can warm thumbnails;
`GalleryTiles` the cache-first `GridThumb`/`GridVideo`; `galleryTypes` props, scopes, constants.

Held: one `DownloadButton` component (three call sites, no `<a download>`), the unfiltered-only cache
write, no write over typed words (nothing is typed here but the search). Proven by server-rendering 41
cases (every tab, every viewer kind) before and after: byte-identical, digests in
`tools/webclientpins.golden.json`. `scripts/e2e-gallery.mjs` reads the facade plus `gallery/*`.

## repoHealthWords.ts → `repoHealthWords/`

Pure sentences, no DOM, no React. The facade keeps the header (why the words are not in the sheet,
why staleness is counted in commits, what the module never does) and `export *`s seven slices:
`Engine` (empty series, read failure, engine line, refresh labels), `Stale` (durations, staleness,
warnings, refresh failure), `Run` (mixed versions, outcome, running, drawn page), `Rank` (region 2's
value / rank / KPI words, tile absences), `Plot` (axes, readouts, scrub, slope, the two clocks),
`Region` (area, table, not-plotted, the ask labels, region words), `Scope` (a reading of one subtree).
The five private helpers (`nf`, `ordinal`, `pctOf`, `spanWords`, `commitWords`) live in `Fmt` and are
NOT re-exported — the surface is unchanged. Slices import only each other (checked), with explicit
`.ts` extensions so `node --test` still runs them over the TypeScript.

Proven by: the type-checker surface pin, and a golden over all 46 exports called with a fixed battery
of inputs (arities up to 3, ~1.4 MB of answers), generated from the pre-split file.
`repoHealthWords.test.mjs` is untouched; its one source-text check ("no status colour token") only
sees the facade now, so `webclientpins` repeats it over the folder.
