/**
 * **How many of each dangerous thing the host has, and in which file.**
 *
 *     node --test tools/hostpins.test.mjs
 *
 * `hostshape.test.mjs` says where things may LIVE; this says how many there
 * ARE. The host's three big files are being cut into slices by copy-then-delete
 * moves (docs/notes/host-architecture.md), and the failure a move can make
 * without failing anything else is a DUPLICATE — a delivery, a PTY spawn, an
 * `acks.remember`, a `"updated"` emit left behind in the facade and also
 * written in the slice — or a DROP. Either is a behaviour change the phone sees
 * (a prompt typed twice, a missing `session.updated` frame) and neither is a
 * type error.
 *
 * So each is counted per file and `deepEqual`ed against a map. **A move edits
 * the map in the same commit**, and the diff of the map IS the review of the
 * move: `main.ts: 1` becoming `server/wsops.ts: 1` is a move; `main.ts: 1`
 * plus `server/wsops.ts: 1` is a copy.
 *
 * Same text discipline as `web/src/core/queue/queue.test.mjs`: `code()` strips
 * comments, `noImports()` strips import/re-export lists, definitions are taken
 * out by an explicit per-name regex (nothing cleverer, so any count here can be
 * reproduced with `grep -c`). `routes/types.ts` is `HostCtx` — interface
 * members only, with nested parentheses a regex exclusion gets wrong — so the
 * pins that would count its members skip it by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../packages/host/src/", import.meta.url).pathname;

/** Code, not prose. Crude on purpose (a `//` inside a string drops the rest of
 *  the line), which can only UNDER-count a line that also holds a URL. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
/** Import and re-export lists NAME a thing without doing it. */
const noImports = (c) => c
  .replace(/^\s*import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?/gm, "")
  .replace(/^\s*export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/gm, "");

const FILES = readdirSync(SRC, { recursive: true })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.split("\\").join("/"))
  .sort()
  .map((rel) => ({ rel, c: noImports(code(readFileSync(join(SRC, rel), "utf8"))) }));

const count = (c, re) => (re ? (c.match(re) ?? []).length : 0);
/** A definition of any of `names`: `function x(` or `private [async ]x(`. */
const defs = (...names) => new RegExp(`(?:\\bfunction |\\bprivate (?:async )?)(?:${names.join("|")})\\(`, "g");
/**
 * …and, for a method that is a `SessionCore` hub member, its arrow in the
 * facade's core literal (`  noteFor: (s, …) => this.noteFor(s, …),`) as well:
 * the arrow is a FORWARDER, one key plus one call, and exists for as long as
 * the method does. Taking out one per key leaves the forwarded call uncounted,
 * so the total is the real call sites before and after the method moves.
 * `sessions/core.ts` declares the member and is skipped by name (types only).
 */
const hubDefs = (...names) => new RegExp(`(?:\\bfunction |\\bprivate (?:async )?)(?:${names.join("|")})\\(|^\\s+(?:${names.join("|")}): \\(`, "gm");

// Scopes: the whole tree unless a pin says otherwise.
const ALL = () => true;
const INTENTS = (f) => f.startsWith("intents/");
const SESSIONS = (f) => f === "sessions.ts" || f.startsWith("sessions/");
const MAIN = (f) => f === "main.ts" || f.startsWith("server/");
const BIG3 = (f) => f === "sessions.ts" || f === "main.ts" || f === "intents/manager.ts";

/**
 * Every map is TODAY's (2026-09-25, before any move) and matches the table in
 * docs/notes/host-architecture.md, "Pins". `why` is the sentence a failure
 * prints under the diff. A package that moves a pinned site edits its map here
 * in the same commit (S2: the three spawns, `new-session` and one timeout went
 * to `sessions/tmux.ts`).
 */
