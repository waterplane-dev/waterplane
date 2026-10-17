// The optimisation prompts' text. The terminal form is typed into whatever the active terminal
// runs, so it is ONE line with no control character in it — a newline there is a command run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, LOG, data, prompt, req, tmp } from "./helpers.mjs";

// eslint-disable-next-line no-control-regex
const C0 = /[\x00-\x1f\x7f]/;

/** A HealthDoc around the fixture plot (src.ts growing 10 → 50 lines; size.p95 and CLAUDE.md rising;
 *  the longest file's path carries ESC, CR and LF). */
const PLOT = JSON.parse(readFileSync(join(FIXTURES, "health", "plot.json"), "utf8"));
const healthDoc = (plot = PLOT) => ({
  folder: "/f", series: null, measure: null, head: null, behind: null, plot, plotError: null, readError: null,
  last: null, shallow: false, seriesFile: "/s", stepMs: 180000, readAt: 1,
});

async function ctxFor(logPath, folder = join(FIXTURES, "repo")) {
  const { doc } = await data.readSession(logPath, null, "/f");
  const weight = await data.weighFolder(folder);
  return { session: doc, weight, health: healthDoc() };
}

const turnOf = (ctx) => ctx.session.turnCosts.find((t) => t.n > 0)?.n;

test("every prompt's terminal form is one line with no C0 control or DEL; the copy form keeps paragraphs", async () => {
  const ctx = await ctxFor(LOG);
  const turn = turnOf(ctx);
  assert.equal(data.PROMPTS.length, 6);
  for (const p of data.PROMPTS) {
    const t = data.render(p.id, { ...ctx, turn }, "terminal");
    assert.ok(t.ok, `${p.id} renders`);
    assert.ok(!C0.test(t.text), `${p.id}: terminal form has a control character: ${JSON.stringify(t.text)}`);
    for (const ch of ["\n", "\r", "\x1b"]) assert.ok(!t.text.includes(ch));
    const c = data.render(p.id, { ...ctx, turn }, "copy");
    assert.ok(c.ok);
    assert.ok(c.text.includes("\n\n"), `${p.id}: the clipboard form keeps its paragraphs`);
  }
});

