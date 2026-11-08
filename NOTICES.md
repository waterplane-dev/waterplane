# Third-party notices

waterplane is MIT-licensed (see `LICENSE`). This file lists the runtime
(non-dev) dependencies actually shipped across the three workspaces (`packages/shared`, `packages/host`,
`packages/web`) and the Android shell (`packages/app`), and their licenses, as
declared in each package's own `package.json` under `node_modules`.

No Anthropic code is bundled in this project. It only spawns and talks to a
`claude` binary you already have installed and signed in yourself — the
project is a terminal/PTY bridge and phone UI around your own local install,
not a redistribution of Claude Code.

## `packages/host`

| Package | Version | License | Project |
| --- | --- | --- | --- |
| `@xterm/headless` | 5.5.0 | MIT | https://github.com/xtermjs/xterm.js |
| `node-pty` | 1.2.0-beta.15 | MIT | https://github.com/microsoft/node-pty |
| `ws` | 8.22.0 | MIT | https://github.com/websockets/ws |

## `packages/web`

| Package | Version | License | Project |
| --- | --- | --- | --- |
| `@noble/hashes` | 2.4.0 | MIT | https://paulmillr.com/noble/ |
| `@noble/post-quantum` | 0.7.1 | MIT | https://paulmillr.com/noble/ |
| `@xterm/addon-fit` | 0.11.0 | MIT | https://github.com/xtermjs/xterm.js |
| `@xterm/xterm` | 6.0.0 | MIT | https://github.com/xtermjs/xterm.js |
| `lucide-react` | 1.61.0 | ISC | https://lucide.dev |
| `qrcode-generator` | 2.0.4 | MIT | https://github.com/kazuhikoarase/qrcode-generator |
| `react` | 18.3.1 | MIT | https://reactjs.org/ |
| `react-dom` | 18.3.1 | MIT | https://reactjs.org/ |

## `packages/app` (the Android shell)

| Package | Version | License | Project |
| --- | --- | --- | --- |
| `@capacitor/android` | 8.5.3 | MIT | https://capacitorjs.com |
| `@capacitor/core` | 8.5.3 | MIT | https://capacitorjs.com |
| `@capacitor/ios` | 8.5.3 | MIT | https://capacitorjs.com |

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

## Verifying this file

Every license claim above was read directly from the installed package's own
`package.json` (`node_modules/<pkg>/package.json`), not assumed from
reputation. If a dependency is upgraded or a new one added, re-check its
license the same way before updating this file.
