#!/usr/bin/env node
// Generates every logo output from the SVGs in brand/. See brand/README.md.
//   npm run brand:assets            regenerate when inputs changed (no-op otherwise)
//   npm run brand:assets -- --force regenerate regardless
// Rasteriser: @resvg/resvg-js (a root devDependency; no ImageMagick or system tools needed).
// The generator never reads a PNG as input. It records outputs + input hash in brand/outputs.json.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = path.join(ROOT, "brand");
const WEB = "packages/web/public/assets";
const RES = "packages/app/android/app/src/main/res";
const INPUTS = [
  "icon.svg", "icon-small.svg", "icon-light.svg", "icon-mono.svg",
  "android-foreground.svg", "android-background.svg", "android-monochrome.svg", "hero.svg", "brand.json",
];

const sha = (b) => createHash("sha256").update(b).digest("hex");
const readIn = (n) => fs.readFileSync(path.join(BRAND, n), "utf8");

export function inputsHash() {
  const h = createHash("sha256");
  for (const n of INPUTS) h.update(n).update(fs.readFileSync(path.join(BRAND, n)));
  return h.digest("hex");
}

const conf = JSON.parse(readIn("brand.json"));
const { night, foam } = conf.palette;
const CUT = conf.smallCutPx;

let Resvg;
async function loadResvg() {
  try { ({ Resvg } = await import("@resvg/resvg-js")); }
  catch {
    console.error("brand-assets: @resvg/resvg-js is missing. Run `npm install` (it is a root devDependency).");
    process.exit(2);
  }
}

