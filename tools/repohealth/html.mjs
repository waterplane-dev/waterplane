/**
 * The classics: the four magnitude-feel numbers, drawn.
 *
 * ── Why this exists at all, when `narrate.mjs` exists ──────────────────────
 *
 * The narrative answers "what moved". It deliberately cannot answer "how big
 * is this repo now" — a sentence about a delta is the wrong shape for a
 * magnitude, and printing every magnitude every day is the dashboard the
 * narrative refuses to be. But the magnitudes are the four numbers the author
 * explicitly asked to keep a feel for: lines per file, how many files, lines
 * per package, how many dependencies. A shape answers those in one glance and
 * a sentence never does.
 *
 * ── Why it is a subcommand and never part of `update` ──────────────────────
 *
 * `update` runs often and must stay silent on a quiet day — that is the whole
 * contract of `.claude/outbox/repohealth.md`, and the outbox is what the
 * phone's gallery watches. A page regenerated on every commit would put a
 * fresh mtime in that gallery daily, which is a notification, which is exactly
 * the noise the silence rule buys. So `.claude/outbox/repohealth.html` is
 * written when, and only when, a person runs `html` and is therefore about to
 * look at it.
 *
 * ── The chart rules, and where they came from ──────────────────────────────
 *
 * Built against the `dataviz` skill; the non-obvious parts are here so the
 * next reader does not re-litigate them:
 *
 *  • **The tape is one colour.** Every bar is categorical slot 1. Shading each
 *    bar darker-where-longer would double-encode length as hue, which burns
 *    the only free channel on information the bar already carries.
 *  • **Four package hues, in fixed slot order, never cycled.** Slots 1–4
 *    (blue, orange, aqua, yellow) were run through the skill's validator
 *    against both surfaces: worst adjacent CVD ΔE 9.1 light / 8.4 dark against
 *    a target of 8, normal-vision 22.9 / 19.8 against a floor of 15. A fifth
 *    package does NOT get a generated fifth hue — it folds into "other", which
 *    is why `packageSeries` caps and sums rather than extending the palette.
 *  • **The light-mode contrast WARN is answered, not dismissed.** Aqua (2.74)
 *    and yellow (2.11) sit under 3:1 on the light surface. The skill's relief
 *    rule then obliges visible labels or a table view, so this page ships
 *    three: an end-label on every line that has room for one, the latest value
 *    printed in the legend beside its swatch, and the whole series repeated as
 *    a table underneath. An end-label that would collide is DROPPED rather
 *    than nudged — see `linesSvg` — which is why the legend carries the
 *    numbers too and not only the names.
 *  • **One axis, always.** Lines per file and file count are different scales
 *    and get different cards. A second y-axis would invent a correlation.
 *  • **Text never wears the series colour.** Identity comes from the swatch
 *    beside the label. Aqua and yellow are illegible as text on white, which
 *    is the same measurement as the WARN above.
 *  • **Dark mode is selected, not flipped** — its own steps from the same
 *    hues, declared under both the media query and the `data-theme` scope so
 *    an explicit choice wins in both directions.
 *  • **Hover with no script.** Each plot carries invisible hit columns holding
 *    a `<title>`, so every point is inspectable through the browser's own
 *    tooltip and a CSS-only crosshair. A generated file that needs JS to be
 *    readable is a file that is unreadable the first time the JS is wrong.
 *
 * ── Costs nothing ──────────────────────────────────────────────────────────
 *
 * No model, no network, no subprocess: rows in, a string out. `judge.mjs` is
 * the only module in this tool permitted to spend a token.
 *
 * ── Reading `classics` defensively ─────────────────────────────────────────
 *
 * `classics` is typed `Measured<object>` — the contract deliberately does not
 * pin its keys. So every field is looked up through a list of plausible names
 * and a missing one produces a card that SAYS it is missing and why. It never
 * produces a zero: a zero and an absence are opposite claims, and a chart is
 * the easiest place in the world to draw the wrong one of them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tapeLines } from "./metrics/classics.mjs";

/** Named in full at every mention — a bare filename does not resolve on a phone. */
export const OUTBOX_HTML = ".claude/outbox/repohealth.html";

