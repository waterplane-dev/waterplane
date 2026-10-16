// Token usage across every conversation on disk — end to end.
//
// `tokens.test.mjs` pins what the numbers MEAN once you have them. What it
// cannot pin is the part that produces them, and that part is a scanner over
// ~10,000 files somebody else's program writes. Every assertion here is a way
// it can be confidently, silently wrong:
//
//   • counting a STREAMING turn's duplicate records. Measured on a real
//     machine: 69,931 real turns and 49,260 duplicates, so this alone inflates
//     every figure on the screen by 70%.
//   • counting the usage-limit REJECTION, which the CLI writes as an assistant
//     turn with a `<synthetic>` model and a zero usage block.
//   • missing SUBAGENTS, which live one directory deeper
//     (`<conversation>/subagents/agent-*.jsonl`) and were a quarter of the real
//     total — a top-level-only walk produced a headline a third too small,
//     which looks entirely plausible.
//   • bucketing a day in UTC when the buckets are read back as local midnight,
//     which slides a late-evening turn onto the wrong column.
//   • the INCREMENTAL path: a file that grew must be re-read whole, and one
//     that vanished must stop counting. Getting this wrong drifts slowly, in
//     one direction, with nothing to compare against.
//
// The host is booted on a throwaway `<ENV>_CLAUDE_HOME` holding a hand-built
// corpus, so the numbers are known exactly rather than asserted to be
// "plausible".
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E, SLUG as BRAND_SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = "claude-opus-4-8";
const iso = (ms) => new Date(ms).toISOString();

/** An assistant turn carrying a usage block. */
const turn = (at, id, u, model = MODEL, oneHour = 0) => JSON.stringify({
  type: "assistant", timestamp: iso(at), uuid: `u-${id}`,
  cwd: "/Users/nobody/dev/demo",
  message: {
    id, model, role: "assistant",
    usage: {
      input_tokens: u[0], output_tokens: u[1],
      cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3],
      // The TTL split the cost estimate charges 2x on. Measured on the real
      // corpus: 84% of writes are the 1-hour tier, so a flat 1.25x understates
      // this line by ~60%.
      cache_creation: {
        ephemeral_1h_input_tokens: oneHour,
        ephemeral_5m_input_tokens: Math.max(0, u[3] - oneHour),
      },
      speed: "standard",
    },
  },
});

