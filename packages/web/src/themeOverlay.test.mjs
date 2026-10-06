/**
 * A fork's theme overlay on the phone (`themeOverlay.ts`): the token list is
 * the stylesheet's, an overlay paints one style element and caches itself, an
 * empty one leaves nothing behind, and the terminal palette follows it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, TERM_COLORS, THEME_RGB_TOKENS, THEME_TOKENS } from "@waterplane/shared";

// ── a document and a localStorage, just enough ─────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const els = new Map();
globalThis.document = {
  title: "",
  getElementById: (id) => els.get(id) ?? null,
  createElement: () => {
    const el = { id: "", textContent: "", remove() { els.delete(el.id); } };
    return el;
  },
  head: { appendChild: (el) => { els.set(el.id, el); } },
};

const { LS } = await import("./storage.ts");
const { appName, applyCachedThemeOverlay, onThemeOverlay, refreshThemeOverlay, setDocTitle, setThemeOverlay, themeOverlay } = await import("./themeOverlay.ts");
const { termTheme } = await import("./termTheme.ts");

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
function tokensOf(selector) {
  const at = CSS.indexOf(selector + " {");
  const body = CSS.slice(at + selector.length + 2, CSS.indexOf("\n}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
}

test("THEME_TOKENS is every colour token on :root — no more, no fewer", () => {
  const root = tokensOf(':root, [data-theme="dark"]');
  const NOT_COLOURS = new Set(["--term-bg", "--repo-sat", "--repo-lit"]);
  const expect = root.filter((t) => !t.endsWith("-rgb") && !NOT_COLOURS.has(t));
  assert.deepEqual([...THEME_TOKENS].sort(), [...new Set(expect)].sort());
  for (const t of THEME_RGB_TOKENS) assert.ok(root.includes(`${t}-rgb`), `${t}-rgb is declared, so ${t} is overridden through it`);
});

test("no overlay: no element, no key, the brand's own name", () => {
  applyCachedThemeOverlay();
  assert.equal(els.size, 0);
  assert.equal(store.size, 0);
  assert.equal(appName(), BRAND.name);
  assert.equal(termTheme("dark").background, TERM_COLORS.dark.background);
  setDocTitle("myrepo");
  assert.equal(document.title, `myrepo — ${BRAND.name}`);
});

test("an overlay paints one style, caches itself, renames, and moves the terminal", async () => {
  let fired = 0;
  const off = onThemeOverlay(() => { fired++; });
  await refreshThemeOverlay(async (url) => {
    assert.equal(url, "/api/theme");
    return { overlay: { displayName: "acme", colors: { dark: { "--bg": "#000" }, light: { "--evil": "#fff" } }, terminal: { light: { background: "#fafafa" } } } };
  });
  assert.equal(fired, 1);
  assert.equal(appName(), "acme");
  assert.equal(document.title, "myrepo — acme");
  const css = els.get("theme-overlay").textContent;
  assert.match(css, /--bg: #000000;/);
  assert.match(css, /html\[data-theme="light"\] \{ --term-bg: #fafafa; \}/);
  assert.doesNotMatch(css, /evil/);
  assert.equal(store.get(LS.themeOverlayCss), css);
  assert.deepEqual(JSON.parse(store.get(LS.themeOverlay)), themeOverlay());
  const lt = termTheme("light");
  assert.equal(lt.background, "#fafafa");
  assert.equal(lt.cursorAccent, "#fafafa");
  assert.equal(lt.red, "#cf222e", "the ANSI colours are untouched");
  assert.equal(termTheme("dark").background, TERM_COLORS.dark.background);

  // The same answer again changes nothing and says nothing.
  assert.equal(setThemeOverlay(themeOverlay()), false);
  assert.equal(fired, 1);

  // Offline (null) keeps it; a host that stopped serving one clears it, keys and all.
  await refreshThemeOverlay(async () => null);
  assert.equal(appName(), "acme");
  await refreshThemeOverlay(async () => { throw new Error("tunnel down"); });
  assert.equal(appName(), "acme");
  await refreshThemeOverlay(async () => ({ overlay: {} }));
  assert.equal(appName(), BRAND.name);
  assert.equal(els.size, 0);
  assert.equal(store.size, 0);
  assert.equal(fired, 2);
  off();
});

test("the cache is applied at boot without writing it back", () => {
  store.set(LS.themeOverlay, JSON.stringify({ displayName: "cached", colors: { dark: { "--accent": "#ff7a00" } } }));
  applyCachedThemeOverlay();
  assert.equal(appName(), "cached");
  assert.match(els.get("theme-overlay").textContent, /--accent-rgb: 255 122 0;/);
  assert.equal(store.has(LS.themeOverlayCss), false, "boot reads the cache; only a host answer writes it");
  setThemeOverlay({});
});