// ── small formatting ───────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function nf(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const neg = n < 0;
  const r = Math.round(Math.abs(n) * 100) / 100;
  const [int, frac] = String(r).split(".");
  return `${neg ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

const signed = (n) => (typeof n === "number" && Number.isFinite(n) ? `${n > 0 ? "+" : ""}${nf(n)}` : "—");

// ── reading the rows ───────────────────────────────────────────────────────

const pick = (obj, names) => {
  if (!obj || typeof obj !== "object") return null;
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  return null;
};

const CLASSIC = Object.freeze({
  files: ["files", "fileCount", "srcFiles", "nFiles"],
  loc: ["loc", "totalLoc", "lines", "totalLines"],
  deps: ["deps", "depCount", "dependencies", "declaredDeps"],
  packages: ["locByPackage", "perPackageLoc", "packages", "pkgLoc"],
});

const classicsOf = (row) => (row?.classics && row.classics.value) || null;

/** `{web: 1234}` and `[{pkg: "web", loc: 1234}]` are the same thing here. */
function packageMap(raw) {
  const out = new Map();
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const k = e?.pkg ?? e?.name ?? e?.package;
      const v = e?.loc ?? e?.lines ?? e?.value;
      if (typeof k === "string" && typeof v === "number") out.set(k, v);
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out.set(k, v);
  }
  return out;
}

/**
 * One numeric series over the day-rows, with the days that carry a value.
 * Days with no reading are DROPPED rather than zeroed — a gap in a line is
 * honest and a dip to zero is a lie the shape tells louder than any caption.
 */
function series(days, get) {
  const pts = [];
  for (const r of days) {
    const v = get(r);
    if (typeof v === "number" && Number.isFinite(v)) pts.push({ day: r.day, v });
  }
  return pts;
}

/**
 * The package lines, capped at the four validated slots.
 *
 * A fifth package is summed into "other" rather than given a generated hue:
 * past the validated order the next colour is indistinguishable from one
 * already on screen under CVD. The four kept are the four largest at the last
 * day, so the cap never hides the thing the chart is about.
 */
export function packageSeries(days, limit = 4) {
  const last = packageMap(pick(classicsOf(days[days.length - 1]), CLASSIC.packages));
  if (!last.size) return [];
  const ranked = [...last.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const kept = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  const out = kept.map((pkg) => ({
    name: pkg,
    points: series(days, (r) => packageMap(pick(classicsOf(r), CLASSIC.packages)).get(pkg) ?? null),
  }));
  if (rest.length) {
    out.push({
      name: `other (${nf(rest.length)})`,
      points: series(days, (r) => {
        const m = packageMap(pick(classicsOf(r), CLASSIC.packages));
        let t = 0;
        let any = false;
        for (const k of rest) if (typeof m.get(k) === "number") { t += m.get(k); any = true; }
        return any ? t : null;
      }),
    });
  }
  return out;
}

// ── svg ────────────────────────────────────────────────────────────────────

const W = 320;
const H = 72;
const PAD = 6;

function scale(points) {
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  // A flat series has no range to divide by; give it one so the line lands in
  // the middle of the box instead of on an edge or on a NaN.
  if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
  const n = points.length;
  const x = (i) => PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i * (W - 2 * PAD)) / (n - 1));
  const y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  return { x, y, lo, hi };
}

/**
 * Invisible hit columns carrying the native tooltip and a CSS-only crosshair.
 * The rect is the hit target and is deliberately far wider than the mark — a
 * 2px line is not a thing a thumb can point at.
 */
function hitColumns(points, x, label) {
  const n = points.length;
  const step = n > 1 ? (W - 2 * PAD) / (n - 1) : W;
  return points
    .map((p, i) => {
      const cx = x(i);
      return (
        `<g class="col">` +
        `<rect x="${(cx - step / 2).toFixed(1)}" y="0" width="${Math.max(step, 6).toFixed(1)}" height="${H}" fill="transparent"/>` +
        `<line class="rule" x1="${cx.toFixed(1)}" y1="${PAD}" x2="${cx.toFixed(1)}" y2="${H - PAD}"/>` +
        `<title>${esc(p.day)} · ${esc(label)} ${esc(nf(p.v))}</title>` +
        `</g>`
      );
    })
    .join("");
}

/** A single-series sparkline: 2px line, the current point ringed in surface. */
function sparkline(points, label) {
  if (points.length < 2) return `<p class="absent">A shape needs at least 2 days; this series has ${nf(points.length)}.</p>`;
  const { x, y } = scale(points);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = points[points.length - 1];
  return (
    `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}, ${nf(points.length)} days">` +
    `<path class="spark" d="${d}"/>` +
    `<circle class="head" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>` +
    hitColumns(points, x, label) +
    `</svg>`
  );
}