test("a prompt quoted from a log with ESC sequences and CRLF + a command is neutralised, in both forms", async () => {
  const p = join(tmp("inject"), "i.jsonl");
  const evil = "look \x1b[31mred\x1b[0m\r\nrm -rf ~\x07\x7f done";
  writeFileSync(p, [prompt(0, evil), req(1, "x", { input: 100, cw: 2000, output: 30 })].join("\n") + "\n");
  const ctx = await ctxFor(p);
  const row = ctx.session.turnCosts[0];
  assert.ok(!C0.test(row.prompt), `the turn's excerpt is scrubbed: ${JSON.stringify(row.prompt)}`);
  for (const form of ["terminal", "copy"]) {
    const r = data.render("explain-turn", { ...ctx, turn: row.n }, form);
    assert.ok(r.ok);
    const quoted = r.text.slice(r.text.indexOf("(\""), r.text.indexOf("\")") + 2);
    assert.ok(!C0.test(quoted), `${form}: the quoted prompt carries no control: ${JSON.stringify(quoted)}`);
    assert.match(quoted, /look \[31mred \[0m rm -rf ~ done/);
  }
  const t = data.render("explain-turn", { ...ctx, turn: row.n }, "terminal");
  assert.ok(!C0.test(t.text));
});

test("a skill name with control characters is scrubbed in both forms", () => {
  const weight = {
    folder: "/f", claudeMdChars: 10,
    skills: [{ name: "bad\x1b]0;pwn\x07\nname", descChars: 500, bodyChars: 900 }],
    reading: { alwaysOnChars: 510, alwaysOnTokens: 128, skillCount: 1 },
  };
  for (const form of ["terminal", "copy"]) {
    const r = data.render("shrink-skill-descs", { session: null, weight }, form);
    assert.ok(r.ok);
    assert.ok(r.text.includes("bad ]0;pwn name"), r.text);
    if (form === "terminal") assert.ok(!C0.test(r.text));
    else assert.ok(!/\x1b|\x07|\r/.test(r.text) && !r.text.includes("bad\n"));
  }
});

test("turn 0 (before the first prompt) cannot be explained", async () => {
  const p = join(tmp("turn0"), "z.jsonl");
  writeFileSync(p, [req(0, "pre", { input: 10, output: 1 }), prompt(1, "go"), req(2, "y", { input: 20, output: 2 })].join("\n") + "\n");
  const ctx = await ctxFor(p);
  assert.equal(ctx.session.turnCosts[0].n, 0);
  assert.equal(data.render("explain-turn", { ...ctx, turn: 0 }, "copy").ok, false);
  assert.equal(data.render("explain-turn", { ...ctx, turn: 1 }, "copy").ok, true);
});

test("an empty folder still renders a terminal form without controls", async () => {
  const dir = tmp("emptyfolder");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const ctx = await ctxFor(LOG, dir);
  const r = data.render("groom-claudemd", ctx, "terminal");
  assert.ok(r.ok && !C0.test(r.text));
});

test("the health prompts say why when nothing has been measured, or nothing qualifies", () => {
  for (const id of ["split-longest-file", "explain-rising-metric"]) {
    for (const health of [null, undefined, { ...healthDoc(), plot: null }]) {
      const r = data.render(id, { session: null, weight: null, health }, "copy");
      assert.deepEqual(r, { ok: false, why: "No repo-health reading for this folder yet — open Repo health in the sidebar and measure it." });
    }
  }
  const flat = structuredClone(PLOT);
  for (const s of flat.series) s.reading = { ...s.reading, slope: "flat" };
  assert.deepEqual(data.render("explain-rising-metric", { session: null, weight: null, health: healthDoc(flat) }, "copy"),
    { ok: false, why: "No metric in this folder's series is rising right now, so there is nothing to ask about." });
  const nolong = structuredClone(PLOT);
  delete nolong.longest;
  assert.equal(data.render("split-longest-file", { session: null, weight: null, health: healthDoc(nolong) }, "copy").ok, false);
});

test("split-longest-file quotes the scrubbed path, the latest length, an earlier one and the p95; proposes, applies nothing", () => {
  for (const form of ["copy", "terminal"]) {
    const r = data.render("split-longest-file", { session: null, weight: null, health: healthDoc() }, form);
    assert.ok(r.ok);
    assert.ok(r.text.includes("src/big [31m rm -rf ~.ts"), r.text);
    assert.ok(!/\x1b|\r/.test(r.text) && !r.text.includes("big\n"));
    assert.match(r.text, /at 50 lines on 2026-05-05/);
    assert.match(r.text, /4 readings earlier \(2026-01-01\) the longest file was 10 lines/);
    assert.match(r.text, /at most 50 lines/);
    assert.match(r.text, /longest file over 1k lines as a problem/);
    assert.match(r.text, /apply nothing until I say so/);
    if (form === "terminal") assert.ok(!C0.test(r.text));
  }
});

test("explain-rising-metric picks the rising series with the highest rank and asks for text only", () => {
  const r = data.render("explain-rising-metric", { session: null, weight: null, health: healthDoc() }, "terminal");
  assert.ok(r.ok && !C0.test(r.text));
  assert.match(r.text, /"p95 file length" is rising: it reads 50 lines now, higher than 95% of its own last 5 readings since 2026-01-01/);
  assert.match(r.text, /three concrete proposals/);
  assert.match(r.text, /Do not change files/);
  assert.equal(data.risingSeries(healthDoc()).key, "size.p95");
});

test("explain-rising-metric states what the reading counts in the phone's words, and a repo's override of it", async () => {
  const { HEALTH_ENTRY_MEASURE } = await import("../../web/src/healthIndexWords.ts");
  const r = data.render("explain-rising-metric", { session: null, weight: null, health: healthDoc() }, "copy");
  assert.ok(r.ok);
  assert.ok(r.text.includes(`"p95 file length" is ${HEALTH_ENTRY_MEASURE.size}.`), r.text);
  const over = structuredClone(PLOT);
  over.series.find((s) => s.key === "size.p95").variant = {
    kind: "override", why: "we count src only", means: "p95 over src", unit: "lines", points: [], last: 40, since: "2026-05-05",
  };
  const t = data.render("explain-rising-metric", { session: null, weight: null, health: healthDoc(over) }, "terminal");
  assert.ok(t.ok && !C0.test(t.text));
  assert.match(t.text, /This repo's own version — p95 over src; since 2026-05-05\. The index reads 40 lines from it/);
  assert.match(t.text, /The repo's reason: we count src only\./);
  assert.equal(data.definitionOf({ key: "dups.pairsPerKloc", label: "x" }), null, "a series no index entry reads gets no definition");
});
