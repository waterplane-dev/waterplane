import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openedTarget, readingForLedger, openedOnFor, openedOnText, readingChips, sourceTotal, sourceLabel, sparkPoints, windowText, asUsageSamples } from "./sourceWords.ts";

const win = (o = {}) => ({ id: "chat", unit: "mo", pct: 5, resetAt: null, ...o });
const rd = (source, label, windows) => ({ source, label, checkedAt: 1, windows });
const claude = rd("claude", "Claude", [win({ id: "session", unit: "5h", pct: 40 })]);
const copilot = rd("copilot", "Copilot", [win({ pct: null, used: 9, limit: 200, unitName: "credits" })]);
const empty = rd("ghost", "Ghost", []);

test("a reading chip exists only while the reading does, never for claude, a ledger tab or an empty reading", () => {
  assert.deepEqual(readingChips([claude, copilot, empty]).map((c) => c.source), ["copilot"]);
  assert.deepEqual(readingChips([claude]), []);
  assert.deepEqual(readingChips(undefined), []);
  assert.deepEqual(readingChips([claude, copilot], ["copilot"]), []);
});

test("opened-on names the source and the N the launcher chip drew; absent with one source or none tapped", () => {
  const rs = [claude, copilot, empty];
  assert.equal(sourceTotal(rs), 2);
  assert.equal(openedOnText(sourceLabel(rs, "copilot"), sourceTotal(rs)), "opened on Copilot · 1 of 2 sources");
  assert.equal(openedOnText(null, 2), null);
  assert.equal(openedOnText("Claude", sourceTotal([claude])), null);
});

test("the line follows the body's OWN `on`: gone after `all` (null) even with the view back on claude", () => {
  const rs = [claude, copilot];
  assert.equal(openedOnFor("copilot", "copilot", rs), "opened on Copilot · 1 of 2 sources");
  assert.equal(openedOnFor("copilot", "claude", rs), null, "the view moved off the tapped source");
  assert.equal(openedOnFor(null, "claude", rs), null, "after all");
  assert.equal(openedOnFor(null, "copilot", rs), null, "after all, even back on copilot by its chip");
  assert.equal(openedOnFor("copilot", "copilot", [copilot]), null, "one source: nothing hidden");
});

test("the `all` tap clears the body's own state, and the sheet never clears in an unmount cleanup", () => {
  const body = readFileSync(new URL("./TokenStatsBody.tsx", import.meta.url), "utf8");
  assert.match(body, /useState<string \| null>\(openedOn \?\? null\)/, "the tapped source is held as state, not read off the prop");
  assert.match(body, /onClick=\{\(\) => \{ setOn\(null\);[^}]*\}\}>all<\/Button>/, "`all` drops the line at once");
  assert.match(body, /openedOnFor\(on, viewing, readings\)/);
  const sheet = readFileSync(new URL("./TokensSheet.tsx", import.meta.url), "utf8");
  assert.ok(!/useEffect\(\(\) => \(\) =>/.test(sheet), "StrictMode runs an unmount cleanup at mount in dev");
  assert.match(sheet, /onClose=\{\(\) => \{ c\.world\.clearTokensOn\(\); c\.nav\.close\("tokens"\); \}\}/, "close forgets the filter");
});

test("a window line carries the count form when the source bills in units", () => {
  assert.equal(windowText(copilot.windows[0]), "chat · 5% used · 9 / 200 credits");
  assert.equal(windowText(win({ pct: 12 })), "chat · 12% used");
});

test("history points skip unreadable percentages and degrade to nothing on a bad doc", () => {
  const doc = { source: "copilot", keptFrom: 1, cap: 9, retainMs: 9, samples: [
    { t: 3, w: [{ id: "chat", pct: 7, resetAt: null }] },
    { t: 1, w: [{ id: "chat", pct: 5, resetAt: null }] },
    { t: 2, w: [{ id: "chat", pct: null, resetAt: null }] },
    { t: 4, w: [{ id: "chat", pct: 400, resetAt: null }] },
    { t: 5, w: [{ id: "other", pct: 1, resetAt: null }] },
  ] };
  assert.deepEqual(sparkPoints(doc, "chat"), [{ t: 1, pct: 5, r: null }, { t: 3, pct: 7, r: null }]);
  assert.deepEqual(sparkPoints(null, "chat"), []);
  assert.deepEqual(sparkPoints({ samples: "x" }, "chat"), []);
});

test("a tap opens the source's own view: guest, ledger tab, reading chip — else Claude's", () => {
  const ids = { guests: ["guestbe"], ledgers: ["copilot", "codex"], chips: ["gemini"] };
  assert.deepEqual(openedTarget("copilot", ids), { source: "claude", extraId: "copilot" });
  assert.deepEqual(openedTarget("guestbe", ids), { source: "guestbe", extraId: null });
  assert.deepEqual(openedTarget("gemini", ids), { source: "claude", extraId: "reading:gemini" });
  assert.deepEqual(openedTarget("gh", { ...ids, backendOf: "copilot" }), { source: "claude", extraId: "copilot" });
  assert.deepEqual(openedTarget("gone", ids), { source: "claude", extraId: null });
  assert.deepEqual(openedTarget(null, ids), { source: "claude", extraId: null });
});

test("a ledger tab leads with its source's reading, by id or by backend", () => {
  const rs = [{ source: "gh", backend: "copilot", label: "Copilot" }, { source: "codex", label: "Codex" }];
  assert.equal(readingForLedger(rs, "codex").source, "codex");
  assert.equal(readingForLedger(rs, "copilot").source, "gh");
  assert.equal(readingForLedger(rs, "guestbe"), null);
});

test("a source's readings ride claude's sample shape on the 5-hour lane, reset and all", () => {
  assert.deepEqual(asUsageSamples([{ t: 1, pct: 5, r: 99 }]), [{ t: 1, s: 5, w: null, sr: 99, wr: null }]);
});
