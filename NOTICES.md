# Third-party notices

waterplane is MIT-licensed (see `LICENSE`). This file lists the runtime
(non-dev) dependencies actually shipped across the three workspaces
(`packages/shared`, `packages/host`, `packages/web`) and their licenses, as
declared in each package's own `package.json` under `node_modules`.

No Anthropic code is bundled in this project. It only spawns and talks to a
`claude` binary you already have installed and signed in yourself — the
project is a terminal/PTY bridge and phone UI around your own local install,
not a redistribution of Claude Code.

## `packages/host`

| Package | Version | License | Project |
| --- | --- | --- | --- |
| `@xterm/headless` | 5.5.0 | MIT | https://github.com/xtermjs/xterm.js |
| `node-pty` | 1.1.0 | MIT | https://github.com/microsoft/node-pty |
| `web-push` | 3.6.7 | **MPL-2.0** | https://github.com/web-push-libs/web-push |
| `ws` | 8.21.0 | MIT | https://github.com/websockets/ws |

## `packages/web`

| Package | Version | License | Project |
| --- | --- | --- | --- |
| `@xterm/addon-fit` | 0.10.0 | MIT | https://github.com/xtermjs/xterm.js |
| `@xterm/xterm` | 5.5.0 | MIT | https://github.com/xtermjs/xterm.js |
| `lucide-react` | 1.21.0 | ISC | https://lucide.dev |
| `react` | 18.3.1 | MIT | https://reactjs.org/ |
| `react-dom` | 18.3.1 | MIT | https://reactjs.org/ |

## `packages/extensions/ocr` (downloaded to the phone, not in the web bundle)

The text-in-marks extension's engine is copied from these packages into its `assets/` folder at
build time and downloaded to the phone only when the person switches the extension on.

| Package | Version | License | Project |
| --- | --- | --- | --- |
| `tesseract.js` (worker script) | 7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js |
| `tesseract.js-core` (Tesseract + Leptonica in wasm) | 7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js-core |
| `@tesseract.js-data/eng`, `@tesseract.js-data/deu` (`4.0.0_best_int`) | 1.0.0 | MIT (package); the traineddata is Apache-2.0 (tesseract-ocr/tessdata_best) | https://github.com/naptha/tessdata |

## `packages/shared`

No runtime dependencies — it's the wire-protocol type definitions shared by
the other two workspaces.

## A note on `web-push` (MPL-2.0)

Every other runtime dependency above is MIT or ISC — both short,
permissive, attribution-only licenses fully compatible with this project's
MIT license. `web-push` is the one exception: it's licensed under the
**Mozilla Public License 2.0**, a weak-copyleft, *file-level* license.

That matters less than it sounds. MPL-2.0's copyleft applies to the
*licensed files themselves* — if you modify a file from the MPL-licensed
library and distribute that modified file, you owe the source for that file
under MPL-2.0. It does **not** propagate to code that merely imports the
library and calls its API, the way `packages/host/src/push.ts` does here.
This project:

- uses `web-push` unmodified, straight from npm as an ordinary dependency
  (`packages/host/package.json`), and
- never vendors, forks, or edits any of its source files.

So using it here imposes no relicensing obligation on this project — the
rest of the codebase stays MIT, and only `web-push`'s own files (which this
project doesn't touch) remain under MPL-2.0. If you fork this project and
start editing `web-push`'s own source directly, MPL-2.0's file-level
copyleft would apply to *those* edited files — but that's a decision you'd
be making, not something inherited from using the library as-is.

## Verifying this file

Every license claim above was read directly from the installed package's own
`package.json` (`node_modules/<pkg>/package.json`), not assumed from
reputation. If a dependency is upgraded or a new one added, re-check its
license the same way before updating this file.
