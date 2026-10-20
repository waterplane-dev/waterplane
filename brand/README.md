# brand/

The one source of truth for the logo. Every icon, favicon, launcher layer, notification glyph and
splash in the repo is **generated** from the SVGs here by `npm run brand:assets`
(`scripts/brand-assets.mjs`, rasteriser `@resvg/resvg-js`, no system tools needed).

**To rebrand: replace the SVGs (and `brand.json`), run `npm run brand:assets`, commit the diff.**
Never edit a generated PNG; `tools/brandassets.test.mjs` fails when an output is missing or the
inputs changed without a regeneration (`brand/outputs.json` records the input hash).

| File | Role |
|---|---|
| `icon.svg` | master mark, dark: every size of 64 px and up |
| `icon-small.svg` | simplified mark: every raster **below 64 px** (the spec's cut, `smallCutPx`) |
| `icon-light.svg` | light-background variant (docs on white; the in-app logo in the light theme) |
| `icon-small-light.svg` | light simplified mark: the in-app logo below 64 px in the light theme (header). Not rasterised |
| `icon-mono.svg` | single-colour silhouette: SVG favicon, push badge, status-bar glyph |
| `android-{foreground,background,monochrome}.svg` | adaptive icon layers, 108 dp canvas, 66 dp safe zone; also the PWA maskable icon |
| `hero.svg` | README / store hero, 1600x900. Its text is **outlined** (JetBrains Mono ExtraBold, Inter 600/400) so it does not depend on installed fonts |
| `hero-src.svg` | the editable original of the hero with live `<text>`; re-outline after editing it |
| `brand.json` | palette (Night, Dusk, Sea, Amber, Coral, Foam), the 64 px cut, the wordmark |
| `outputs.json` | generated: every output path + the hash of the inputs it came from |

The wordmark is the lowercase monospace lockup `waterplane_`, the underscore in Amber. It is a
lockup only: prose uses the plain name.

Re-outlining `hero-src.svg`: load the two fonts with `opentype.js` (fontsource woff files), lay the
glyphs out one by one (mono advance plus the `letter-spacing`, Inter with kerning), write each run
as a `<path d>` with the same fill and opacity, and save as `hero.svg`.

## Outputs and who reads them

- `packages/web/public/assets/`: `icon.svg` (theme-aware mono favicon), `icon-dark.svg`,
  `icon-light.svg`, `icon-{32,48}.png` (small mark), `icon-192.png`, `icon-512.png`,
  `icon-512-maskable.png`, `apple-touch-icon.png`, `badge-96.png` (push badge), `hero.png`.
- `packages/app/android/app/src/main/res/`: `mipmap-*/ic_launcher{,_round,_foreground}.png`,
  `drawable/ic_launcher_{background,monochrome}.xml` (vector), `values/ic_launcher_background.xml`,
  `drawable-*dpi/ic_stat_app.png` (white notification glyph), `drawable*/splash.png`.
- `docs/assets/`: `hero.svg`, `icon-light.svg`.
- `packages/vscode/icon.png`: the Marketplace icon, 256 px, transparent corners.