/**
 * The tape: the longest source files today, one bar each, shortest to longest.
 *
 * Sorted rather than alphabetical because the question is the SHAPE of the
 * distribution — where the mass sits and how long the tail is — and an
 * alphabetical tape is noise with the same total area. The p95 is marked in
 * ink, not colour, so the reference line never competes with the bars for
 * identity.
 *
 * Takes LINE COUNTS. It used to take the row's own `{path, loc}` objects and
 * do arithmetic on them — see `tapeLines`, which is why this signature is now
 * explicit about it.
 */
function tapeSvg(lines, marks) {
  const n = lines.length;
  if (!n) return "";
  const sorted = [...lines].sort((a, b) => a - b);
  const hi = sorted[n - 1] || 1;
  const bw = (W - 2 * PAD) / n;
  const bh = H * 1.4;
  const bars = sorted
    .map((v, i) => {
      const h = Math.max(1, (v / hi) * (bh - 2 * PAD));
      return `<rect x="${(PAD + i * bw).toFixed(2)}" y="${(bh - PAD - h).toFixed(2)}" width="${Math.max(bw - 0.4, 0.4).toFixed(2)}" height="${h.toFixed(2)}"/>`;
    })
    .join("");
  const ruleAt = (v, text) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return "";
    const idx = sorted.findIndex((s) => s >= v);
    // A value past the whole tape parks the rule at the right edge, which is
    // where it belongs — but it is not a measurement of this tape, so it is
    // not drawn at all rather than drawn somewhere defensible.
    if (idx < 0) return "";
    const cx = PAD + idx * bw;
    return (
      `<line class="mark" x1="${cx.toFixed(1)}" y1="0" x2="${cx.toFixed(1)}" y2="${bh}"/>` +
      `<text class="marklabel" x="${Math.min(cx + 4, W - 54).toFixed(1)}" y="12">${esc(text)}</text>`
    );
  };
  return (
    `<svg class="plot tape" viewBox="0 0 ${W} ${bh}" role="img" aria-label="Lines per file, the ${nf(n)} longest, sorted shortest to longest">` +
    `<g class="bars">${bars}</g>` +
    ruleAt(marks.p95, `p95 ${nf(marks.p95)}`) +
    `<title>${nf(n)} files` +
    (marks.p95 == null ? "" : ` · p95 ${nf(marks.p95)} lines over the whole tree`) +
    ` · longest ${nf(marks.max)}</title>` +
    `</svg>`
  );
}

/**
 * The one multi-series plot. Legend AND direct end-labels, both: the legend
 * because identity must never be colour-alone, the end-labels because two of
 * the four hues are under 3:1 on the light surface and the skill's relief rule
 * is not dismissable.
 */
