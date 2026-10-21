/**
 * The usage chip's contract: a desktop with only Claude draws EXACTLY today's
 * chip — one segment, claude's figures, the same danger rule, the same title.
 * The JSX itself cannot be imported by node, so the pins are the pure cut it
 * draws from plus the markup's own text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readAllCss } from "../../../../../tools/csssource.mjs";
import { chipCut } from "@waterplane/shared";
import { claudeDoorBeside, claudeSegmentFigures, figuresHot, infoFigures, readingsOf, tokensOpenSource } from "../../features/tokens/logic.ts";

const T = 1_800_000_000_000;
const info = (o = {}) => ({ ok: true, sessionPct: 12, weeklyPct: 40, sessionResetAt: T + 3600_000, weeklyResetAt: T + 86_400_000, checkedAt: T, ...o });
const copilot = { source: "copilot", label: "Copilot", backend: "copilot", checkedAt: T, windows: [{ id: "chat", unit: "mo", pct: 5, resetAt: null }] };

test("single claude: one segment, and it is the old chip's figures and danger", () => {
  for (const o of [{}, { sessionPct: 95 }, { weeklyPct: 88 }, { sessionPct: null }, { weeklyPct: null }]) {
    const u = info(o);
    const cut = chipCut(readingsOf(undefined, u), 3);
    assert.equal(cut.segments.length, 1);
    assert.equal(cut.total, 1);
    const seg = cut.segments[0];
    assert.equal(seg.source, "claude");
    const f = claudeSegmentFigures(seg.reading, u);
    assert.deepEqual(f, infoFigures(u));
    // today's `danger` class on the button
    assert.equal(figuresHot(f), (u.sessionPct ?? 0) >= 80 || (u.weeklyPct ?? 0) >= 80);
  }
});

test("a source with no reading draws nothing; no claude scrape and no other source = no segments", () => {
  assert.deepEqual(chipCut([], 3).segments, []);
  assert.deepEqual(chipCut(readingsOf(undefined, null), 3).segments, []);
  assert.deepEqual(chipCut([{ ...copilot, windows: [] }], 3).segments, []);
});

test("claude plus copilot: claude first, and a tap is a filter (total > 1)", () => {
  const cut = chipCut(readingsOf([copilot, readingsOf(undefined, info())[0]], info()), 3);
  assert.deepEqual(cut.segments.map((s) => s.source), ["claude", "copilot"]);
  assert.equal(cut.total, 2);
});

test("claude's scrape failed, Copilot read: claude still draws its door FIRST, beside Copilot", () => {
  const failed = info({ ok: false, sessionPct: null, weeklyPct: null, sessionResetAt: null, weeklyResetAt: null });
  const cut = chipCut(readingsOf([copilot], failed), 3);
  assert.deepEqual(cut.segments.map((s) => s.source), ["copilot"]);
  assert.equal(claudeDoorBeside(cut.segments, failed), true, "the door claude users see today stays");
  assert.deepEqual(infoFigures(failed), { sess: null, sessResetAt: null, wk: null }, "drawn `?` / `?` wk, as today");
  // Not drawn twice, not drawn with nothing else (that is the lone door), not without a scrape at all.
  assert.equal(claudeDoorBeside(chipCut(readingsOf(undefined, info()), 3).segments, info()), false);
  assert.equal(claudeDoorBeside([], failed), false);
  assert.equal(claudeDoorBeside(cut.segments, null), false);
  const src = readFileSync(new URL("./UsageChip.tsx", import.meta.url), "utf8");
  assert.match(src, /\{withDoor && door\(\)\}\{buttons\}/, "the door leads the group");
});

test("only a NON-claude segment filters: claude's tap opens the default view with no opened-on line", () => {
  assert.equal(tokensOpenSource("claude"), null);
  assert.equal(tokensOpenSource("copilot"), "copilot");
  const src = readFileSync(new URL("./UsageChip.tsx", import.meta.url), "utf8");
  assert.equal((src.match(/openTokensOn\(/g) ?? []).length, 3, "the door, a segment, a header strip");
  assert.ok(!src.includes("filtered"), "no tap filters on claude because other sources exist");
});

test("two sources or more: one Gauge, header-key metrics, the group last in the bar", () => {
  const src = readFileSync(new URL("./UsageChip.tsx", import.meta.url), "utf8");
  assert.match(src, /const gauge = !group \|\| \(!withDoor && i === 0\);/, "the Gauge is drawn once, on the group's first segment");
  assert.match(src, /function OtherFace\(\{ seg, size, gauge = true \}/);
  const css = readAllCss();
  // Measured (Chromium, this repo's styles.css, launcher bar with logo, ?, menu, bell, settings;
  // at the 7/9 padding the 2026-10-19 token snap made 6/8 — each segment is now 2px narrower):
  // claude's segment is 171.5×40 alone AND in the group (it was 177.5×44 in the group), the bar is
  // two rows at 360 and 390 px with claude + Copilot (it was three and four) — the same two rows
  // claude alone takes at 360 — and a third source wraps inside the group, never past the screen.
  const keyRule = css.split("\n").find((l) => l.startsWith(".topbar > .key,"));
  assert.ok(keyRule?.includes(".topbar > .usage-multi > .key") && keyRule.includes("min-height: 40px") && keyRule.includes("padding: var(--sp-6) var(--sp-8)"),
    "a group segment wears `.topbar > .key`'s 40px and 6/8 padding, so claude keeps its width");
  assert.ok(!/\.usage-multi \.usage-seg \{[^}]*min-height/.test(css), "no 44px floor of its own: the row is the touch floor");
  assert.match(css, /\.topbar > \.usage-multi \{ order: 10; flex: 0 1 auto; flex-wrap: wrap; \}/, "last in the bar, wrapping inside");
  assert.match(css, /:is\(\.topbar > \.key, \.hdr-ctl > \.key, \.hdr-pin > \.key, \.topbar > \.usage-multi > \.key\)/, "the desktop's mouse sizes too");
});

test("the markup keeps today's claude chip and never prints ? for another source", () => {
  const src = readFileSync(new URL("./UsageChip.tsx", import.meta.url), "utf8");
  for (const needle of ['className="usage-unit usage-reset"', 'className="usage-sep"', '<span className="usage-unit">wk</span>', "className={`usage-key ${figuresHot(f)", "className={`usage-key${group"]) {
    assert.ok(src.includes(needle), needle);
  }
  const other = src.slice(src.indexOf("function OtherFace"), src.indexOf("/** The long-press wording"));
  assert.ok(!other.includes('"?"'), "another source never draws ?");
});
