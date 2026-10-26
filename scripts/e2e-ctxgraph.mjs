// The context-window graph, end to end.
//
// `ctxlog.test.mjs` pins what may be parsed out of a conversation log and
// `contextPlot.test.mjs` pins what may be drawn from it. Neither can pin the
// two joins in between, and both of those are silent when they break:
//
//   1. `GET /api/context` has to find the session's log at all — which means
//      the conversation id, the project-dir slug and the tail read all lining
//      up. When they don't, the route answers 404 and the sheet shows "no
//      context history", which is indistinguishable from a conversation that
//      genuinely has not run a turn.
//
//   2. `SessionInfo.contextSpark` has to reach the launcher on the socket, and
//      it has to carry the WINDOW. The window is the whole point of the feature
//      — it is what makes every graph the same 0–100% scale — and it comes from
//      the model, which the host reads back out of that same log. A spark that
//      arrives with `windowFrom: "none"` still draws a curve; it just draws one
//      that cannot be compared with any other session's, and nothing about the
//      row says so.
//
// So this script BE the CLI's own record — a fabricated conversation under a
// throwaway `<ENV>_CLAUDE_HOME`, holding one climb, one auto-compaction and one
// usage wall — and then asks both ends what they made of it.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { contextWindowFor, windowContaining } from "../packages/shared/dist/ctxwindow.js";
import { costChip, sessionCostOf } from "../packages/shared/dist/sessioncost.js";
import { costOf } from "../packages/shared/dist/pricing.js";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = "claude-opus-4-8";
const T0 = Date.now() - 6 * 3600_000;
const iso = (ms) => new Date(ms).toISOString();

/** The prompt that OPENS a turn. Turn counts are taken off these user records
 *  (`transcript.ts` `opensTurn`), never off the readings — a turn that ran
 *  thirteen tools writes fourteen readings, so counting the series counts round
 *  trips and calls them turns. */
const prompt = (at, id, text) => JSON.stringify({
  type: "user", timestamp: iso(at), uuid: `p${id}`,
  message: { role: "user", content: [{ type: "text", text }] },
});

/** An assistant turn. `tok` is split over the three fields whose SUM is the
 *  context the request carried — the number the graph plots. */
const turn = (at, id, tok) => JSON.stringify({
  type: "assistant", timestamp: iso(at), uuid: `u${id}`,
  message: {
    id, model: MODEL, role: "assistant",
    usage: {
      input_tokens: 2, cache_read_input_tokens: tok - 102,
      cache_creation_input_tokens: 100, output_tokens: 400,
    },
  },
});

const compact = (at, preTokens, postTokens) => JSON.stringify({
  type: "system", subtype: "compact_boundary", content: "Conversation compacted",
  timestamp: iso(at),
  compactMetadata: { trigger: "auto", preTokens, postTokens, durationMs: 9000 },
});

/** The rejection the CLI writes: a synthetic assistant turn plus `quotaLimits`.
 *  Its usage block is all zeros, which is why plotting it would draw a cliff. */
const wall = (at, resetAt) => JSON.stringify({
  type: "assistant", timestamp: iso(at),
  message: {
    id: `synth-${at}`, model: "<synthetic>", role: "assistant",
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  },
  quotaLimits: { status: "rejected", resetsAt: Math.floor(resetAt / 1000), rateLimitType: "five_hour" },
});

/** A subagent's own turn, written to its own log. Same shape, `isSidechain`. */
const agentTurn = (at, id, tok) => JSON.stringify({
  type: "assistant", isSidechain: true, timestamp: iso(at),
  message: {
    id, model: MODEL, role: "assistant",
    usage: {
      input_tokens: 2, cache_read_input_tokens: tok - 102,
      cache_creation_input_tokens: 100, output_tokens: 1_000,
    },
  },
});

/** An always-on `attachment` record, the shape the CLI writes before its first request. */
const attachment = (at, a) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "attachment", uuid: `att${at}`, timestamp: iso(at), attachment: a });

