/**
 * The hook contract, checked from BOTH sides against the REAL CLI.
 *
 * The stub (`scripts/claude-stub-tui.mjs`, behind every e2e) posts hook
 * payloads; the host (`backends/claude-sources.ts`, `sessions/turn.ts`)
 * consumes them. Each side was checked only against the other, so they could
 * agree on something the CLI never sends (436ef33c: the CLI sent `StopFailure`,
 * the stub sent `Stop`, every e2e passed, and network retries never fired).
 * The third party is the harvested corpus — `fixtures/screens/harvest-hook.pipe-*.json`,
 * the CLI's own payload skeletons. Every event and field either side uses
 * must be in it, or sit in ALLOWANCE below with a reason; an allowance whose
 * event has since been captured fails, so the list shrinks itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCREENS = join(HERE, "fixtures/screens");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** event -> Set of field names, unioned over every harvested hook.pipe capture. */
function corpus() {
  const out = new Map();
  for (const f of readdirSync(SCREENS).filter((n) => /^harvest-hook\.pipe-.*\.json$/.test(n))) {
    const p = JSON.parse(readFileSync(join(SCREENS, f), "utf8"));
    const ev = p.hook_event_name;
    if (typeof ev !== "string") continue;
    if (!out.has(ev)) out.set(ev, new Set());
    for (const k of Object.keys(p)) out.get(ev).add(k);
  }
  return out;
}

/**
 * Events (and the fields on them) that no capture holds yet. Each is a debt:
 * delete the entry when the corpus gains the event — the test below fails
 * until you do. `fields` omitted = every field of the event is covered.
 */
const ALLOWANCE = {
  StopFailure: "never captured: the host kept one hook.pipe capture per CLI version (the first hook), so the CLI's real StopFailure shape was never seen. Per-event capture fixes it; harvest it, then delete this line.",
  PreToolUse: "never captured: same one-capture-per-version reason as StopFailure.",
};

// ── Stub side ──────────────────────────────────────────────────────────

/** Source of `hook(` calls: [{ event, fields:Set }] plus the base fields every post carries. */
export function stubPosts(src) {
  const calls = [];
  const re = /(?<![\w.])hook\(\s*"(\w+)"/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1, args = "";
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === "(") depth++; else if (c === ")") depth--;
      if (depth > 0) args += c;
    }
    const fields = new Set();
    for (const f of args.matchAll(/[{,]\s*(\w+)\s*(?=[:,}])/g)) fields.add(f[1]);
    calls.push({ event: m[1], fields });
  }
  // The SessionStart post made directly at startup, outside hook().
  const direct = /JSON\.stringify\(\{\s*hook_event_name:\s*"(\w+)"([^\n]*)\}\)/.exec(src);
  const base = new Set(["hook_event_name"]);
  if (direct) {
    const f = new Set(["hook_event_name"]);
    for (const k of direct[2].matchAll(/,\s*(\w+)\s*(?=:)/g)) f.add(k[1]);
    if (/\.\.\.HOOK_SID/.test(direct[2])) f.add("session_id");
    calls.push({ event: direct[1], fields: f, direct: true });
  }
  const body = /body:\s*JSON\.stringify\(\{\s*hook_event_name,([^\n]*)\}\)/.exec(src);
  assert.ok(body, "the stub's hook() body is no longer found by the extractor");
  for (const k of body[1].matchAll(/(?:^|,)\s*(\w+)\s*(?=:)/g)) base.add(k[1]);
  if (/\.\.\.HOOK_SID/.test(body[1])) base.add("session_id");
  return { calls, base, total: (src.match(/(?<![\w.])hook\(/g) ?? []).length };
}

// ── Host side ──────────────────────────────────────────────────────────

/** What `postClaudeHook`'s switch reads per case — pinned to the source below. */
const SWITCH_READS = {
  SessionStart: ["session_id", "transcript_path"],
  UserPromptSubmit: ["prompt"],
  Stop: ["transcript_path"],
  StopFailure: ["error", "transcript_path"],
  SessionEnd: [],
};
/** What `sessions/turn.ts`'s `onHookEvent` reads off the payload for its own events. */
const TURN_READS = {
  PreToolUse: ["tool_name", "tool_input", "tool_use_id"],
  StopFailure: ["error"],
};

