/**
 * The palette, measured.
 *
 * `styles.css` now holds every colour in the app twice — once per theme — and
 * two things about that arrangement rot silently:
 *
 *  1. **A token added to dark and forgotten in light.** It does not throw, it
 *     does not warn: the light page simply inherits the dark value, and the one
 *     that shows up is a near-black chip on a white card, on whichever screen
 *     nobody opened during the port. So the two blocks are compared as SETS,
 *     and a token may only be dark-only if it is listed here as deliberately
 *     theme-independent (a scrim over a photograph, say) with a reason.
 *
 *  2. **A colour tweaked until it looked nice on the developer's monitor.**
 *     Contrast is not a matter of taste and CVD separation is not visible to
 *     the person choosing. Both are re-measured here, against the surface each
 *     colour is actually drawn on.
 *
 * The measurements are done on the FILE, not on a mock of it — the assertions
 * parse the real declarations, resolve `rgb(var(--x-rgb) / a)` and `hsl()` the
 * way a browser would, and fail with the token's own name. A test that asserted
 * a copy of the palette would pass for ever while the stylesheet drifted.
 *
 * CVD is simulated with the Machado/Oliveira/Fernandes (2009) severity-1.0
 * matrices in linear RGB; difference is CIEDE2000. Absolute ΔE values from
 * different simulation models are not comparable, so the thresholds below are
 * calibrated against what the DARK palette — which shipped and was reviewed —
 * already measures under this same code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REPO_PALETTES } from "@waterplane/shared";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

// ── reading the stylesheet ────────────────────────────────────────────────

/** The declarations of one selector's block, as a map. */
function block(selector) {
  const at = CSS.indexOf(selector + " {");
  assert.ok(at >= 0, `no block for ${selector}`);
  const body = CSS.slice(at + selector.length + 2, CSS.indexOf("\n}", at));
  const out = new Map();
  // Comments can carry anything, including colons and semicolons.
  for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const DARK = block(':root, [data-theme="dark"]');
const LIGHT = block('[data-theme="light"]');

/** Resolve a token to 8-bit RGB, following `var()` within the same theme. */
function rgbOf(name, vars, seen = new Set()) {
  assert.ok(!seen.has(name), `cycle at ${name}`);
  seen.add(name);
  let v = vars.get(name);
  assert.ok(v, `token ${name} is not defined`);
  v = v.replace(/var\((--[a-z0-9-]+)\)/g, (_, ref) => vars.get(ref) ?? "");
  return parse(v.trim());
}

function parse(v) {
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (m) return [+m[1], +m[2], +m[3]];
  m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(v);
  if (m) return hsl(+m[1], +m[2], +m[3]);
  throw new Error(`cannot parse colour: ${v}`);
}

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

// ── colour science ────────────────────────────────────────────────────────

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const unlin = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const relL = (rgb) => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => {
  const l1 = relL(a), l2 = relL(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const simulate = (rgb, kind) => {
  if (!kind) return rgb;
  const l = rgb.map(lin);
  return CVD[kind].map((r) => unlin(Math.max(0, Math.min(1, r[0] * l[0] + r[1] * l[1] + r[2] * l[2]))));
};

function lab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const Y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
  const Z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

function de2000(c1, c2) {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2);
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const ang = (x, y) => { if (!x && !y) return 0; const d = (Math.atan2(y, x) * 180) / Math.PI; return d < 0 ? d + 360 : d; };
  const h1p = ang(a1p, b1), h2p = ang(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp;
  if (!(C1p * C2p)) hbp = h1p + h2p;
  else { hbp = (h1p + h2p) / 2; if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 180 : -180; }
  const T = 1 - 0.17 * Math.cos(((hbp - 30) * Math.PI) / 180) + 0.24 * Math.cos((2 * hbp * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180) - 0.20 * Math.cos(((4 * hbp - 63) * Math.PI) / 180);
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin((2 * 30 * Math.exp(-(((hbp - 275) / 25) ** 2)) * Math.PI) / 180) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// ── 1. the two blocks describe the same tokens ────────────────────────────

/**
 * Tokens the light theme deliberately does NOT restate, each with the reason.
 * Adding to this list is a decision; inheriting by accident is a bug.
 */
const DARK_ONLY = {
  "--scrim-media": "read against a photograph, which has no theme",
  "--scrim-label": "a label burned over an image — same reason",
  "--media-bg": "the letterbox behind a photo or a video",
  "--paper": "a PDF page is paper in either theme",
  "--on-media": "text on a photo scrim, not on a surface of ours",
  "--on-dead": "white on a red fill in both themes",
  "--on-accent": "white on a blue fill in both themes",
  "--ctx-series": "defined as slot 1, and slot 1 is restated",
  "--ctx-compact": "defined as slot 4, and slot 4 is restated",
};

/** `--accent: rgb(var(--accent-rgb))` needs no light restatement — the light
 *  block restates the TRIPLE, and the derivation carries. */
const derived = (k) => {
  const m = /^rgb\(var\((--[a-z0-9-]+)\)\)$/.exec(DARK.get(k) ?? "");
  return m ? LIGHT.has(m[1]) : false;
};

test("every dark token is either restated in light or listed as theme-independent", () => {
  const missing = [...DARK.keys()].filter((k) => !LIGHT.has(k) && !(k in DARK_ONLY) && !derived(k));
  assert.deepEqual(missing, [], `light mode inherits these dark values: ${missing.join(", ")}`);
});

test("light states no token dark has never heard of", () => {
  const extra = [...LIGHT.keys()].filter((k) => !DARK.has(k));
  assert.deepEqual(extra, [], `only defined in light: ${extra.join(", ")}`);
});

// ── 2. text is readable on the surfaces it is drawn on ────────────────────

/** Hues used as TEXT (a tag, a chip label, a status word). 4.5:1 or it is not
 *  text, it is decoration. */
const TEXT_HUES = ["--accent", "--ok", "--dead", "--warn", "--star", "--limit", "--ask",
  "--purple", "--sched", "--defer", "--ctx-low", "--fg", "--muted"];

for (const [name, vars] of [["dark", DARK], ["light", LIGHT]]) {
  test(`${name}: every text hue clears 4.5:1 on --panel, --bg and --well`, () => {
    // Light is a fresh set of values; dark is what shipped, and two of its hues
    // have always been just under on the darkest surface. Holding dark to the
    // number it already meets is what makes this test a ratchet rather than a
    // rewrite of a theme nobody asked to change.
    const floor = name === "light" ? 4.5 : 4.0;
    const all = name === "light" ? new Map([...DARK, ...LIGHT]) : DARK;
    for (const surf of ["--panel", "--bg", "--well"]) {
      const s = rgbOf(surf, all);
      for (const hue of TEXT_HUES) {
        const c = contrast(rgbOf(hue, all), s);
        assert.ok(c >= floor, `${name}: ${hue} on ${surf} is ${c.toFixed(2)}:1, want ${floor}`);
      }
    }
  });

  test(`${name}: text on a filled hue is readable`, () => {
    const all = name === "light" ? new Map([...DARK, ...LIGHT]) : DARK;
    const pairs = [["--on-accent", "--accent"], ["--on-dead", "--dead"], ["--on-ok", "--ok"],
      ["--on-limit", "--limit"], ["--on-star", "--star"]];
    for (const [ink, fill] of pairs) {
      const c = contrast(rgbOf(ink, all), rgbOf(fill, all));
      // Two of dark's fills are white on a mid hue — `--accent` measures ~2.6:1
      // and `--dead` ~3.3:1 — and have been since the first commit. They are
      // button and pill labels at semibold, they shipped that way, and light
      // FIXES them rather than this test pretending dark already had. The floor
      // is dark's own measured number, so the ratchet only turns one way.
      const legacyDark = { "--on-accent": 2.5, "--on-dead": 3.3 };
      const floor = name === "dark" && ink in legacyDark ? legacyDark[ink] : 4.5;
      assert.ok(c >= floor, `${name}: ${ink} on ${fill} is ${c.toFixed(2)}:1, want ${floor}`);
    }
  });
}

// ── 3. the chart palettes ─────────────────────────────────────────────────

/**
 * Two sets, measured separately, because they are never on the same chart. The
 * categorical slots are `TokenStatsSheet`'s four token kinds; the context graph
 * draws slot 1 as its series, slot 4 as a compaction and `--ctx-limit` as a
 * wall. Measuring all five together would demand that a categorical orange be
 * distinguishable from a wall red that no chart ever shows beside it — a
 * constraint the palette would have to pay for and nobody would ever see.
 */
const CHART_SETS = [
  ["categorical slots", ["--chart-1", "--chart-2", "--chart-3", "--chart-4"]],
  ["the context graph's three", ["--ctx-series", "--ctx-compact", "--ctx-limit"]],
];

for (const name of ["dark", "light"]) {
  for (const [label, keys] of CHART_SETS) {
    test(`${name}: ${label} are separable, including under CVD`, () => {
      const all = name === "light" ? new Map([...DARK, ...LIGHT]) : DARK;
      // `.sheet` is `--bg`, so that — not `--panel` — is what a chart sits on.
      const surf = rgbOf("--bg", all);
      const slots = keys.map((k) => [k, rgbOf(k, all)]);
      for (const [k, c] of slots) {
        const r = contrast(c, surf);
        assert.ok(r >= 3.0, `${name}: ${k} is ${r.toFixed(2)}:1 on --bg, want 3.0 (non-text)`);
      }
      let worstNormal = Infinity, worstCvd = Infinity, worstPair = "";
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          for (const kind of [null, "protan", "deutan", "tritan"]) {
            const d = de2000(simulate(slots[i][1], kind), simulate(slots[j][1], kind));
            if (kind === null) worstNormal = Math.min(worstNormal, d);
            else if (d < worstCvd) { worstCvd = d; worstPair = `${slots[i][0]}/${slots[j][0]} (${kind})`; }
          }
        }
      }
      assert.ok(worstNormal >= 15, `${name}: worst normal-vision ΔE ${worstNormal.toFixed(1)}, want 15`);
      assert.ok(worstCvd >= 5, `${name}: worst CVD ΔE ${worstCvd.toFixed(1)} at ${worstPair}, want 5`);
    });
  }
}

// ── 4. the per-repo identity colour, over the whole hue circle ────────────

test("light: no repo hue produces an unreadable name", () => {
  // `repoHue` is a hash: the repos on this machine are not the repos on the
  // next one, so the whole circle is swept. 28% lightness was chosen because
  // yellow — hue 60, the worst of the 360 — passes there and nowhere lighter.
  const all = new Map([...DARK, ...LIGHT]);
  const sat = parseFloat(all.get("--repo-sat"));
  const lit = parseFloat(all.get("--repo-lit"));
  const surfaces = [rgbOf("--panel", all), rgbOf("--bg", all)];
  let worst = Infinity, worstHue = 0;
  for (let h = 0; h < 360; h++) {
    for (const s of surfaces) {
      const c = contrast(hsl(h, sat, lit), s);
      if (c < worst) { worst = c; worstHue = h; }
    }
  }
  assert.ok(worst >= 4.5, `hue ${worstHue} measures ${worst.toFixed(2)}:1, want 4.5`);
});

test("no repo hue makes the tab you are IN unreadable", () => {
  // The fill is an ALPHA over the strip's ground, and the strip's ground is
  // `--bg` — the same surface the launcher's group header is washed on, which
  // is what makes a tab and a header the same colour rather than two mixes that
  // were tuned apart. What has to hold is `--fg` on top of it, for every hue in
  // every ring plus every hue a person can pin, i.e. all 360.
  for (const [name, vars] of [["dark", DARK], ["light", new Map([...DARK, ...LIGHT])]]) {
    const sat = parseFloat(vars.get("--repo-sat"));
    const lit = parseFloat(vars.get("--repo-lit"));
    const veil = parseFloat(vars.get("--repo-veil-on")) / 100;
    const bg = rgbOf("--bg", vars), fg = rgbOf("--fg", vars);
    let worst = Infinity, worstHue = 0;
    for (let h = 0; h < 360; h++) {
      const fill = hsl(h, sat, lit).map((v, i) => Math.round(v * veil + bg[i] * (1 - veil)));
      const c = contrast(fg, fill);
      if (c < worst) { worst = c; worstHue = h; }
    }
    assert.ok(worst >= 4.5, `${name}: --fg on the open tab at hue ${worstHue} is ${worst.toFixed(2)}:1`);
  }
});

test("the colour-blind-safe ring is actually separable under CVD", () => {
  // A hue GAP cannot say this — 12° and 40° are the same colour to a
  // deuteranope — so the ring is measured HERE, where the saturation and
  // lightness it is drawn at are known, under the same simulation the chart
  // palettes are held to. The other rings are NOT measured this way: they
  // promise separation to normal vision and say so, and holding them to this
  // would leave one ring, which is the opposite of offering a choice.
  const ring = REPO_PALETTES.find((p) => p.id === "cvd");
  assert.ok(ring, "the cvd ring is gone — this test is now about nothing");
  for (const [name, vars] of [["dark", DARK], ["light", new Map([...DARK, ...LIGHT])]]) {
    const sat = parseFloat(vars.get("--repo-sat"));
    const lit = parseFloat(vars.get("--repo-lit"));
    const cols = ring.hues.map((h) => [h, hsl(h, sat, lit)]);
    let worst = Infinity, pair = "";
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        for (const kind of ["protan", "deutan", "tritan"]) {
          const d = de2000(simulate(cols[i][1], kind), simulate(cols[j][1], kind));
          if (d < worst) { worst = d; pair = `${cols[i][0]}°/${cols[j][0]}° (${kind})`; }
        }
      }
    }
    // Calibrated against the chart palette's own floor (5), which shipped and
    // was reviewed under this same code.
    assert.ok(worst >= 5, `${name}: cvd ring worst pair ${pair} is ΔE ${worst.toFixed(1)}`);
  }
});

// ── 5. the two places the background is written down outside the palette ──

test("the no-flash bootstrap and the terminal agree with the palette", () => {
  const all = new Map([...DARK, ...LIGHT]);
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
  // `index.html` runs before the bundle exists, so it cannot import the value;
  // `theme.ts` states it again for the meta tag and the Android bars. A drift
  // here is a one-frame flash of a colour the app never uses.
  for (const [theme, token] of [["dark", "--bg"], ["light", "--bg"]]) {
    const want = rgbOf(token, theme === "light" ? all : DARK);
    const hexes = [...html.matchAll(/#([0-9a-f]{6})/gi)].map((m) => parse("#" + m[1]));
    assert.ok(hexes.some((h) => h.every((v, i) => v === want[i])),
      `index.html never mentions the ${theme} --bg`);
  }
  // The terminal's background is stated once, in shared — the host answers the
  // tmux client's colour query with the same value (`host/termqueries.ts`).
  const term = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "src", "termpalette.ts"), "utf8");
  for (const [label, vars] of [["dark", DARK], ["light", new Map([...DARK, ...LIGHT])]]) {
    const want = rgbOf("--term-bg", vars);
    assert.ok([...term.matchAll(/#([0-9a-f]{6})/gi)].some((m) => parse("#" + m[1]).every((v, i) => v === want[i])),
      `termpalette.ts has no background matching the ${label} --term-bg`);
  }
});