const png = (svg, w) => Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: w } }).render().asPng());
const body = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const wrap = (w, h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${inner}</svg>`;
// Place a 512- or 108-unit artwork inside a larger canvas.
const place = (svg, vb, x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}">${body(svg)}</svg>`;
const solid = (w, h, c) => `<rect width="${w}" height="${h}" fill="${c}"/>`;
const markFor = (px) => (px < CUT ? readIn("icon-small.svg") : readIn("icon.svg"));

const out = new Map(); // repo-relative path -> Buffer | string
const put = (p, data) => out.set(p, data);

function webOutputs() {
  const icon = readIn("icon.svg");
  const mono = readIn("icon-mono.svg");
  // Theme-aware favicon: Night strokes on light tabs, Foam on dark tabs.
  const themed = mono
    .replaceAll(foam, "currentColor")
    .replace(/(<svg[^>]*>)/, `$1<style>svg{color:${night}}@media (prefers-color-scheme:dark){svg{color:${foam}}}</style>`);
  put(`${WEB}/icon.svg`, themed);
  put(`${WEB}/icon-dark.svg`, icon);
  put(`${WEB}/icon-light.svg`, readIn("icon-light.svg"));
  for (const s of [32, 48]) put(`${WEB}/icon-${s}.png`, png(markFor(s), s));
  for (const s of [192, 512]) put(`${WEB}/icon-${s}.png`, png(markFor(s), s));
  // iOS rounds the corners itself: full-bleed art on Night.
  put(`${WEB}/apple-touch-icon.png`, png(wrap(512, 512, solid(512, 512, night) + place(icon.replace('rx="114"', 'rx="0"'), 512, 0, 0, 512)), 180));
  // Maskable: the adaptive layers (designed for the 66 dp safe zone), full-bleed.
  put(`${WEB}/icon-512-maskable.png`, png(wrap(108, 108, place(readIn("android-background.svg"), 108, 0, 0, 108) + place(readIn("android-foreground.svg"), 108, 0, 0, 108)), 512));
  put(`${WEB}/badge-96.png`, png(mono.replaceAll(foam, "#FFFFFF"), 96));
  put(`${WEB}/hero.png`, png(readIn("hero.svg"), 1600));
}

function androidOutputs() {
  const density = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  const fg = readIn("android-foreground.svg");
  for (const [d, k] of Object.entries(density)) {
    const px = Math.round(48 * k);
    const mark = markFor(px);
    put(`${RES}/mipmap-${d}/ic_launcher.png`, png(mark, px));
    const round = wrap(512, 512, `<clipPath id="rc"><circle cx="256" cy="256" r="256"/></clipPath><g clip-path="url(#rc)">${place(mark, 512, 0, 0, 512)}</g>`);
    put(`${RES}/mipmap-${d}/ic_launcher_round.png`, png(round, px));
    put(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, png(fg, Math.round(108 * k)));
    // Notification glyph: white silhouette, no waterline (it turns to mush at 24 dp), cropped to the mark.
    const stat = readIn("icon-mono.svg")
      .replaceAll(foam, "#FFFFFF")
      .replace(/\s*<path d="M40,352[^>]*\/>/, "")
      .replace(/viewBox="[^"]*"/, 'viewBox="16 -9 480 480"');
    put(`${RES}/drawable-${d}/ic_stat_app.png`, png(stat, Math.round(24 * k)));
  }
  put(`${RES}/drawable/ic_launcher_background.xml`, backgroundVector(readIn("android-background.svg")));
  put(`${RES}/drawable/ic_launcher_monochrome.xml`, svgToVector(readIn("android-monochrome.svg")));
  put(`${RES}/values/ic_launcher_background.xml`,
    `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by scripts/brand-assets.mjs from brand/. Night; the plate itself is drawable/ic_launcher_background.xml. -->\n<resources>\n    <color name="ic_launcher_background">${night.toUpperCase()}</color>\n</resources>\n`);
  const adaptive = (cls) => `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by scripts/brand-assets.mjs. -->\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@drawable/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n`;
  put(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive());
  put(`${RES}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive());
  // Splash: the master mark centred on Night, sizes as Capacitor expects.
  const splash = {
    "drawable": [480, 320],
    "drawable-land-mdpi": [480, 320], "drawable-land-hdpi": [800, 480], "drawable-land-xhdpi": [1280, 720],
    "drawable-land-xxhdpi": [1600, 960], "drawable-land-xxxhdpi": [1920, 1280],
    "drawable-port-mdpi": [320, 480], "drawable-port-hdpi": [480, 800], "drawable-port-xhdpi": [720, 1280],
    "drawable-port-xxhdpi": [960, 1600], "drawable-port-xxxhdpi": [1280, 1920],
  };
  for (const [dir, [w, h]] of Object.entries(splash)) {
    const m = Math.round(Math.min(w, h) * 0.34);
    put(`${RES}/${dir}/splash.png`, png(wrap(w, h, solid(w, h, night) + place(readIn("icon.svg"), 512, Math.round((w - m) / 2), Math.round((h - m) / 2), m)), w));
  }
}

function docsOutputs() {
  put("docs/assets/hero.svg", readIn("hero.svg"));
  put("docs/assets/icon-light.svg", readIn("icon-light.svg"));
  // VS Code Marketplace listing: transparent outside the rounded square (the panel is dark or light).
  put("packages/vscode/icon.png", png(readIn("icon.svg"), 256));
}

// ---- SVG -> Android VectorDrawable (the small element set the layers use) ----
const num = (n) => String(Math.round(n * 1e4) / 1e4);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const argb = (c, a = 1) => {
  const hex = c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
  return "#" + Math.round(a * 255).toString(16).padStart(2, "0").toUpperCase() + hex.slice(1).toUpperCase();
};

function backgroundVector(svg) {
  const stops = [...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)];
  const items = stops.map(([, o, c]) => `                <item android:color="${argb(c)}" android:offset="${o.startsWith(".") ? "0" + o : o}"/>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/brand-assets.mjs from brand/android-background.svg. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient android:type="linear" android:startX="0" android:startY="0" android:endX="0" android:endY="108">
${items}
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;
}

// Parse a transform chain of translate/scale/rotate into VectorDrawable <group> attributes.
function groupAttrs(t) {
  const ops = [...t.matchAll(/(translate|scale|rotate)\(([^)]*)\)/g)].map((m) => [m[1], m[2].trim().split(/[\s,]+/).map(Number)]);
  if (ops.length === 1 && ops[0][0] === "rotate") {
    const [a, cx = 0, cy = 0] = ops[0][1];
    return `android:rotation="${num(a)}" android:pivotX="${num(cx)}" android:pivotY="${num(cy)}"`;
  }
  // SVG applies the rightmost op first, so fold right-to-left into x' = s*x + e (uniform scale only).
  let s = 1, e = 0, f = 0;
  for (const [op, v] of [...ops].reverse()) {
    if (op === "scale") { s *= v[0]; e *= v[0]; f *= v[0]; }
    else { e += v[0]; f += v[1] ?? 0; }
  }
  return `android:scaleX="${num(s)}" android:scaleY="${num(s)}" android:pivotX="0" android:pivotY="0" android:translateX="${num(e)}" android:translateY="${num(f)}"`;
}

function rectPath(x, y, w, h, r) {
  return `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
}

function svgToVector(svg) {
  const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  const lines = [];
  let depth = 1;
  const pad = () => "    ".repeat(depth);
  for (const m of body(svg).matchAll(/<(\/?)(g|path|rect)\b([^>]*)>/g)) {
    const [, close, tag, rest] = m;
    const el = `<${tag}${rest}`;
    if (tag === "g") {
      if (close) { depth--; lines.push(`${pad()}</group>`); }
      else { lines.push(`${pad()}<group ${groupAttrs(attr(el, "transform") ?? "")}>`); depth++; }
    } else if (!close && (tag === "path" || tag === "rect")) {
      const d = tag === "path" ? attr(el, "d") : rectPath(+attr(el, "x"), +attr(el, "y"), +attr(el, "width"), +attr(el, "height"), +(attr(el, "rx") ?? 0));
      const op = +(attr(el, "opacity") ?? 1);
      const fill = attr(el, "fill"), stroke = attr(el, "stroke");
      const a = [`android:pathData="${d}"`];
      if (fill && fill !== "none") a.push(`android:fillColor="${argb(fill, op)}"`);
      if (stroke) {
        a.push(`android:strokeColor="${argb(stroke, op)}"`, `android:strokeWidth="${attr(el, "stroke-width")}"`,
          `android:strokeLineCap="${attr(el, "stroke-linecap") ?? "butt"}"`, `android:strokeLineJoin="${attr(el, "stroke-linejoin") ?? "miter"}"`);
      }
      lines.push(`${pad()}<path ${a.join(" ")}/>`);
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/brand-assets.mjs from brand/android-monochrome.svg (Android 13 themed icon). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="${vb[1]}"
    android:viewportHeight="${vb[2]}">
${lines.join("\n")}
</vector>
`;
}

// ---- main ----
async function main() {
  const manifestPath = path.join(BRAND, "outputs.json");
  const generator = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
  const inputs = inputsHash();
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  if (!process.argv.includes("--force") && prev && prev.inputs === inputs && prev.generator === generator &&
      prev.outputs.every((p) => fs.existsSync(path.join(ROOT, p)))) {
    console.log(`brand-assets: up to date (${prev.outputs.length} outputs)`);
    return;
  }
  await loadResvg();
  webOutputs(); androidOutputs(); docsOutputs();
  let changed = 0;
  for (const [p, data] of out) {
    const abs = path.join(ROOT, p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (fs.existsSync(abs) && fs.readFileSync(abs).equals(buf)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    changed++;
  }
  const manifest = { inputs, generator, outputs: [...out.keys()].sort() };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`brand-assets: ${out.size} outputs, ${changed} written`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