const PINS = [
  {
    name: "deliveries (deliverPrompt / deliverToNewSession calls)",
    re: /\b(?:deliverPrompt|deliverToNewSession)\(/g, def: defs("deliverPrompt", "deliverToNewSession"),
    today: { "backlog/backlogsessions.ts": 1, "deliver.ts": 2, "fanout.ts": 3, "server/deliveries.ts": 4 },
    why: "a delivery copied is a prompt typed twice; one dropped is a prompt never typed",
  },
  {
    name: "chain / first prompt / compose (startPrompt / deliverChain / deliverInput calls)",
    re: /\b(?:startPrompt|deliverChain|deliverInput)\(/g, def: defs("startPrompt", "deliverChain", "deliverInput"),
    skip: ["routes/types.ts"],
    today: { "routes/session.ts": 2, "server/intentDeps.ts": 4 },
    why: "each of these types into a live session",
  },
  {
    name: "PTY spawns",
    re: /\bpty\.spawn\(/g,
    // sessions/tmux.ts: the tmux client of a new session and of a re-attach (the direct spawn went with the direct-PTY substrate).
    today: { "builds.ts": 1, "sessions/tmux.ts": 2, "usage.ts": 1 },
    why: "`register()` is the one PTY wiring there may be; a second spawn site is a second session lifecycle",
  },
  {
    name: "tmux new-session",
    re: /"new-session"/g,
    today: { "sessions/tmux.ts": 1 },
  },
  {
    name: "ack-ledger writes (acks.remember)",
    re: /\backs\.remember\(/g,
    // routes/session.ts 6 → 7: a phone's bare `/fork` opens a tab instead of being typed (`forkFromInput`).
    // 7 → 6: the checkbox Submit row's receipt goes through `answerReply` (in flight under its ackId, like every answer).
    today: { "routes/session.ts": 6, "routes/work/workbacklog.ts": 3, "server/wsops.ts": 2 },
    why: "at-most-once rests on each verdict being remembered exactly once",
  },
  {
    name: "durable ops (durableOp calls)",
    re: /\bdurableOp\(/g, def: defs("durableOp"),
    skip: ["routes/types.ts"],
    today: { "routes/index.ts": 1, "routes/work/workbacklog.ts": 1, "routes/work/workschedule.ts": 1 },
  },
  {
    name: "health observations, gated (noteFor calls)",
    re: /\bnoteFor\(/g, def: hubDefs("noteFor"), skip: ["sessions/core.ts"],
    // The hook pipe going live (`hook.pipe` good) moved turn.ts → sidechannel.ts with claude onto the sources seam (design §10).
    today: { "sessions/boxes.ts": 7, "sessions/health.ts": 2, "sessions/sidechannel.ts": 1, "sessions/turn.ts": 1, "sessions/wall.ts": 1 },
  },
  {
    name: "health observations, direct (noteHealth calls)",
    re: /\bnoteHealth\(/g, def: defs("noteHealth"),
    today: { "deliver/deliverrun.ts": 1, "sessions/health.ts": 1 },
    why: "the one in sessions/health.ts is INSIDE noteFor; a second direct call bypasses healthScope",
  },
  {
    name: "log health (noteLogHealth calls)",
    re: /\bnoteLogHealth\(/g, def: hubDefs("noteLogHealth"), skip: ["sessions/core.ts"],
    today: { "sessions/record.ts": 2 },
  },
  {
    name: "context health (noteContextHealth calls)",
    re: /\bnoteContextHealth\(/g, def: hubDefs("noteContextHealth"), skip: ["sessions/core.ts"],
    today: { "sessions/ctxseries.ts": 1 },
  },
  {
    name: "hook registration (hookSettingsArg calls)",
    re: /\bhookSettingsArg\(/g, def: defs("hookSettingsArg"),
    today: { "backends/claude.ts": 1 },
  },
  {
    name: "hook ingress (onHookEvent calls)",
    // Not calls: the method header in the facade (a one-line delegation too), the
    // forwarder inside that delegation, and `function onHookEvent(` in the slice.
    re: /\bonHookEvent\(/g, def: /^\s{2}onHookEvent\(|\{ turn\.onHookEvent\(this\.core,|\bfunction onHookEvent\(/gm,
    today: { "routes/apisystem.ts": 1 },
  },
  {
    name: "intervals (setInterval)",
    re: /\bsetInterval\(/g,
    // +1 main.ts (2026-10-21): the MagicDNS name is re-read until known (origin fallback, S1).
    // +1 sessions/sidechannel.ts (2026-10-22): a source turn's end re-asks for a fresh context sample (≤1.5 s).
    today: {
      "intents/manager.ts": 1, "localrt.ts": 1, "main.ts": 2, "opendeliveries.ts": 1,
      "server/billingwire.ts": 1, "server/sessionEvents.ts": 1, "server/wsops.ts": 1, "sessions.ts": 1, "sessions/sidechannel.ts": 2, "setupwatch.ts": 1, "healthwatch.ts": 1, "diskwatch.ts": 1, "update.ts": 3, "usage.ts": 3, "usagesources.ts": 1,
    },
    why: "an interval left in the facade AND its slice ticks twice",
  },
  {
    name: "timeouts in the three files and their slices (setTimeout)",
    re: /\bsetTimeout\(/g,
    scope: (f) => BIG3(f) || f.startsWith("sessions/") || f.startsWith("server/") || INTENTS(f),
    // server/clients.ts: the one-second grace before a distrusted socket is `terminate()`d (2026-10-22 security pass).
    today: { "main.ts": 2, "server/clients.ts": 1, "server/http.ts": 1, "sessions/boxes.ts": 3, "sessions/convid.ts": 4, "sessions/drive.ts": 1, "sessions/idlewatch.ts": 1, "sessions/links.ts": 1, "sessions/livemode.ts": 1, "sessions/resume.ts": 3, "sessions/sidechannel.ts": 1, "sessions/tmux.ts": 1, "sessions/turn.ts": 2, "sessions/wall.ts": 3 },
  },
  {
    name: "summary spends (runSummaryTask calls)",
    re: /\brunSummaryTask\(/g, def: defs("runSummaryTask"),
    today: { "sessions/record.ts": 1 },
    why: "each is a paid unattended model call — the tab name's `askName` is the only one left",
  },
  {
    name: "intent state writes, assignment (.state =)",
    re: /\.state\s*=\s*(?!=)/g, scope: INTENTS,
    today: { "intents/clock.ts": 2, "intents/fire.ts": 8, "intents/ladder.ts": 1, "intents/requeue.ts": 1, "intents/watch.ts": 9, "intents/write.ts": 1 },
  },
  {
    name: "intent state writes, literal (state: \"queued\")",
    re: /\bstate:\s*"queued"/g, scope: INTENTS,
    today: { "intents/contract.ts": 1, "intents/disk.ts": 2, "intents/write.ts": 3 },
  },
  {
    name: "intent settle calls",
    re: /\b(?:this|core)\.settle\(/g, def: /^\s+settle: \([^\n]*=> this\.settle\(/gm, scope: INTENTS,
    today: { "intents/fire.ts": 3, "intents/ladder.ts": 1, "intents/requeue.ts": 2, "intents/watch.ts": 3 },
  },
  {
    name: "intent block calls",
    re: /\b(?:this|core)\.block\(/g, scope: INTENTS,
    // 3: `nonGo`, the sweep pool's `serial` and `localModel` (the model-load hold).
    // `picking` went with the smart pick (2026-10-16).
    today: { "intents/ladder.ts": 3 },
  },
  {
    name: "intents persist",
    re: /\b(?:this|core)\.persist\(\)/g, scope: INTENTS,
    today: { "intents/clock.ts": 2, "intents/disk.ts": 5, "intents/fire.ts": 10, "intents/ladder.ts": 3, "intents/requeue.ts": 5, "intents/watch.ts": 6, "intents/write.ts": 5 },
  },
  {
    name: "intents archive",
    re: /\b(?:this|core)\.archive\(/g, scope: INTENTS,
    today: { "intents/disk.ts": 1, "intents/requeue.ts": 1 },
  },
  {
    name: "intents emits",
    re: /\b(?:this|core)\.emit\(\s*"/g, scope: INTENTS,
    today: { "intents/fire.ts": 6, "intents/watch.ts": 3 },
  },
  {
    name: "sessions emits",
    // roster.ts 11 → 13 (2026-10-21, R-conversations-007): `bookmarkChanged` re-sends a live
    // session's `updated` and the closed stack when its conversation's bookmark moves.
    // boxes.ts 6 → 7 (2026-10-21, backend v2 WP4): a typed answer the CLI never closed puts
    // `prompt.answerNote` on the box and re-sends `updated` once.
    re: /\b(?:this|core)\.emit\(\s*"/g, scope: SESSIONS,
    today: { "sessions.ts": 9, "sessions/boxes.ts": 7, "sessions/budgetwatch.ts": 4, "sessions/convid.ts": 5, "sessions/drive.ts": 3, "sessions/idlewatch.ts": 1, "sessions/links.ts": 1, "sessions/livemode.ts": 2, "sessions/record.ts": 6, "sessions/ctxseries.ts": 2, "sessions/resume.ts": 6, "sessions/roster.ts": 13, "sessions/sidechannel.ts": 2, "sessions/turn.ts": 11, "sessions/wall.ts": 18 },
    // turn.ts 10 → 11: `setCliSuggestion` is a NEW fact (the CLI's next-prompt proposal), its own emit, not a copy.
    // claude onto the sources seam (design §10): the pipe-live emit moved turn.ts → sidechannel.ts, and
    // UserPromptSubmit's idle-clear emit was the SAME line as `sourceTurn`'s started edge — one path now, one site.
    why: "an emit doubled or dropped is a session.updated frame the phone gets twice or never",
  },
  {
    name: "main's subscriptions (sessions.on)",
    re: /\bsessions\.on\(\s*"/g, scope: MAIN,
    today: { "server/sessionEvents.ts": 21 }, // +2 (2026-10-21): agentwatch.ts's `updated` and `exit`
    why: "a listener registered twice runs twice",
  },
  {
    name: "main's subscriptions (intents.on)",
    re: /\bintents\.on\(\s*"/g, scope: MAIN,
    today: { "server/intentEvents.ts": 4 },
  },
  {
    name: "main's subscriptions (process.on)",
    re: /\bprocess\.on\(/g, scope: MAIN,
    today: { "server/shutdown.ts": 3 },
  },
  {
    name: "main's other subscriptions (autopull / builds / capture / openDeliveries .on)",
    re: /\b(?:autopull|builds|capture|openDeliveries)\.on\(\s*"/g, scope: MAIN,
    today: { "main.ts": 2, "server/deliveries.ts": 1, "server/scan.ts": 1 },
  },
  {
    name: "notifications (notify calls)",
    // `ctx.notify(` as well: a `server/` factory reaches notify through the
    // record (`server/ctx.ts`), and a move must not make its calls invisible.
    re: /(?<![.\w])(?:ctx\.)?notify\(/g, def: defs("notify"), scope: MAIN,
    // +2 (2026-10-08): a store whose writes stopped reaching the disk is TOLD — the ack
    // ledger's `onWriteError` (main.ts) and the intent store's (server/intentDeps.ts).
    // −1 (2026-10-16): the smart pick's *Backlog groomed* alert (main.ts) went with it.
    today: { "main.ts": 5, "server/billingwire.ts": 1, "server/deliveries.ts": 4, "server/intentDeps.ts": 1, "server/intentEvents.ts": 8, "server/scan.ts": 3, "server/sessionEvents.ts": 14 },
  },
  {
    name: "singleton registrations",
    // `installChecklistStores` installs `contextlimits.ts`'s and
    // `setupprefs.ts`'s stores in one call, as `installSessionModels` does.
    re: /\b(?:setCliHealth|setOpenDeliveries|setSentLog|installChecklistStores|installSessionModels)\(/g,
    def: defs("setCliHealth", "setOpenDeliveries", "setSentLog", "installChecklistStores", "installSessionModels"),
    today: { "main.ts": 5 },
  },
  {
    name: "env file loads (loadEnvFiles)",
    re: /\bloadEnvFiles?\(/g,
    def: defs("loadEnvFiles"),
    today: { "env.ts": 1 },
    why: "env.ts is main.ts's FIRST import so every knob read at import sees the files; a second load is a second precedence order",
  },
];

/** `{ file: n }` for one pin, files with 0 left out. */
function measure(pin) {
  const out = {};
  for (const { rel, c } of FILES) {
    if (!(pin.scope ?? ALL)(rel) || pin.skip?.includes(rel)) continue;
    const n = count(c, pin.re) - count(c, pin.def);
    if (n) out[rel] = n;
  }
  return out;
}

for (const pin of PINS) {
  test(`pin: ${pin.name}`, () => {
    const got = measure(pin);
    const changed = [...new Set([...Object.keys(got), ...Object.keys(pin.today)])].sort()
      .filter((f) => got[f] !== pin.today[f])
      .map((f) => `${f}: expected ${pin.today[f] ?? 0}, found ${got[f] ?? 0}`);
    assert.deepEqual(
      got, pin.today,
      `${pin.name} changed — ${changed.join("; ")}.\n` +
      (pin.why ? `(${pin.why}.)\n` : "") +
      `If this is a MOVE, a move edits this map in the same commit (tools/hostpins.test.mjs) and the\n` +
      `total stays the same; a count that grew or shrank is a copy left behind or a site dropped.`,
    );
  });
}

/**
 * ORDER, where order is behaviour. A count says a listener or a flush is there
 * once; it cannot see two of them swap. `sessions.on` handlers run in
 * registration order, and several share an event (three `"exit"`s: the one
 * registered first sees the session before the later ones tear its state
 * down); the SIGTERM flush writes the ack ledger FIRST because that is the
 * record a restart's retry reads. Each list is TODAY's, read off the file.
 * Reordering is a behaviour change: edit the list in the same commit and say
 * so in it.
 */
const ORDERED = [
  {
    name: "sessions.on registration order (server/sessionEvents.ts)",
    file: "server/sessionEvents.ts", re: /\bsessions\.on\(\s*"(\w+)"/g,
    today: ["turnEnded", "exit", "updateBanner", "data", "exit", "closed", "updated", "followUp", "history", "created", "exit", "awaiting", "prompt", "limitQueue", "limit", "idle", "budgetTripped", "budgetEscDue", "updated", "exit", "created"],
  },
  {
    name: "intents.on registration order (server/intentEvents.ts)",
    file: "server/intentEvents.ts", re: /\bintents\.on\(\s*"(\w+)"/g,
    today: ["settled", "requeued", "skipped", "missed"],
  },
  {
    name: "SIGTERM/SIGINT flush order (server/shutdown.ts)",
    file: "server/shutdown.ts", re: /\bctx\.(\w+)\.flush\w*\(/g,
    today: ["acks", "cliHealthStore", "sentLogStore", "installLog", "netstats", "sessions", "tokenStats", "usageLog", "usageSources", "settings", "openDeliveries", "intents"],
  },
];

for (const pin of ORDERED) {
  test(`order: ${pin.name}`, () => {
    const c = FILES.find((f) => f.rel === pin.file)?.c ?? "";
    const got = [...c.matchAll(pin.re)].map((m) => m[1]);
    assert.deepEqual(
      got, pin.today,
      `${pin.name} changed. Order here is behaviour — a listener that ran first now runs later, or a\n` +
      `store is flushed after the one that depended on it. If that is intended, edit the list in\n` +
      `tools/hostpins.test.mjs in the same commit and name the change in the commit message.`,
    );
  });
}
