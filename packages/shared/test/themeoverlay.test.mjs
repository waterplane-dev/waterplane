// A fork's theme.json: validation, the merge into the terminal palette, the stylesheet it adds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TERM_COLORS, cleanThemeOverlay, describeThemeOverlay, overlayChromeBg, parseThemeColour,
  parseThemeOverlay, termColorsFor, themeOverlayCss, themeOverlayEmpty,
} from "../dist/index.js";

test("colours: hex, rgb() and hsl() parse; names, var() and junk do not", () => {
  assert.deepEqual(parseThemeColour("#abc"), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  assert.deepEqual(parseThemeColour("#0b0d10"), { r: 11, g: 13, b: 16, a: 1 });
  assert.equal(parseThemeColour("#00000080").a, 0.502);
  assert.deepEqual(parseThemeColour("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseThemeColour("rgba(255, 255, 255, .35)"), { r: 255, g: 255, b: 255, a: 0.35 });
  assert.deepEqual(parseThemeColour("rgb(76 154 255 / 50%)"), { r: 76, g: 154, b: 255, a: 0.5 });
  assert.deepEqual(parseThemeColour("hsl(0 100% 50%)"), { r: 255, g: 0, b: 0, a: 1 });
  for (const bad of ["red", "var(--bg)", "#12", "rgb(1,2)", "#0b0d10; } body { display:none", "hsl(0, 1, 2)", 12, null]) {
    assert.equal(parseThemeColour(bad), null, String(bad));
  }
});

test("absent / empty file: nothing applied, nothing said", () => {
  assert.deepEqual(cleanThemeOverlay(undefined), { overlay: {}, notes: [] });
  assert.deepEqual(cleanThemeOverlay({}), { overlay: {}, notes: [] });
  assert.ok(themeOverlayEmpty(cleanThemeOverlay({}).overlay));
  assert.equal(themeOverlayCss({}), "");
});

test("a broken file is ignored whole, with the reason", () => {
  assert.match(parseThemeOverlay("{nope").error, /not valid JSON/);
  assert.match(parseThemeOverlay("[1]").error, /object/);
});

test("known tokens are kept (with or without --), unknown ones dropped with a note", () => {
  const { overlay, notes } = cleanThemeOverlay({
    colors: { dark: { "--panel": "#111", accent: "rgb(255 0 0)", "--nope": "#fff", "--fg": "red" }, sepia: {} },
    "// comment": "kept out of the notes",
  });
  assert.deepEqual(overlay.colors, { dark: { "--panel": "#111111", "--accent": "#ff0000" } });
  assert.equal(notes.length, 3);
  assert.ok(notes.some((n) => /--nope.*not a colour token/.test(n)));
  assert.ok(notes.some((n) => /--fg.*not a colour/.test(n)));
  assert.ok(notes.some((n) => /colors\.sepia/.test(n)));
});

test("--term-bg is the terminal's, and a hue with derived tints must be opaque", () => {
  const { overlay, notes } = cleanThemeOverlay({ colors: { light: { "--term-bg": "#fff", "--accent": "#ff000080" } } });
  assert.equal(overlay.colors, undefined);
  assert.ok(notes.some((n) => /terminal\.light\.background/.test(n)));
  assert.ok(notes.some((n) => /opaque/.test(n)));
});

test("displayName: trimmed, bounded, printable", () => {
  assert.equal(cleanThemeOverlay({ displayName: "  acme  " }).overlay.displayName, "acme");
  for (const bad of ["", "   ", "x".repeat(41), "a\nb", 7]) {
    const r = cleanThemeOverlay({ displayName: bad });
    assert.equal(r.overlay.displayName, undefined);
    assert.equal(r.notes.length, 1);
  }
});

test("terminal: merged over TERM_COLORS, identity kept when nothing is overridden", () => {
  assert.equal(termColorsFor("dark", null), TERM_COLORS.dark);
  assert.equal(termColorsFor("light", {}), TERM_COLORS.light);
  const { overlay, notes } = cleanThemeOverlay({ terminal: { dark: { background: "#123", cursor: "#fff" }, light: { foreground: "rgba(0,0,0,.5)" } } });
  assert.deepEqual(termColorsFor("dark", overlay), { background: "#112233", foreground: TERM_COLORS.dark.foreground });
  assert.equal(termColorsFor("light", overlay), TERM_COLORS.light);
  assert.equal(notes.length, 2);
});

test("the stylesheet: re-serialised values, rgb triples for derived hues, --term-bg from the terminal", () => {
  const { overlay } = cleanThemeOverlay({
    colors: { dark: { "--bg": "#000", "--accent": "#ff7a00", "--hover": "rgba(255,255,255,.1)" }, light: { "--bg": "hsl(0 0% 100%)" } },
    terminal: { dark: { background: "#101214" } },
  });
  const css = themeOverlayCss(overlay);
  assert.equal(css,
    'html:not([data-theme="light"]) { --bg: #000000; --accent-rgb: 255 122 0; --hover: rgb(255 255 255 / 0.1); --term-bg: #101214; }\n' +
    'html[data-theme="light"] { --bg: #ffffff; }');
  assert.equal(overlayChromeBg("dark", overlay), "#000000");
  assert.equal(overlayChromeBg("light", null), null);
  assert.equal(describeThemeOverlay({ displayName: "x", ...overlay }), 'name "x", 4 colours, terminal dark');
});

test("a hand-made overlay with an injected value adds nothing for it", () => {
  const css = themeOverlayCss({ colors: { dark: { "--bg": "#000; } * { display: none", "--evil": "#fff" } } });
  assert.equal(css, "");
});
