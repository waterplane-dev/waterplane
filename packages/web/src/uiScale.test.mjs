/**
 * Text and icon size as a setting — the part that must not be able to lock
 * somebody out of their own app.
 *
 * The multipliers come out of `localStorage`, which is a file a person can edit
 * and a place an older build may have written a different range into. A 4× that
 * survived would render an app nobody can reach the settings screen in to undo
 * it, which is the one failure this setting must never cause. So the clamp is on
 * the way OUT, not on the way in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { clampScale, TEXT_STEPS, ICON_STEPS, TEXT_MIN, TEXT_MAX, ICON_MIN, ICON_MAX } =
  await import("./uiScaleSteps.ts");

const text = (raw) => clampScale(raw, TEXT_MIN, TEXT_MAX);
const icon = (raw) => clampScale(raw, ICON_MIN, ICON_MAX);

test("nothing stored is exactly 1 — the app ships unscaled", () => {
  assert.equal(text(null), 1);
  assert.equal(icon(null), 1);
});

test("every offered step survives the clamp", () => {
  // A chip that sets a value the reader then clamps away is a control that
  // silently disagrees with its own label.
  for (const s of TEXT_STEPS) assert.equal(text(String(s.value)), s.value, s.label);
  for (const s of ICON_STEPS) assert.equal(icon(String(s.value)), s.value, s.label);
});

test("a hand-edited value is clamped, never honoured", () => {
  assert.equal(text("4"), TEXT_MAX, "an app nobody can reach the settings screen in is the failure");
  assert.equal(text("0.05"), TEXT_MIN);
  assert.equal(icon("99"), ICON_MAX);
  assert.equal(icon("-3"), ICON_MIN);
});

test("garbage reads as the default rather than as NaN", () => {
  // `calc(13px * NaN)` is an invalid declaration, which drops the whole rule —
  // i.e. a typo in storage would UN-STYLE the app rather than mis-size it.
  for (const junk of ["", "  ", "large", "undefined", "1,2"]) {
    assert.equal(text(junk), 1, JSON.stringify(junk));
    assert.ok(Number.isFinite(text(junk)));
  }
});

test("the default is one of the offered steps", () => {
  // Otherwise nothing is highlighted on a fresh install and the row looks broken.
  assert.ok(TEXT_STEPS.some((s) => s.value === 1));
  assert.ok(ICON_STEPS.some((s) => s.value === 1));
});

// ── The console's own zoom ─────────────────────────────────────────────────
// Same failure to prevent, one step further from the settings screen: this one
// multiplies the text scale, so the two together are what can make the terminal
// unreadable — and the buttons that would undo it are drawn at a size the other
// knob owns.
const { termFontPx, nextTermZoom, TERM_ZOOM_STEPS, TERM_PX_MIN, TERM_PX_MAX, TERM_BASE_PX } =
  await import("./uiScaleSteps.ts");

test("unzoomed, the console is the size it always was", () => {
  // The default must be pixel-identical to the build before this knob existed,
  // or every device that never touches it got a silent resize.
  assert.equal(termFontPx(1, 1), TERM_BASE_PX);
});

test("the two multipliers compose, and the pixels are clamped", () => {
  assert.equal(termFontPx(1.3, 1), Math.round(TERM_BASE_PX * 1.3));
  assert.equal(termFontPx(1.45, 1.5), TERM_PX_MAX, "big × big is still a grid the CLI can draw in");
  assert.equal(termFontPx(0.9, 0.6), Math.max(TERM_PX_MIN, Math.round(TERM_BASE_PX * 0.9 * 0.6)));
  assert.ok(termFontPx(0.9, 0.6) >= TERM_PX_MIN, "never a smear nobody can read the undo button in");
});

test("garbage is the base size, never NaN", () => {
  // xterm given a NaN fontSize measures a NaN cell and fits a NaN grid — which
  // is reported to the host as the PTY size.
  assert.equal(termFontPx(NaN, 1), TERM_BASE_PX);
  assert.equal(termFontPx(1, NaN), TERM_BASE_PX);
});

test("the ends of the ladder offer no button at all", () => {
  // `null` is what the toolbar renders as NOTHING — never as a dimmed control
  // (`Unavailable.tsx`), and the readout says "smallest"/"biggest" instead.
  assert.equal(nextTermZoom(TERM_ZOOM_STEPS[0], -1, 1), null);
  assert.equal(nextTermZoom(TERM_ZOOM_STEPS[TERM_ZOOM_STEPS.length - 1], 1, 1), null);
  assert.notEqual(nextTermZoom(TERM_ZOOM_STEPS[0], 1, 1), null);
});

test("every offered step actually changes the size on screen", () => {
  // A button that visibly does nothing is worse than a button that is not
  // there — the px clamp can flatten two neighbouring multipliers onto one
  // size, and those are skipped rather than offered.
  for (const text of [0.9, 1, 1.15, 1.3, 1.45]) {
    for (const z of TERM_ZOOM_STEPS) {
      for (const dir of [1, -1]) {
        const next = nextTermZoom(z, dir, text);
        if (next == null) continue;
        assert.notEqual(termFontPx(text, next), termFontPx(text, z), `${text}×${z} ${dir > 0 ? "up" : "down"}`);
      }
    }
  }
});

test("stepping all the way down and back is a round trip", () => {
  // Nobody should be able to walk into a size they cannot walk out of.
  let z = 1;
  for (let i = 0; i < 20; i++) { const n = nextTermZoom(z, -1, 1); if (n == null) break; z = n; }
  assert.equal(termFontPx(1, z), termFontPx(1, TERM_ZOOM_STEPS[0]));
  for (let i = 0; i < 20; i++) { const n = nextTermZoom(z, 1, 1); if (n == null) break; z = n; }
  assert.equal(termFontPx(1, z), termFontPx(1, TERM_ZOOM_STEPS[TERM_ZOOM_STEPS.length - 1]));
});

test("a value from nowhere still steps", () => {
  // Hand-edited storage, or a build with a different ladder: the buttons work
  // off the NEAREST step rather than refusing to move.
  assert.equal(nextTermZoom(0.83, 1, 1), 0.9);
  assert.equal(nextTermZoom(0.83, -1, 1), 0.7);
});

// ── The reader's ladder ────────────────────────────────────────────────────
// Same buttons, other surface. The reader is HTML, so what comes out is a
// MULTIPLIER for `--ui-font` rather than a pixel size — and the clamp is on the
// PRODUCT, because the text setting is already in it.
const { readerScale, nextReaderZoom, READER_SCALE_MIN, READER_SCALE_MAX } =
  await import("./uiScaleSteps.ts");

test("unzoomed, the reader is exactly the app's text size", () => {
  for (const t of [0.9, 1, 1.15, 1.3, 1.45]) assert.equal(readerScale(t, 1), t);
});

test("the product is clamped, not either half", () => {
  assert.equal(readerScale(0.9, 0.6), READER_SCALE_MIN, "0.54 would be a page nobody can read the way out of");
  assert.equal(readerScale(1.45, 1.5), READER_SCALE_MAX);
  assert.equal(readerScale(NaN, 1), 1, "an invalid calc() drops the whole rule — never NaN");
});

test("the reader's ends offer no button either", () => {
  let z = 1;
  for (let i = 0; i < 20; i++) { const n = nextReaderZoom(z, -1, 1); if (n == null) break; z = n; }
  assert.equal(nextReaderZoom(z, -1, 1), null);
  assert.notEqual(nextReaderZoom(z, 1, 1), null, "the way back is always there");
});

test("every offered reader step changes the rendered size", () => {
  for (const text of [0.9, 1, 1.15, 1.3, 1.45]) {
    for (const dir of [1, -1]) {
      let z = 1;
      for (let i = 0; i < 20; i++) {
        const n = nextReaderZoom(z, dir, text);
        if (n == null) break;
        assert.notEqual(readerScale(text, n), readerScale(text, z), `${text} ${dir > 0 ? "up" : "down"}`);
        z = n;
      }
    }
  }
});