/** One climb to an auto-compaction, a wall, then a second climb. */
function writeConversation(home, cwd, cid) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  // What the first request carried (`carried`): two kinds before it, one delta after it.
  const lines = [
    attachment(T0 - 2_000, { type: "instructions", files: [{ path: `${cwd}/CLAUDE.md`, type: "Project", content: "x".repeat(4_000) }] }),
    attachment(T0 - 1_900, { type: "skill_listing", content: "s".repeat(1_200), skillCount: 2, isInitial: true, names: ["one", "two"] }),
  ];
  for (let i = 0; i < 12; i++) {
    lines.push(prompt(T0 + i * 60_000 - 500, `a${i}`, `climbing turn ${i}`));
    lines.push(turn(T0 + i * 60_000, `a${i}`, 20_000 + i * 14_000));
    if (i === 0) lines.push(attachment(T0 + 1_000, { type: "mcp_instructions_delta", addedNames: ["late"], addedBlocks: ["m".repeat(300)], removedNames: [] }));
  }
  lines.push(compact(T0 + 12 * 60_000, 182_000, 9_000));
  // A streaming duplicate, split so the reader has to dedupe by message id. ONE
  // prompt above it: the two records are one request, and so one turn.
  lines.push(prompt(T0 + 13 * 60_000 - 500, "b0", "after the compaction"));
  lines.push(turn(T0 + 13 * 60_000, "b0", 12_000));
  lines.push(turn(T0 + 13 * 60_000 + 300, "b0", 12_000));
  // The wall is the CLI REJECTING the turn above — it opens no new one.
  lines.push(wall(T0 + 14 * 60_000, T0 + 18 * 60_000));
  for (let i = 0; i < 6; i++) {
    lines.push(prompt(T0 + (20 + i) * 60_000 - 500, `c${i}`, `after the wall ${i}`));
    lines.push(turn(T0 + (20 + i) * 60_000, `c${i}`, 16_000 + i * 9_000));
  }
  writeFileSync(join(dir, cid + ".jsonl"), lines.join("\n") + "\n");
  // Two subagents, in the files the CLI actually writes them to — a sibling
  // DIRECTORY, not `isSidechain` rows in the log above (measured on this
  // desktop: 0 of 7,761 logs carry one). Their tokens are not this
  // conversation's context and ARE this session's spend, which is the whole
  // point of the pair of numbers asserted below.
  const subs = join(dir, cid, "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-one.jsonl"),
    [agentTurn(T0 + 60_000, "s1", 300_000), agentTurn(T0 + 120_000, "s2", 200_000)].join("\n") + "\n");
  writeFileSync(join(subs, "agent-two.jsonl"), agentTurn(T0 + 90_000, "s3", 100_000) + "\n");
  // Not a transcript: it must not be read as one.
  writeFileSync(join(subs, "agent-one.meta.json"), JSON.stringify({ agentType: "Explore" }) + "\n");
  return lines.length;
}

const root = mkdtempSync(join(tmpdir(), `${SLUG}-ctxgraph-`));
const home = mkdtempSync(join(tmpdir(), `${SLUG}-ctxgraph-home-`));
const PORT = 8871;
const base = `http://127.0.0.1:${PORT}`;

const host = spawn("node", ["packages/host/dist/main.js"], {
  env: {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
    [E.CLAUDE_BIN]: STUB, STUB_MODE: "repaint",
    // The conversation log lives under a throwaway home, so this test can BE
    // the CLI's own record without touching the developer's.
    [E.CLAUDE_HOME]: home,
    // The spark is refreshed on the once-a-turn context scan, which runs when a
    // session goes idle. Pull that in so the script does not sit for four
    // seconds per assertion.
    [E.IDLE_MS]: "1200", [E.IDLE_PING_MS]: "1200",
    // The OTHER path into the miniature — the periodic sweep, which is what a
    // session that never goes quiet has to be drawn by (section 5).
    [E.LIMIT_SWEEP_MS]: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
await waitForHost(PORT);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ctx" }),
}).then((r) => r.json());

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let session = null;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "session.created") session = m.session;
  if (m.t === "session.updated" && session && m.session.id === session.id) session = m.session;
});
await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
await sleep(300);
ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "ctx · main", cols: 80, rows: 24 }));
for (let i = 0; i < 80 && !session?.claudeSessionId; i++) await sleep(100);