function linesSvg(list) {
  const usable = list.filter((s) => s.points.length >= 2);
  if (usable.length < 1) return `<p class="absent">No package has 2 days of readings yet.</p>`;
  const all = usable.flatMap((s) => s.points);
  const { lo, hi } = scale(all);
  const days = [...new Set(all.map((p) => p.day))].sort();
  const lw = W + 96;
  const lh = 150;
  const x = (day) => PAD + (days.length === 1 ? 0 : (days.indexOf(day) * (W - 2 * PAD)) / (days.length - 1));
  const y = (v) => lh - 22 - ((v - lo) / (hi - lo)) * (lh - 40);
  /**
   * End-labels, minus the ones that would collide.
   *
   * Nudging colliding labels apart is the tempting fix and the wrong one: a
   * label moved off its line reads as noise and, worse, as a label for the
   * line it drifted towards. `packages/app` at 900 lines and a folded "other"
   * at 400 land within a pixel of each other on a scale whose top is 90,000,
   * which is exactly that case. So a label is drawn only when it clears the
   * one below it; the rest are carried by the legend, the hover tooltip and
   * the table — the skill's documented fallback, and the same three channels
   * the light-mode contrast relief already obliges.
   */
  const ends = usable
    .map((s, i) => ({ i, s, last: s.points[s.points.length - 1] }))
    .sort((p, q) => y(p.last.v) - y(q.last.v));
  let lastLabelY = -Infinity;
  const labelled = new Set();
  for (const e of ends) {
    const ly = y(e.last.v);
    if (ly - lastLabelY >= 11) { labelled.add(e.i); lastLabelY = ly; }
  }

  const paths = usable
    .map((s, i) => {
      const d = s.points.map((p, k) => `${k ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      const last = s.points[s.points.length - 1];
      return (
        `<path class="line s${i + 1}" d="${d}"><title>${esc(s.name)}</title></path>` +
        `<circle class="dot s${i + 1}" cx="${x(last.day).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/>` +
        (labelled.has(i)
          ? `<text class="endlabel" x="${(x(last.day) + 8).toFixed(1)}" y="${(y(last.v) + 4).toFixed(1)}">${esc(s.name)} ${esc(nf(last.v))}</text>`
          : "")
      );
    })
    .join("");
  const cols = days
    .map((day) => {
      const at = usable
        .map((s) => {
          const p = s.points.find((q) => q.day === day);
          return p ? `${s.name} ${nf(p.v)}` : null;
        })
        .filter(Boolean)
        .join(" · ");
      const step = days.length > 1 ? (W - 2 * PAD) / (days.length - 1) : W;
      return (
        `<g class="col">` +
        `<rect x="${(x(day) - step / 2).toFixed(1)}" y="0" width="${Math.max(step, 6).toFixed(1)}" height="${lh}" fill="transparent"/>` +
        `<line class="rule" x1="${x(day).toFixed(1)}" y1="6" x2="${x(day).toFixed(1)}" y2="${lh - 22}"/>` +
        `<title>${esc(day)} · ${esc(at)}</title></g>`
      );
    })
    .join("");
  // The legend carries each series' latest value, not just its name. A series
  // whose end-label was dropped for collision must still have its number
  // somewhere the eye lands, and identity here is the swatch beside the text —
  // never the text's own colour, which two of these four hues cannot carry on
  // the light surface anyway.
  const legend = usable
    .map(
      (s, i) =>
        `<span class="key"><i class="sw s${i + 1}"></i>${esc(s.name)} <b>${esc(nf(s.points[s.points.length - 1].v))}</b></span>`,
    )
    .join("");
  return (
    `<svg class="plot lines" viewBox="0 0 ${lw} ${lh}" role="img" aria-label="Lines by package over ${nf(days.length)} days">` +
    `<line class="axis" x1="${PAD}" y1="${lh - 22}" x2="${lw - PAD}" y2="${lh - 22}"/>` +
    `<text class="tick" x="${PAD}" y="${lh - 8}">${esc(days[0])}</text>` +
    `<text class="tick end" x="${(W - PAD).toFixed(1)}" y="${lh - 8}">${esc(days[days.length - 1])}</text>` +
    paths +
    cols +
    `</svg><div class="legend">${legend}</div>`
  );
}