export function switchReads(src) {
  const start = src.indexOf("export function postClaudeHook");
  assert.ok(start > 0, "postClaudeHook not found");
  const body = src.slice(start);
  const sw = body.indexOf("switch (");
  const parts = body.slice(sw).split(/\n\s*case "(\w+)":/);
  const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    const chunk = parts[i + 1].split(/\n\s*default:|\n  }\n  return true/)[0];
    out[parts[i]] = [...new Set([...chunk.matchAll(/payload\.(\w+)/g)].map((x) => x[1]))].sort();
  }
  return out;
}

const sorted = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));

test("the extractors see every hook the stub posts and every case the host switches on", () => {
  const stub = stubPosts(read("scripts/claude-stub-tui.mjs"));
  // Every `hook(` call but the definition has a literal event name — a computed one would escape the check.
  assert.equal(stub.calls.filter((c) => !c.direct).length, stub.total - 1, "a hook() call with a non-literal event escapes the extractor");
  assert.ok(stub.calls.length >= 11, `expected the stub's >= 11 posts, found ${stub.calls.length}`);
  assert.deepEqual([...new Set(stub.calls.map((c) => c.event))].sort(), ["SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
  assert.deepEqual(sorted({ x: stub.base }).x, ["cwd", "hook_event_name", "session_id"]);
  assert.deepEqual(stub.calls.find((c) => c.event === "StopFailure").fields.has("error"), true);
  assert.deepEqual(stub.calls.find((c) => c.event === "UserPromptSubmit").fields.has("prompt"), true);
  // Host: the table is the source, not a copy of it.
  assert.deepEqual(switchReads(read("packages/host/src/backends/claude-sources.ts")), sorted(SWITCH_READS));
  const turn = read("packages/host/src/sessions/turn.ts");
  const turnFields = new Set([...turn.matchAll(/payload\.(error|tool_name|tool_input|tool_use_id)\b/g)].map((x) => x[1]));
  assert.deepEqual([...turnFields].sort(), [...new Set(Object.values(TURN_READS).flat())].sort(), "turn.ts reads a payload field the table does not know");
});

test("every event and field the stub sends or the host reads is in the real CLI's captures", () => {
  const real = corpus();
  assert.ok(real.size >= 5, "the corpus lost events");
  const stub = stubPosts(read("scripts/claude-stub-tui.mjs"));
  const used = new Map(); // event -> Map(field -> who)
  const use = (event, field, who) => {
    if (!used.has(event)) used.set(event, new Map());
    used.get(event).set(field, who);
  };
  for (const c of stub.calls) {
    use(c.event, "hook_event_name", "stub");
    for (const f of [...stub.base, ...c.fields]) use(c.event, f, "stub");
  }
  for (const [ev, fs] of Object.entries({ ...SWITCH_READS })) { use(ev, "hook_event_name", "host"); for (const f of fs) use(ev, f, "host"); }
  for (const [ev, fs] of Object.entries(TURN_READS)) { use(ev, "hook_event_name", "host"); for (const f of fs) use(ev, f, "host"); }

  const bad = [];
  for (const [ev, fields] of used) {
    if (ALLOWANCE[ev]) continue;
    if (!real.has(ev)) { bad.push(`event ${ev} is not in the real corpus (and not allowed)`); continue; }
    for (const [f, who] of fields) if (!real.get(ev).has(f)) bad.push(`${who} uses ${ev}.${f}; the real CLI's ${ev} has only ${[...real.get(ev)].join(", ")}`);
  }
  assert.deepEqual(bad, []);
});

test("an allowance for an event that is now captured is stale", () => {
  const real = corpus();
  for (const ev of Object.keys(ALLOWANCE)) assert.equal(real.has(ev), false, `${ev} is in the real corpus now: delete its ALLOWANCE line, so the contract covers it`);
});

test("every allowed event is still used by one side (an unused allowance is dead weight)", () => {
  const stub = stubPosts(read("scripts/claude-stub-tui.mjs"));
  const used = new Set([...stub.calls.map((c) => c.event), ...Object.keys(SWITCH_READS), ...Object.keys(TURN_READS)]);
  for (const ev of Object.keys(ALLOWANCE)) assert.ok(used.has(ev), `${ev} is allowed but nothing uses it`);
});