/** The usage-limit rejection: an assistant turn, `<synthetic>`, all zeros. */
const wall = (at) => JSON.stringify({
  type: "assistant", timestamp: iso(at),
  message: {
    id: `synth-${at}`, model: "<synthetic>", role: "assistant",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
  quotaLimits: { status: "rejected", resetsAt: Math.floor((at + 3600_000) / 1000), rateLimitType: "five_hour" },
});

const home = mkdtempSync(join(tmpdir(), `${BRAND_SLUG}-tok-home-`));
const root = mkdtempSync(join(tmpdir(), `${BRAND_SLUG}-tok-`));
const projects = join(home, ".claude", "projects");
const SLUG = "-Users-nobody-dev-demo";
const convDir = join(projects, SLUG);
mkdirSync(convDir, { recursive: true });

/** LOCAL noon on a given day, so the bucket cannot depend on the zone. */
const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();
const D1 = noon(2026, 3, 10);
const D2 = noon(2026, 3, 12);
/** 23:30 LOCAL — in a positive-offset zone this is the NEXT day in UTC, which
 *  is the bucketing bug this fixture exists to catch. */
const LATE = new Date(2026, 2, 12, 23, 30, 0).getTime();

const writeConv = (name, lines) => writeFileSync(join(convDir, name), lines.join("\n") + "\n");

// Conversation A: two real turns, one of them written three times (streaming),
// plus a rejection that must not count at all.
writeConv("aaaa.jsonl", [
  turn(D1, "m1", [10, 20, 1000, 100]),
  turn(D1 + 400, "m1", [10, 20, 1000, 100]),   // duplicate
  turn(D1 + 900, "m1", [10, 20, 1000, 100]),   // duplicate
  wall(D1 + 5_000),
  turn(D2, "m2", [5, 15, 2000, 50], MODEL, 40),
  turn(LATE, "m3", [1, 1, 10, 0]),             // late-evening local turn
]);

// Conversation B: a different model, so the by-model split has two rows.
writeConv("bbbb.jsonl", [turn(D2, "n1", [7, 3, 500, 25], "claude-sonnet-5")]);

// A SUBAGENT transcript, one directory deeper. Real spend, not a conversation.
mkdirSync(join(convDir, "aaaa", "subagents"), { recursive: true });
writeFileSync(join(convDir, "aaaa", "subagents", "agent-x.jsonl"),
  turn(D2, "s1", [100, 200, 3000, 300]) + "\n");

// Expected, by hand:
//   A: m1 (10,20,1000,100) + m2 (5,15,2000,50) + m3 (1,1,10,0)
//   B: n1 (7,3,500,25)
//   sub: s1 (100,200,3000,300)
const EXP = {
  input: 10 + 5 + 1 + 7 + 100,
  output: 20 + 15 + 1 + 3 + 200,
  cacheRead: 1000 + 2000 + 10 + 500 + 3000,
  cacheWrite: 100 + 50 + 0 + 25 + 300,
  turns: 5,
};
const EXP_TOTAL = EXP.input + EXP.output + EXP.cacheRead + EXP.cacheWrite;
const SUB_TOTAL = 100 + 200 + 3000 + 300;

const PORT = 8877;
const base = `http://127.0.0.1:${PORT}`;
const host = spawn("node", ["packages/host/dist/main.js"], {
  env: {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
    [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
    [E.CLAUDE_HOME]: home,
    // The hour buckets are cut to a recent window on the way out, and this
    // fixture is deliberately dated months back so the day bucketing can be
    // checked against a fixed calendar. Widen the window rather than move the
    // fixture: what is being asserted is the BUCKETING, not the cut.
    [E.TOKENSTATS_HOUR_DAYS]: "100000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
await waitForHost(PORT);

/** `fresh=1` skips the host's "scanned recently enough" shortcut. */
const get = () => fetch(`${base}/api/tokenstats?fresh=1`).then((r) => (r.ok ? r.json() : null));
const total = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
/** The same arithmetic the host is supposed to be doing, written out by hand.
 *  Opus 4.8 is $5/$25 per MTok; cache read 0.1x input, 5-minute write 1.25x,
 *  1-hour write 2x. */
const handCost = (t, inRate = 5, outRate = 25) => {
  const w1h = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  const w5m = t.cacheWrite - w1h;
  return (t.input / 1e6) * inRate
    + (t.output / 1e6) * outRate
    + (t.cacheRead / 1e6) * inRate * 0.1
    + (w5m / 1e6) * inRate * 1.25
    + (w1h / 1e6) * inRate * 2;
};

try {
  const doc = await get();
  if (!doc) {
    check(false, "GET /api/tokenstats answered nothing");
  } else {
    // ── what is counted ───────────────────────────────────────────────────
    check(doc.totals.turns === EXP.turns,
      `5 turns: three streaming copies collapse to one, the rejection is not a turn (got ${doc.totals.turns})`);
    check(total(doc.totals) === EXP_TOTAL, `total is ${EXP_TOTAL} (got ${total(doc.totals)})`);
    check(doc.totals.input === EXP.input && doc.totals.output === EXP.output
      && doc.totals.cacheRead === EXP.cacheRead && doc.totals.cacheWrite === EXP.cacheWrite,
      "the four kinds are kept apart and each is exact");

    // ── subagents ─────────────────────────────────────────────────────────
    check(total(doc.subagents) === SUB_TOTAL,
      `the subagent transcript one directory deeper IS counted (got ${total(doc.subagents)} of ${SUB_TOTAL})`);
    check(doc.subagentLogs === 1, `...and named as a transcript, not a conversation (got ${doc.subagentLogs})`);
    check(doc.conversations === 2,
      `...so the conversation count stays 2, not 3 (got ${doc.conversations})`);
    check(total(doc.subagents) < total(doc.totals),
      "the subagent slice is part OF the total, never added to it");

    // ── buckets ───────────────────────────────────────────────────────────
    const days = doc.days.map((d) => d.day);
    check(days.length === 2 && days[0] < days[1], `two active days, ascending (got ${days.join(",")})`);
    // The 23:30 local turn belongs to the 12th in local time; in UTC+n it is
    // already the 13th, which is the bug.
    check(days[1] === "2026-03-12", `a 23:30 local turn buckets on its LOCAL day (got ${days[1]})`);
    check(doc.days.reduce((n, d) => n + total(d), 0) === EXP_TOTAL,
      "the days add back up to the total — no turn is in two buckets or none");

    // ── hours ─────────────────────────────────────────────────────────────
    // The hour is the stored key and the day is its first ten characters, so
    // the two cannot disagree — which is exactly the claim worth pinning.
    const hours = doc.hours.map((h) => h.hour);
    check(hours.length === 3 && hours.every((h, i) => i === 0 || hours[i - 1] < h),
      `three active hours, ascending (got ${hours.join(",")})`);
    check(hours.every((h) => days.includes(h.slice(0, 10))),
      "every hour belongs to a day the day rows already named");
    check(hours.includes("2026-03-12T23"),
      `the 23:30 local turn is in the LOCAL 23:00 hour (got ${hours.join(",")})`);
    check(doc.hours.reduce((n, h) => n + total(h), 0) === EXP_TOTAL,
      "the hours add back up to the total — the day rows are a fold of these");
    check(doc.hoursFrom != null && doc.hoursFrom <= Date.parse("2026-03-10T23:59"),
      "the window start is stated rather than implied");

    // The time-of-day profile is 24 slots whatever the corpus looks like — an
    // hour nobody ever worked is a zero, not a missing row.
    check(doc.hourOfDay.length === 24 && doc.hourOfDay.every((h, i) => h.hour === i),
      "the time-of-day profile is 24 slots, midnight first");
    check(total(doc.hourOfDay[12]) > 0 && total(doc.hourOfDay[23]) > 0 && total(doc.hourOfDay[3]) === 0,
      "…folded onto the clock face: noon and 23:00 busy, 03:00 empty");
    check(doc.hourOfDay.reduce((n, h) => n + total(h), 0) === EXP_TOTAL,
      "…and it folds the whole corpus, not just the recent window");

    const models = doc.models.map((m) => m.key).sort();
    check(models.join(",") === "claude-opus-4-8,claude-sonnet-5", `both models (got ${models.join(",")})`);
    check(doc.models.reduce((n, m) => n + total(m), 0) === EXP_TOTAL, "the models add back up to the total");
    check(doc.repos.length === 1 && doc.repos[0].label === "demo",
      `attributed to the repo the records name (got ${doc.repos.map((r) => r.label).join(",")})`);

    check(doc.firstAt != null && doc.lastAt != null && doc.lastAt >= doc.firstAt, "the span is dated and ordered");

    // ── the kept /usage readings ──────────────────────────────────────────
    // A separate document with a different provenance: the token figures are
    // derived from the CLI's logs, these are a log of what THIS daemon saw. The
    // route must answer with a well-formed empty history on a host that has
    // never taken a reading — an error here would leave the two limit windows
    // with no line and no explanation.
    const hist = await fetch(`${base}/api/usagelog?hours=24`).then((r) => (r.ok ? r.json() : null));
    check(!!hist && Array.isArray(hist.samples), "GET /api/usagelog answers a history document");
    if (hist) {
      check(hist.keptFrom === null || typeof hist.keptFrom === "number",
        "…stating what it actually holds, so an empty left edge is not read as a quiet week");
      check(typeof hist.everyMs === "number" && hist.everyMs > 0,
        "…and the poll period, so the chart can say what dense would have looked like");
    }

    // The same store folded over a SPAN (`/api/costwindow`): over a span that
    // covers the whole fixture the two folds must agree to the cent, and the
    // agent transcript must fold into its parent rather than stand as a row.
    const cwFrom = new Date(2026, 2, 9).getTime();
    const cwTo = new Date(2026, 2, 14).getTime();
    const cw = await fetch(`${base}/api/costwindow?from=${cwFrom}&to=${cwTo}`).then((r) => (r.ok ? r.json() : null));
    check(!!cw && Array.isArray(cw.convos), "GET /api/costwindow answers a window document");
    if (cw) {
      // Carried rows plus the ones the cap folded (`COST_CONVOS_CAP`) — the fixture sits under it today.
      const cwN = cw.convos.length + (cw.rest ?? []).reduce((n, r) => n + r.count, 0);
      check(cwN === doc.conversations && (cw.convosTotal ?? cw.convos.length) === cwN,
        `one row per conversation, agents folded in (got ${cwN}, want ${doc.conversations})`);
      check(total(cw.totals) === EXP_TOTAL, `the window over the whole fixture holds every token (got ${total(cw.totals)})`);
      check(Math.abs(cw.cost.total - doc.cost.total) < 1e-9,
        `…and the same money as the all-time fold (got ${cw.cost.total}, want ${doc.cost.total})`);
      check([...cw.convos, ...(cw.rest ?? [])].reduce((n, c) => n + c.agents, 0) === doc.subagentLogs, "…with the agent counted once, on its parent");
    }
    const cwBad = await fetch(`${base}/api/costwindow?from=${cwTo}&to=${cwFrom}`).then((r) => (r.ok ? r.json() : null));
    check(!!cwBad && cwBad.convos.length === 0 && cwBad.to === 0, "a backwards span is an empty answer, not an error");

    // ── list-price cost ───────────────────────────────────────────────────
    // The one part of this screen that puts a dollar figure in front of
    // somebody, so the arithmetic is checked against a hand calculation rather
    // than against itself.
    check(doc.totals.cacheWrite1h === 40,
      `the 1-hour cache-write subset is read from the log (got ${doc.totals.cacheWrite1h})`);
    check(doc.totals.cacheWrite1h < doc.totals.cacheWrite, "…and it is a SUBSET of all writes");

    // Both models here are $5/$25, except sonnet-5 which is on its introductory
    // rate for these March 2026 days — so the total is not one flat calculation.
    const opus = doc.models.find((m) => m.key === "claude-opus-4-8");
    const sonnet = doc.models.find((m) => m.key === "claude-sonnet-5");
    check(Math.abs(opus.cost.total - handCost(opus)) < 1e-9,
      `opus priced by hand agrees (${opus.cost.total} vs ${handCost(opus)})`);
    check(Math.abs(sonnet.cost.total - handCost(sonnet, 2, 10)) < 1e-9,
      `sonnet-5 on a March day uses its INTRODUCTORY rate (${sonnet.cost.total} vs ${handCost(sonnet, 2, 10)})`);
    check(Math.abs(sonnet.cost.total - handCost(sonnet, 3, 15)) > 1e-12,
      "…which is not the same as its current rate");

    const sumModels = doc.models.reduce((n, m) => n + m.cost.total, 0);
    const sumDays = doc.days.reduce((n, d) => n + d.cost.total, 0);
    const sumRepos = doc.repos.reduce((n, r) => n + r.cost.total, 0);
    check(Math.abs(sumModels - doc.cost.total) < 1e-9, `the models' costs add up to the total (${sumModels})`);
    check(Math.abs(sumDays - doc.cost.total) < 1e-9, `…and so do the days' (${sumDays})`);
    check(Math.abs(sumRepos - doc.cost.total) < 1e-9, `…and the repos' (${sumRepos})`);
    check(Math.abs((doc.cost.input + doc.cost.output + doc.cost.cacheRead + doc.cost.cacheWrite) - doc.cost.total) < 1e-12,
      "the cost breakdown adds up to its own total");

    check(doc.subagentCost.total > 0 && doc.subagentCost.total < doc.cost.total,
      "the subagent cost is a slice OF the spend, not an addition to it");
    check(total(doc.unpriced) === 0, "nothing here is unpriced");
    check(doc.fastTurns === 0, "no fast-mode turns in this corpus");
    check(/^\d{4}-\d{2}-\d{2}$/.test(doc.pricesAsOf), `the price list is dated (${doc.pricesAsOf})`);
    check(doc.models.every((m) => m.priced === true), "every model here has a published rate");
    check(doc.logs >= 3, `every log was examined (got ${doc.logs})`);
  }

  // ── the incremental path ────────────────────────────────────────────────
  // A file that GREW must be re-read whole, not appended to: the duplicate rule
  // needs the file's own id set, and an appended read cannot have one.
  {
    writeConv("bbbb.jsonl", [
      turn(D2, "n1", [7, 3, 500, 25], "claude-sonnet-5"),
      turn(D2 + 1000, "n2", [1, 1, 1, 1], "claude-sonnet-5"),
      turn(D2 + 1400, "n2", [1, 1, 1, 1], "claude-sonnet-5"), // duplicate, new pass
    ]);
    await sleep(1100); // let mtime move past the recorded one
    const doc = await get();
    check(total(doc.totals) === EXP_TOTAL + 4,
      `a grown file adds exactly its new turn, duplicate and all (got ${total(doc.totals) - EXP_TOTAL})`);
    check(doc.totals.turns === EXP.turns + 1, `...and one turn, not two (got ${doc.totals.turns})`);
    check(doc.reread >= 1 && doc.reread < doc.logs,
      `only what changed was re-read (${doc.reread} of ${doc.logs})`);
  }

  // A conversation deleted from the archive stops counting — the documented
  // scope is "every log currently on disk", and it has to actually behave that
  // way or the number is unreconcilable with anything.
  {
    rmSync(join(convDir, "bbbb.jsonl"));
    const doc = await get();
    check(total(doc.totals) === EXP_TOTAL - (7 + 3 + 500 + 25),
      `a deleted log stops counting (got ${total(doc.totals)}, wanted ${EXP_TOTAL - 535})`);
    check(doc.models.length === 1, `...and its model leaves the split (got ${doc.models.length})`);
  }

  // ── nothing to count is not an error ────────────────────────────────────
  {
    rmSync(join(convDir, "aaaa.jsonl"));
    rmSync(join(convDir, "aaaa"), { recursive: true, force: true });
    const doc = await get();
    check(doc != null && total(doc.totals) === 0 && doc.days.length === 0,
      "an empty corpus is an empty document, not a 404 and not a stale total");
  }
} finally {
  host.kill();
  await sleep(200);
}

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