// ── cards ──────────────────────────────────────────────────────────────────

/**
 * A stat tile: the value, the value it is read against, and the shape.
 *
 * The delta names its period. A bare "+412" is the same unreadable magnitude
 * the narrative refuses to print — the tile says "+412 since 2026-07-18" and
 * the two numbers stand next to each other, which is the one rule this whole
 * tool shares across both of its outputs.
 */
function statCard(label, points, unit, note) {
  if (!points.length) {
    return `<section class="card"><h2>${esc(label)}</h2><p class="absent">${esc(note || "No reading in any day of the series.")}</p></section>`;
  }
  const last = points[points.length - 1];
  const first = points[0];
  const delta = last.v - first.v;
  return (
    `<section class="card">` +
    `<h2>${esc(label)}</h2>` +
    `<p class="value">${esc(nf(last.v))}<span class="unit"> ${esc(unit)}</span></p>` +
    `<p class="sub">${esc(signed(delta))} since ${esc(first.day)}, when it was ${esc(nf(first.v))} — ${esc(nf(points.length))} days carry a reading.</p>` +
    sparkline(points, label) +
    (note ? `<p class="sub">${esc(note)}</p>` : "") +
    `</section>`
  );
}

function tapeCard(tape, lastRow) {
  const size = lastRow?.size?.value;
  // The row writes `{path, loc}`; this page wants the numbers. Converted by
  // the metric's own reader, never by arithmetic on the objects.
  const lines = tapeLines(tape);
  if (!lines.length) {
    const why = lastRow?.size?.reason || "no per-file lengths were handed to this page";
    return (
      `<section class="card wide"><h2>Lines per file</h2>` +
      `<p class="absent">No tape: ${esc(why)}.` +
      (size ? ` The row still reads p95 ${esc(nf(size.p95))} lines against a longest file of ${esc(nf(size.max))}.` : "") +
      `</p></section>`
    );
  }
  const sorted = [...lines].sort((a, b) => a - b);
  // p95 and max come off the `size` metric, which reads EVERY file. There is
  // deliberately no median here: this tape is the longest 50, so the middle
  // of it is the 25th-longest file in the repo and not the repo's median —
  // a true number under a label that makes it a false one. The metric does
  // not carry a p50, so none is printed.
  const marks = { p95: size?.p95 ?? null, max: size?.max ?? sorted[sorted.length - 1] };
  const total = classicsOf(lastRow)?.files;
  const rest = typeof total === "number" && total > sorted.length ? total - sorted.length : 0;
  return (
    `<section class="card wide">` +
    `<h2>Lines per file</h2>` +
    `<p class="value">${esc(nf(marks.max))}<span class="unit"> lines, longest</span></p>` +
    `<p class="sub">the ${esc(nf(sorted.length))} longest${typeof total === "number" ? ` of ${esc(nf(total))}` : ""}` +
      `${marks.p95 != null ? ` · p95 ${esc(nf(marks.p95))} over the whole tree` : ""}` +
      `${size?.maxPath ? ` · ${esc(size.maxPath)}` : ""}</p>` +
    tapeSvg(lines, marks) +
    `<p class="sub">The longest source files, shortest to longest among themselves` +
      `${rest ? `; the other ${esc(nf(rest))} files in the tree are not in this row` : ""}. ` +
      // Only when there IS one. A caption that names a rule the reader cannot
      // find sends them looking for a mark that was never drawn.
      `${marks.p95 == null ? "" : "The one ink rule is the p95, which is measured over every file and not over these."}</p>` +
    `</section>`
  );
}