const until = async (cond, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(200); }
  return false;
};

try {
  if (!session?.claudeSessionId) {
    check(false, "the session never published a conversation id — nothing below can run");
  } else {
    const nLines = writeConversation(home, repo.path, session.claudeSessionId);
    console.log(`wrote ${nLines} log records for ${session.claudeSessionId}`);

    // ── 1. the HTTP series ────────────────────────────────────────────────
    const doc = await fetch(`${base}/api/context?id=${session.id}`).then((r) => (r.ok ? r.json() : null));
    if (!doc) {
      check(false, "GET /api/context did not find the session's log — a 404 here reads as 'no history'");
    } else {
      // 12 + 1 (the duplicate collapsed) + 6. The synthetic wall turn is not a
      // reading and must not appear as a drop to zero.
      check(doc.samples.length === 19, `19 readings, duplicates collapsed and the wall excluded (got ${doc.samples.length})`);
      check(doc.samples.every((s) => s.tok > 0), "no reading is zero — the rejection turn was not plotted");
      check(doc.samples.every((s, i) => i === 0 || s.t >= doc.samples[i - 1].t), "readings come out in time order");
      // 20_000 + 11*14_000 = 174_000, the peak before the compaction.
      check(Math.max(...doc.samples.map((s) => s.tok)) === 174_000, "the peak is the sum of the three usage fields, not the output");

      const kinds = doc.events.map((e) => e.kind);
      check(kinds.join(",") === "compact,limit", `both event kinds, in time order (got ${kinds.join(",") || "none"})`);
      const c = doc.events.find((e) => e.kind === "compact");
      check(c?.trigger === "auto" && c.preTok === 182_000 && c.postTok === 9_000, "the compaction carries both sides of the drop");
      const l = doc.events.find((e) => e.kind === "limit");
      check(Math.abs((l?.resetAt ?? 0) - (T0 + 18 * 60_000)) < 1000, "the wall carries the reset as an INSTANT, seconds scaled to ms");
      check(l?.weekly !== true, "a five-hour wall is not marked weekly");

      // What the first request carried, anchored on that request's own tokens.
      const car = doc.carried;
      check(car?.firstRequestTok === 20_000, `carried is anchored on the first request's tokens (got ${car?.firstRequestTok})`);
      check(car?.parts?.map((p) => p.kind).join(",") === "instructions,skill_listing",
        `the parts logged before it, in display order (got ${car?.parts?.map((p) => p.kind).join(",")})`);
      check(car?.parts?.[0]?.chars === 4_000 && car?.parts?.[1]?.count === 2, "each part's chars and count are the record's");
      check(car?.laterDeltas === 1, `a delta after the first request is counted, not folded in (got ${car?.laterDeltas})`);

      // The window — the whole reason every graph shares one y axis.
      // The series peaked at 174k, inside the default window, so the id rule
      // and the measurement agree and either source is a correct answer.
      check(doc.windowFrom === "measured" || doc.windowFrom === "model",
        `the window is resolved, not absent (got ${doc.windowFrom})`);
      check(doc.model === MODEL, `...and the graph can name it (got ${doc.model})`);
      check(doc.windowTok === contextWindowFor(MODEL), `...and it is ${contextWindowFor(MODEL)} (got ${doc.windowTok})`);
      check(doc.autoCompactTok === 182_000, "the observed auto-compact point is a measurement, kept apart from the window");
      check(doc.truncated === false, "a small log is not reported truncated");

      // The spend curve's own series. It is only worth stacking under the
      // context chart if it ends where the same parse says the conversation
      // ended — anything derived from the readings would end LOW, because the
      // total counts requests the readings skip.
      check(doc.samples.every((s) => typeof s.used === "number"),
        "every reading carries the running total beside it");
      check(doc.samples.every((s, i) => i === 0 || s.used > doc.samples[i - 1].used),
        "the running total only ever rises — a compaction cuts the reading, never the bill");
      const lastUsed = doc.samples[doc.samples.length - 1].used;
      check(lastUsed === doc.usageTok - (doc.agentTok ?? 0),
        `the curve ends at the total minus the subagents, which have no clock (got ${lastUsed})`);

      // ── the split: the total is never published without it ──────────────
      // 96% of a token count is cache reads, so a bare total is out by two
      // orders of magnitude on "what I sent". The invariant that lets both
      // screens print it is that the split is the SAME pass over the SAME
      // records — one number, two shapes, never two tallies.
      const sum = (t) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);
      check(!!doc.split, "the series carries what those tokens WERE, not just how many");
      check(sum(doc.split) + sum(doc.agentSplit) === doc.usageTok,
        `the split accounts for the total exactly (${sum(doc.split)} + ${sum(doc.agentSplit)} vs ${doc.usageTok})`);
      check(doc.split.turns >= (doc.turns ?? 0),
        `split.turns counts REQUESTS, so it is never below the prompts the outline lists (${doc.split.turns} vs ${doc.turns})`);
      check(doc.split.cacheRead > doc.split.input,
        "the fixture's own shape: a conversation is mostly re-read, which is the whole point of showing the split");

      // ── and what those tokens COST ──────────────────────────────────────
      // The figure the launcher row prints. Every turn in this fixture ran one
      // model, so the whole conversation's cost is `costOf(split)` exactly —
      // which is the check worth making over the wire, because it is the one
      // that fails if anything in the chain picks a different rate, a different
      // day or a different set of records than the split it sits beside.
      check(!!doc.cost, "the series carries what those tokens would have cost");
      const wantCost = costOf(doc.split, MODEL).total;
      check(Math.abs(doc.cost.total - wantCost) < 1e-9,
        `priced off the same records as the split (${doc.cost.total} vs ${wantCost})`);
      check(Math.abs(doc.cost.total - (doc.cost.input + doc.cost.output + doc.cost.cacheRead + doc.cost.cacheWrite)) < 1e-9,
        "the breakdown adds up to its own total");
      check(Math.abs(doc.agentCost.total - costOf(doc.agentSplit, MODEL).total) < 1e-9,
        `the agents are priced the same way, out of their own logs (got ${doc.agentCost?.total})`);
      check(doc.unpricedTok === undefined,
        `every model in this fixture has a published rate, so nothing is unpriced (got ${doc.unpricedTok})`);
      // The shape the whole cost feature rests on: cache reads are most of the
      // tokens and they are NOT most of the money.
      check(doc.cost.cacheRead < doc.cost.total && doc.split.cacheRead > doc.split.input * 100,
        "96% of the tokens, nothing like 96% of the bill");

      // ── what compacting shed, saved and cost ────────────────────────────
      // The ledger is the one figure on this screen that is a counterfactual
      // about requests that DID happen, so what is pinned here is that it is
      // counted per request and not per compaction — the difference between
      // "173k" and "1.2M" on the same conversation.
      const led = doc.compaction;
      check(!!led, "the series carries the compaction ledger");
      check(led.auto.count === 1 && led.manual.count === 0 && led.unmeasured === 0,
        `one automatic compaction and nobody typed /compact (got ${JSON.stringify(led)})`);
      check(led.auto.shedTok === 182_000 - 9_000,
        `the shed is both sides of the drop (got ${led.auto.shedTok})`);
      const since = doc.samples.filter((sm) => sm.t > T0 + 12 * 60_000).length;
      check(since > 1 && led.auto.savedTok === led.auto.shedTok * since,
        `the saving is the shed × each of the ${since} requests since (got ${led.auto.savedTok})`);
      const wantSaved = costOf(
        { input: 0, output: 0, cacheRead: led.auto.savedTok, cacheWrite: 0, cacheWrite1h: 0 }, MODEL,
      ).total;
      check(Math.abs(led.auto.savedUsd - wantSaved) < 1e-9,
        `…priced as cache reads on the model that ran it (${led.auto.savedUsd} vs ${wantSaved})`);
      check(led.auto.rebuildTok > 0 && led.auto.rebuildTok < led.auto.shedTok,
        `the rebuild is ONE request's cache write, not the window again (got ${led.auto.rebuildTok})`);
      check(led.manual.savedTok === 0 && led.manual.savedUsd === undefined,
        "a trigger that never ran carries no money at all, not $0");

      // ── what every reading was MADE OF, and what ran it ─────────────────
      // The two stacked charts rest on these. Both are per-sample and both can
      // be silently wrong: a stack that does not add up to the line it sits
      // inside, and an index pointing at the model that used to be in that slot.
      check(doc.samples.every((sm) => Array.isArray(sm.kinds) && sm.kinds.length === 4),
        "every reading carries its four kinds");
      check(doc.samples.every((sm) => sm.kinds[0] + sm.kinds[2] + sm.kinds[3] === sm.tok),
        "…and input + cache read + cache write IS the reading, exactly");
      check(doc.samples.every((sm) => sm.cum.reduce((n, v) => n + v, 0) === sm.used),
        "…and the cumulative tuple sums to the running total beside it");
      const rises = doc.samples.every((sm, i) => i === 0
        || [0, 1, 2, 3].every((k) => sm.cum[k] >= doc.samples[i - 1].cum[k]));
      check(rises, "…and every cumulative kind only ever rises");
      check(Array.isArray(doc.models) && doc.models.includes(MODEL),
        `the model table names what ran (got ${JSON.stringify(doc.models)})`);
      check(doc.samples.every((sm) => doc.models[sm.model] === MODEL),
        "…and every sample points at it");

      // ── the subagents, as dated events ──────────────────────────────────
      // Three agent logs in the fixture, two of them in one file.
      check(Array.isArray(doc.agents) && doc.agents.length === 2,
        `one row per agent LOG, not per turn (got ${doc.agents?.length})`);
      check(doc.agents.every((a) => a.at > 0 && a.endAt >= a.at),
        "every agent is a dated event with an end no earlier than its start");
      check(doc.agents.reduce((n, a) => n + a.tok, 0) === doc.agentTok,
        `the roster is the same tokens as the total, not a second tally (got ${doc.agents.reduce((n, a) => n + a.tok, 0)} vs ${doc.agentTok})`);
      check(doc.agents.every((a) => doc.models[a.model] === MODEL),
        "…and each names the model that ran it, in the same table the samples use");
      check(doc.agents.some((a) => a.type === "Explore"),
        `the task type comes off the agent's own meta file (got ${doc.agents.map((a) => a.type).join(",")})`);

      // ── 2. `since` → 204, so polling a quiet session costs a stat ────────
      const again = await fetch(`${base}/api/context?id=${session.id}&since=${doc.updatedAt}`);
      check(again.status === 204, `an unchanged log answers 204, not a re-parse (got ${again.status})`);
      const unknown = await fetch(`${base}/api/context?id=nosuchsession`);
      check(unknown.status === 404, `an unknown session is a 404, never an empty series (got ${unknown.status})`);
    }

    // ── 3. the row miniature, on the socket ───────────────────────────────
    // Refreshed on the once-a-turn context scan, so nudge the session and wait
    // for it to go idle rather than assuming it has already happened.
    ws.send(JSON.stringify({ t: "session.input", id: session.id, data: "hello\r" }));
    const got = await until(() => (session?.contextSpark?.pts?.length ?? 0) > 0, 25000);
    check(got, "the launcher row's miniature reaches the client on SessionInfo");
    if (got) {
      const sp = session.contextSpark;
      check(sp.pts.length <= 16, `at most sixteen readings ride on every SessionInfo (got ${sp.pts.length})`);
      check(sp.peak === 174_000, `the miniature knows the FULL series' peak, not its own (got ${sp.peak})`);
      check(sp.windowTok === contextWindowFor(MODEL) && sp.windowFrom !== "none",
        `...and the same window as the chart, so the two scales agree (got ${sp.windowTok}/${sp.windowFrom})`);
      check(sp.autoCompactTok === 182_000, "...and the observed compact point");
      check(sp.marks.length === 2 && sp.marks.every((m) => m.at >= 0 && m.at <= 1),
        `two ticks, each a fraction of the run (got ${JSON.stringify(sp.marks)})`);
      // The tick must sit ON the cliff: the reading at its index is higher than
      // the one after it. A tick beside the drop names the wrong turn.
      const cm = sp.marks.find((m) => m.kind === "compact");
      const idx = Math.round(cm.at * (sp.pts.length - 1));
      check(idx < sp.pts.length - 1 && sp.pts[idx] > sp.pts[idx + 1],
        `the compaction tick sits on the cliff (index ${idx} of ${sp.pts.join(",")})`);

      // ── what a turn in this session COSTS, on the same frame ─────────────
      // The cost chip's three inputs. They ride here rather than being derived
      // on the phone because the phone only ever sees `pts`, which is
      // downsampled — see `seriesCostFields`.
      // 12 climbing + 1 (the streaming duplicate, deduped) + 6 = 19 readings —
      // and 19 PROMPTS, which is where the count comes from. They agree here
      // only because this fixture runs no tools; that they are counted apart is
      // the point (`seriesCostFields`).
      check(sp.turns === 19, `the miniature says how many turns it summarises (got ${sp.turns})`);
      check(sp.baseTok === 20_000,
        `...and the session's FIRST reading, which is what a fresh session here costs (got ${sp.baseTok})`);
      // 12 terms 20k..174k, plus the deduped 12k, plus 6 terms 16k..61k.
      check(sp.spentTok === 1_407_000, `...and every reading summed (got ${sp.spentTok})`);
      // What the session has USED, which is a different question: the readings
      // plus the 400 output tokens of each of the 19 requests, plus three
      // subagent turns (600k of context + 1k output each) out of logs the curve
      // above never plots. 271k in the window against millions spent is the
      // real shape this exists for.
      check(sp.agentTok === 603_000, `...and what its subagents spent, out of their own logs (got ${sp.agentTok})`);
      check(sp.usageTok === 1_407_000 + 19 * 400 + 603_000,
        `...and the total, the two added exactly once (got ${sp.usageTok})`);

      // The chip the row actually prints — money, not a token count, and the
      // conversation's cost plus its agents' added exactly once.
      check(typeof sp.costUsd === "number" && sp.costUsd > 0,
        `the miniature carries what the session would have cost (got ${sp.costUsd})`);
      check(sp.agentCostUsd > 0 && sp.agentCostUsd < sp.costUsd,
        `...with the subagent share inside it (got ${sp.agentCostUsd} of ${sp.costUsd})`);
      check(sp.unpricedTok === undefined, `...and nothing left unpriced here (got ${sp.unpricedTok})`);
      check(costChip(sp.costUsd) === `$${sp.costUsd.toFixed(2)}`,
        `...which the row renders as money (got ${costChip(sp.costUsd)})`);

      const cost = sessionCostOf(sp);
      // Last reading 61k against a 20k baseline: 3.05x, which is `warm`. The
      // level has to come out of real wire bytes at least once — every other
      // test of it runs on a hand-built object.
      check(cost?.level === "warm", `the cost reading survives the wire (got ${cost?.level})`);
      check(cost?.chip === "3.1×", `...with the multiple it quotes (got ${cost?.chip})`);
      // 10, not 6: `breakEvenTurns` reads the ONE-HOUR write tier (2x input),
      // which is what 8,160 of 8,160 main-conversation cache writes on this
      // desktop actually are. At 1.25x this said 6 — about 65% low, i.e. it
      // nudged people out of a warm session a third of the way early.
      check(cost?.breakEven === 10, `...and the turn count that would be cheaper elsewhere (got ${cost?.breakEven})`);
      // The one rule the whole feature rests on.
      check(typeof cost?.note === "string" && !Object.values(cost).some((v) => typeof v === "boolean"),
        "a cost reading states facts and hands nobody a flag to refuse on");
      check(/used 2\.0M tokens so far — 603k of it in subagents/.test(cost?.note ?? ""),
        `...and says what the session has used, agents named (got ${cost?.note})`);
    }
  }
    // ── 4. a conversation that PROVES the id rule wrong ───────────────────
    // The bug this replaced: the CLI's log records the BASE id even for a 1M
    // conversation (`claude-opus-5` measured at 998,242 tokens on a real
    // machine), so an id-only table drew those sessions at five times their
    // real fullness. Rewriting the log past the default window has to move the
    // axis — and the source has to SAY it was measured, because that is the
    // only claim the chart can defend.
    {
      const dir = join(home, ".claude", "projects", repo.path.replace(/[^a-zA-Z0-9]/g, "-"));
      const lines = [];
      for (let i = 0; i < 8; i++) lines.push(turn(T0 + (40 + i) * 60_000, `d${i}`, 300_000 + i * 40_000));
      writeFileSync(join(dir, session.claudeSessionId + ".jsonl"), lines.join("\n") + "\n");
      const big = await fetch(`${base}/api/context?id=${session.id}`).then((r) => (r.ok ? r.json() : null));
      check(big?.windowFrom === "measured", `a conversation past the default window is MEASURED (got ${big?.windowFrom})`);
      check(big?.windowTok === windowContaining(580_000),
        `...and snapped to a real window, not to its own peak (got ${big?.windowTok})`);
      check(Math.max(...(big?.samples ?? [{ tok: 0 }]).map((s) => s.tok)) <= big?.windowTok,
        "...which contains every reading, so nothing is drawn over 100%");
      // The graph read above ADVANCED the session's shared cursor to the new
      // log. The sweep used to judge "nothing moved" off that cursor, so the
      // header's spark (and its Σ cost) stayed on the old conversation for as
      // long as anyone kept the graph open — $3.42 under a $6.34 prompt.
      const caught = await until(() => session?.contextSpark?.peak === 580_000, 8000);
      check(caught, `a graph read does not freeze the header's miniature (peak ${session?.contextSpark?.peak})`);
    }

    // ── 5. a session that never goes quiet still draws ────────────────────
    // The miniature was rebuilt on the turn boundary and on a sweep that
    // skipped anything younger than IDLE_PING_MS — i.e. only when a session
    // went quiet. A session mid-turn, spinner repainting every frame, was
    // therefore never refreshed at all, so a NEW session's row carried no
    // curve for the whole of its first turn: blank on exactly the session
    // whose context is moving fastest. The log is what the miniature is read
    // off, and the log does not care whether the screen is settling, so the
    // sweep now refreshes it regardless.
    if (session?.claudeSessionId) {
      const aId = session.id;              // captured: the handler above
      let b = null;                        // reassigns `session` on any create
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "session.created" && m.session.id !== aId) b = m.session;
        if (m.t === "session.updated" && b && m.session.id === b.id) b = m.session;
      });
      ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "ctx · busy", cols: 80, rows: 24 }));
      const born = await until(() => !!b?.claudeSessionId, 12000);
      if (!born) {
        check(false, "the second session never published a conversation id");
      } else {
        // One keystroke every 400 ms into `repaint` mode is kilobytes of churn
        // three times per IDLE_PING_MS window, so this session is never quiet
        // and never idle — the shape a long turn has. The churn starts BEFORE
        // the log exists, so a spark can only have come from the sweep.
        const poke = setInterval(() => ws.send(JSON.stringify({ t: "session.input", id: b.id, data: "x" })), 400);
        await sleep(600);
        writeConversation(home, repo.path, b.claudeSessionId);
        let busyWhenDrawn = null;
        const drew = await until(() => {
          if (!(b?.contextSpark?.pts?.length > 0)) return false;
          busyWhenDrawn = b.idle !== true;
          return true;
        }, 15000);
        clearInterval(poke);
        check(drew, "a session that never goes quiet still publishes its miniature");
        check(busyWhenDrawn === true,
          "...and it arrived while the session was still mid-churn, so it came off the sweep and not off a turn boundary");
      }
    }
} finally {
  try { ws.close(); } catch { /* already gone */ }
  host.kill();
  await sleep(300);
}

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