/**
 * The table the relief rule obliges, and the one every reader eventually
 * wants anyway: two of the four line hues are under 3:1 on the light surface,
 * so the numbers exist in text as well as in colour.
 */
function tableCard(days, pkgs) {
  const tail = days.slice(-14);
  if (!tail.length) return "";
  const head = ["day", "files", "p95 lines", "longest", ...pkgs.map((p) => p.name), "deps"];
  const rows = tail.map((r) => {
    const c = classicsOf(r);
    const m = packageMap(pick(c, CLASSIC.packages));
    const cells = [
      r.day,
      nf(pick(c, CLASSIC.files)),
      nf(r.size?.value?.p95),
      nf(r.size?.value?.max),
      ...pkgs.map((p) => nf(p.name.startsWith("other") ? null : m.get(p.name))),
      nf(pick(c, CLASSIC.deps)),
    ];
    return `<tr>${cells.map((v, i) => `<td${i ? ' class="num"' : ""}>${esc(v)}</td>`).join("")}</tr>`;
  });
  return (
    `<section class="card wide">` +
    `<h2>The last ${nf(tail.length)} days of ${nf(days.length)}</h2>` +
    `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table></div>` +
    `</section>`
  );
}

// ── the page ───────────────────────────────────────────────────────────────

const STYLE = `
:root{--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;color-scheme:dark}}
:root[data-theme="dark"]{--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;color-scheme:dark}
body{margin:0;background:var(--plane);color:var(--ink);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding-block:24px;padding-left:16px;padding-right:16px}
h1{font-size:19px;margin:0 0 4px}
.lede{color:var(--ink2);margin:0 0 20px;font-size:13px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;
padding:14px 14px 10px;min-width:0}
.card.wide{grid-column:1/-1}
h2{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--ink2);margin:0 0 6px;text-transform:none}
.value{font-size:30px;font-weight:600;margin:0;line-height:1.1}
.unit{font-size:13px;font-weight:400;color:var(--ink2)}
.sub{margin:4px 0 8px;color:var(--ink2);font-size:12px}
.absent{margin:4px 0;color:var(--muted);font-size:12px}
.plot{width:100%;height:auto;display:block;overflow:visible}
.spark{fill:none;stroke:var(--s1);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.head{fill:var(--s1);stroke:var(--surface);stroke-width:2}
.tape .bars rect{fill:var(--s1)}
.mark{stroke:var(--axis);stroke-width:1;stroke-dasharray:3 3}
.marklabel,.tick,.endlabel{fill:var(--muted);font:10px system-ui,-apple-system,sans-serif}
.endlabel{fill:var(--ink2)}
.tick.end{text-anchor:end}
.axis{stroke:var(--axis);stroke-width:1}
.rule{stroke:var(--grid);stroke-width:1;opacity:0}
.col:hover .rule{opacity:1}
.line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.dot{stroke:var(--surface);stroke-width:2}
.s1{stroke:var(--s1)}.s2{stroke:var(--s2)}.s3{stroke:var(--s3)}.s4{stroke:var(--s4)}.s5{stroke:var(--s5)}
circle.s1{fill:var(--s1)}circle.s2{fill:var(--s2)}circle.s3{fill:var(--s3)}circle.s4{fill:var(--s4)}circle.s5{fill:var(--s5)}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:12px;color:var(--ink2)}
.key{display:inline-flex;align-items:center;gap:6px}
.key b{font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}
i.sw.s1{background:var(--s1)}i.sw.s2{background:var(--s2)}i.sw.s3{background:var(--s3)}
i.sw.s4{background:var(--s4)}i.sw.s5{background:var(--s5)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--muted);font-weight:500;padding:4px 10px 4px 0;white-space:nowrap}
td{padding:3px 10px 3px 0;color:var(--ink2);white-space:nowrap}
td.num{text-align:right}
tbody tr:nth-child(odd){background:color-mix(in srgb,var(--ink) 3%,transparent)}
footer{color:var(--muted);font-size:12px;margin-top:20px}
`;

/**
 * The whole page, as a string. Pure: no clock of its own, no filesystem.
 *
 * ── Why the page is dated by the series and not by the wall clock ──────────
 *
 * It used to stamp `new Date().toISOString().slice(0, 10)`, which is a UTC
 * date. Every other day in this system is the COMMIT's own offset — `git.mjs`
 * takes it from `%ci` precisely because 22 of this history's commits sit in
 * the 22:00 hour and would migrate a day if the machine's timezone decided.
 * So the page carried one day in a different calendar from every day in the
 * table under it, and on a late-evening run it was a day ahead of the row it
 * was describing. The last day-row's own `day` is the honest stamp: it says
 * what the page is drawn THROUGH, which is the thing a reader wants from a
 * date on a chart, and it needs no clock at all.
 *
 * @param {import("./types.mjs").Row[]} days  Day-reduced rows, oldest first.
 * @param {{tape?: number[]}} [opts]  `tape` is the per-file line counts of the
 *        latest snapshot; the caller has them and a Row does not.
 */
export function htmlDoc(days, opts = {}) {
  const rows = Array.isArray(days) ? days : [];
  const last = rows[rows.length - 1] || null;
  const pkgs = rows.length ? packageSeries(rows) : [];
  const fileSeries = series(rows, (r) => pick(classicsOf(r), CLASSIC.files));
  const depSeries = series(rows, (r) => pick(classicsOf(r), CLASSIC.deps));

  const body = rows.length
    ? [
        tapeCard(opts.tape, last),
        statCard("Source files", fileSeries, "files", null),
        statCard("Declared dependencies", depSeries, "declared", "Across every package.json in the tree."),
        `<section class="card wide"><h2>Lines by package</h2>` +
          (pkgs.length
            ? `<p class="sub">Four packages at most, in fixed colour order; a fifth folds into “other”. Every line is labelled at its end, and the numbers are in the table below.</p>${linesSvg(pkgs)}`
            : `<p class="absent">No per-package reading in the last day of the series.</p>`) +
          `</section>`,
        tableCard(rows, pkgs),
      ].join("")
    : `<section class="card wide"><p class="absent">The series has no days in it yet.</p></section>`;

  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Repo health — the classics</title>",
    `<style>${STYLE}</style></head><body><div class="wrap">`,
    "<h1>Repo health — the classics</h1>",
    `<p class="lede">.claude/outbox/repohealth.html — the four magnitudes, drawn${last?.day ? ` through ${esc(last.day)}` : ""}. ` +
      `Values read against each other; there is no threshold on this page and nothing on it applies itself. ` +
      `What MOVED is in .claude/outbox/repohealth.md instead.</p>`,
    `<div class="grid">${body}</div>`,
    `<footer>Regenerated only by the <code>html</code> subcommand, so the page's timestamp means somebody asked for it. Written to .claude/outbox/repohealth.html.</footer>`,
    "</div></body></html>",
  ].join("");
}

/**
 * Write it. Named by its full path in the returned console line, same rule as
 * the narrative's: a bare filename does not resolve for the reader.
 *
 * Unlike `narrate()` this ALWAYS writes. It is only ever called because a
 * person typed `html`, and a subcommand that silently declines to produce the
 * thing it is named after is a bug, not a courtesy.
 */
export function writeHtml(opts = {}) {
  const { root = process.cwd(), days = [], tape, log } = opts;
  const rel = OUTBOX_HTML;
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  // No `now`: the page dates itself by the last day-row. See `htmlDoc`.
  writeFileSync(abs, htmlDoc(days, { tape }), "utf8");
  const lines = [`${nf(days.length)} day(s) drawn to ${rel}`];
  if (log) for (const l of lines) log(l);
  return { path: abs, rel, written: true, lines };
}
