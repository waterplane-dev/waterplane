/**
 * **One place a `session.create` can be built, pinned as a fact about the
 * source rather than a sentence in a comment.**
 *
 *     node --test packages/web/src/createOp.test.mjs
 *
 * The rule "every `session.create` goes through `launchFor()`" was written in
 * three separate comments — `App.tsx`'s `wireLaunch`, the settings picker, and
 * `docs/notes/web.md` — and was true at three of the five call sites. The two
 * that opted out were the worktree start-point row and `startSessionWithPrompt`
 * (the Start sheet: the primary way work is composed with the link DOWN), and
 * both sent the raw persisted `launch`.
 *
 * What that costs, concretely: `launch` is persisted AND synced, so a `backend`
 * plus the `provider/model` string picked beside it lands in another phone's
 * localStorage. Point that phone at a desktop that predates backends — no
 * `backends` frame, so the picker is correctly ABSENT and this user never chose
 * anything — and the create goes out carrying `backend: "opencode"`,
 * `model: "ollama/qwen3-coder:30b"`. The old host drops the field it does not
 * know and spawns `claude --model ollama/qwen3-coder:30b`. That is the exact
 * spawn the picker gate exists to prevent, reached around the side of it.
 *
 * So this test does not read behaviour, it reads the FILE: a sixth create site
 * written by hand fails here, at `npm run test:unit`, naming the rule. A
 * comment could not do that — the reviewer found this precisely because a
 * comment already claimed it was true.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The create path's source: `App.tsx`, every file under the core modules that
 * build or queue ops (`core/launch`, `core/launcher`, `core/session`,
 * `core/send`, `core/queue`) and every feature (`features/**`, recursive) —
 * one string, so a count is a count across all of them and a copy left
 * behind in App by a move is two sites, not one. A feature reaches `queueOp`
 * with a `DurableOp` of its own (`fanout.run` carries a launch; the images
 * feature and the archive call `openCwd`), so a check that stops at core would
 * miss exactly the sites the feature split made easy to add. `where(i)` names
 * the file and line an index in it came from.
 */
function tsUnder(d) {
  const dir = fileURLToPath(new URL(`./${d}/`, import.meta.url));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).sort()
    .map((f) => `${d}/${f.split("\\").join("/")}`);
}
const FILES = ["App.tsx", ...["core/launch", "core/launcher", "core/session", "core/send", "core/queue", "features"].flatMap(tsUnder)]
  .map((rel) => ({ rel, text: readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), "utf8") }));
const STARTS = [];
{ let o = 0; for (const f of FILES) { STARTS.push(o); o += f.text.length + 1; } }
const SRC = FILES.map((f) => f.text).join("\n");
/** The file an index into SRC falls in. */
function fileAt(i) {
  let k = 0;
  while (k + 1 < STARTS.length && STARTS[k + 1] <= i) k++;
  return { rel: FILES[k].rel, start: STARTS[k] };
}
/** `file:line` for an index into SRC. */
function where(i) {
  const f = fileAt(i);
  return `${f.rel}:${SRC.slice(f.start, i).split("\n").length}`;
}

/** Where `createOp`'s body starts and ends — the brace-matched function, so
 *  "inside the helper" is a real containment check and not a line range that
 *  drifts the first time something above it grows. */
function createOpBody() {
  const at = SRC.indexOf("function createOp(");
  assert.notEqual(at, -1, "neither App.tsx nor core/launch defines `createOp` — the single create constructor");
  const open = SRC.indexOf("{", SRC.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(open, i + 1);
  }
  throw new Error("unbalanced braces in createOp");
}

test("exactly one place (App.tsx, core/, features/) builds a session.create, and it is createOp", () => {
  // A construction always writes the discriminant as a PROPERTY with a value
  // after it. The type positions (`Extract<ClientMessage, { t: "session.create"
  // | … }>`, the two `op as (DurableOp & { t: "session.create" })` casts) never
  // have the trailing comma, so they are not swept up here.
  const sites = [...SRC.matchAll(/t:\s*"session\.create"\s*,/g)];
  assert.equal(
    sites.length, 1,
    `a session.create is built ${sites.length} times across App.tsx, core/ and features/. Build it with createOp(), which is ` +
    "the one place launch reaches the wire through wireLaunch/launchFor — two hand-written sites " +
    "shipped a synced backend to a host that had never heard of one.",
  );
  const body = createOpBody();
  assert.ok(body.includes('t: "session.create"'), "the one construction is not inside createOp");
});

test("createOp puts launch through the wire gate, and cannot be handed a raw one", () => {
  const body = createOpBody();
  // The gate itself. `wireLaunch` is `launchFor(o, backends)` — strip the
  // backend an old host never described, and any flag this one has no concept
  // of. If this call ever leaves the helper, every create site loses it at once.
  assert.match(body, /wireLaunch\(/, "createOp no longer applies wireLaunch — every create site loses the gate");
  // …and it is the ONLY thing that writes `launch` into the op: destructuring
  // the caller's `launch` out first is what makes a raw one impossible to
  // smuggle through the rest spread.
  const destructure = /const\s*\{\s*launch:\s*\w+\s*,\s*\.\.\.\w+\s*\}\s*=\s*\w+\s*;?/;
  assert.match(body, destructure,
    "createOp must pull `launch` out of the caller's object, or `...rest` carries an ungated one");
  // Having pulled it out, the ONLY `launch` the helper writes back is the gated
  // one. Anything else here is the raw object arriving on the wire again.
  for (const m of body.replace(destructure, "").matchAll(/\blaunch\s*:\s*/g)) {
    assert.ok(
      body.replace(destructure, "").slice(m.index + m[0].length).startsWith("wireLaunch("),
      "createOp writes a `launch` that did not come from wireLaunch",
    );
  }
});

test("every queued op that carries launch opts routes it through the gate", () => {
  // `session.create` is not the only op that spawns a session: `fanout.run`
  // carries the same `launch` and starts N of them. Whatever hands `launch` to
  // `queueOp` hands over a gated one — a stale synced backend on a sweep is the
  // same wrong binary, N times.
  // The value may be a call (`wireLaunch(o)`, a feature's `c.launch.wire(o)`),
  // so it is read up to the next `,`/`}` rather than stopping at a paren —
  // which used to make every gated site invisible here, and a raw one the only
  // kind this loop could see.
  const checked = [];
  for (const m of SRC.matchAll(/\blaunch(?::\s*([^,}\n]*?))?\s*[,}]/g)) {
    const line = where(m.index);
    const value = (m[1] ?? "launch").trim();
    // Only the op literals matter; this sweep also sees state, props and types.
    // A `//` comment may sit between `queueOp(` and its literal (useSend's does).
    const ctx = SRC.slice(Math.max(0, m.index - 600), m.index);
    if (!/\bqueueOp\(\s*(?:\/\/[^\n]*\n\s*)*\{[^}]*$|\bcreateOp\(\s*\{[^}]*$/.test(ctx)) continue;
    checked.push(line);
    assert.ok(
      /^(?:wireLaunch\(|c\.launch\.wire\(|core\(\)\.launch\.wire\()/.test(value) || /\bcreateOp\(/.test(ctx),
      `${line} puts \`${value}\` on a queued op without wireLaunch()`,
    );
  }
  // Both sweeps that spawn N sessions (the Send sheet's and the fan-out
  // feature's) must be among what this loop read, or it has gone blind.
  assert.ok(checked.filter((l) => /fanout|useSend/.test(l)).length >= 2,
    `the launch sweep read only ${JSON.stringify(checked)} — the two fanout.run sites are not among them`);
});

/**
 * …and the same shape of failure, one layer up: the gate that asks WHICH
 * backend and model a fresh session runs.
 *
 * `myapp.launchAsk` shipped gating `openCwd` alone, because that is the function
 * whose name says "open a session". It is not the one the launcher's repo rows
 * call: `openRepo` and `startSessionWithPrompt` each build their own create,
 * carrying a toast about what is already opening in that repo and a prompt
 * chain with its `needs`. So the switch was on, the sheet existed, and the tap
 * people actually use started a session on the defaults without asking
 * anything. Exactly the "true at three of five call sites" failure this file was
 * written for, in a second place.
 *
 * Pinned the same way, for the same reason a comment could not: a fourth way to
 * start a fresh session fails here, by name, at `npm run test:unit`.
 */
const FRESH_STARTS = ["openCwd", "openRepo", "startSessionWithPrompt"];
/** Create sites that are NOT a fresh start, each with the reason it is exempt. */
const NOT_FRESH = {
  openRepoWith: "the rest of openRepo, which does the asking before this runs",
  runForkRequest: "fork/reset reopen THIS conversation on the flags it already ran with",
  // Attributed to the last `  function name(` above it in App — the model
  // sheet's entry in overlayViews follows whichever function ends the verbs.
  relaunch: "the relaunch inside the model sheet — it is handed an explicit launch",
};

/** The brace-matched body of a top-level method of the App component. */
function bodyOf(name) {
  const at = SRC.indexOf(`  function ${name}(`);
  assert.notEqual(at, -1, `neither App.tsx nor core/launch defines ${name}`);
  const open = SRC.indexOf("{", SRC.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("every way to start a FRESH session goes through the launch-ask gate", () => {
  for (const name of FRESH_STARTS) {
    assert.match(
      bodyOf(name), /askLaunchFirst\(/,
      `${name}() starts a session without asking first. The per-session ask is ` +
      "not openCwd's — it belongs to every fresh start, or the switch silently does nothing for the ones it misses.",
    );
  }
});

/**
 * …and the SECOND question that rides through the same seam.
 *
 * The hosted-model acknowledgement (`hostedAck.ts`) has to fire on exactly the
 * set of taps the launch-ask fires on: every fresh start, never a resume. Given
 * the history above, a second helper beside `askLaunchFirst` would be a second
 * list of start sites to keep in sync — the same failure, a third time. So it
 * goes through the one seam, and the seam needs one thing from every caller:
 * the launch it WOULD otherwise run. A start site that stops handing that over
 * silently un-gates itself — the ask still fires, the create still goes out, and
 * the first session that reads a private repo into somebody's server does it
 * with no sentence anywhere on the path.
 *
 * That failure is invisible in review (the call still compiles, `launch` is
 * merely optional) and invisible at runtime on a claude-only desktop, which is
 * every desktop the reviewer has. Hence by name, here.
 */
test("every fresh start hands the launch-ask seam the launch it would otherwise run", () => {
  for (const name of FRESH_STARTS) {
    const body = bodyOf(name);
    const at = body.indexOf("askLaunchFirst(");
    assert.notEqual(at, -1, `${name}() no longer calls askLaunchFirst`);
    // The second argument — the opts object literal, which has no nested braces
    // at any of these sites.
    const call = body.slice(at, at + 400);
    assert.match(
      call, /askLaunchFirst\([^,]+,\s*\{[^{}]*\blaunch\b[^{}]*\}/,
      `${name}() calls askLaunchFirst without passing \`launch\`. The seam gates a hosted model on ` +
      "the launch that is about to run; with nothing handed over there is nothing to check, and " +
      "this start site quietly stops showing the hosted-model notice.",
    );
  }
});

test("the seam still runs both questions, and the hosted one is a real check", () => {
  const seam = bodyOf("askLaunchFirst");
  // Twice: once wrapping the ANSWERED launch (openRepo's `run` goes to
  // openRepoWith and never re-enters this helper), once for the not-asked path.
  assert.ok(
    seam.split("hostedGate(").length - 1 >= 2,
    "askLaunchFirst must gate BOTH of its paths — the launch answered in the sheet and the one " +
    "the caller handed over. Gating only the second leaves the per-launch ask able to pick a " +
    "hosted model with no notice at all.",
  );
  assert.match(
    seam, /opts\.resume/,
    "a resume must skip the hosted gate — that conversation already sent its data, and the " +
    "acknowledgement is about the FIRST hosted launch.",
  );
  assert.match(
    bodyOf("hostedGate"), /needsHostedAck\(/,
    "hostedGate no longer asks `needsHostedAck` — that is the pure, node-tested decision that " +
    "refuses to read an unknown model as a hosted one.",
  );
});

test("no NEW create site appears without deciding whether it is a fresh start", () => {
  // Every `createOp(` in the file, attributed to the method it sits in. A new
  // one lands in neither list and fails here, which is the point: the decision
  // "does this ask?" is made once, deliberately, rather than by omission.
  const seen = new Set();
  for (const m of SRC.matchAll(/createOp\(/g)) {
    // Only this file's text: a method is never attributed across a file edge.
    const before = SRC.slice(fileAt(m.index).start, m.index);
    // The definition itself, not a call.
    if (/function\s+$/.test(before.slice(-12))) continue;
    const fns = [...before.matchAll(/\n {2}(?:async )?function (\w+)\(/g)];
    seen.add(fns.length ? fns[fns.length - 1][1] : "?");
  }
  for (const name of seen) {
    assert.ok(
      FRESH_STARTS.includes(name) || name in NOT_FRESH,
      `${name}() builds a session.create and is in neither list. If it starts a FRESH ` +
      "session it must call askLaunchFirst(); if it reopens one on flags already chosen, say so in NOT_FRESH.",
    );
  }
  // …and the known ones have not quietly moved or been renamed away.
  for (const name of FRESH_STARTS) {
    if (name === "openRepo") continue; // its create lives in openRepoWith
    assert.ok(seen.has(name), `${name}() no longer builds a create — has the start path moved?`);
  }
});

/**
 * …and the THIRD thing a create carries that only the call site knows: WHICH
 * conversation a reopen is reopening.
 *
 * `resumeSessionId` is one wire field, but the id that belongs in it lives in
 * one of two places on the row — `claudeSessionId` (claude's own uuid) or
 * `backendSessionId` (the backend's own id, opencode's `ses_…`). They are two
 * fields on purpose: every log reader in the daemon turns the first into a path
 * under `~/.claude/projects`, so an opencode id there is a reader pointed at a
 * file that will never exist.
 *
 * All four reopen/resume taps read `claudeSessionId` alone, which for an
 * opencode row is always absent — so every one of them fell through to the
 * directory's `--continue`, and with two closed conversations in one repo,
 * tapping the OLDER row carried on the NEWER one. Nothing on screen was wrong
 * except which conversation you were in, which is why it is pinned as a fact
 * about the SOURCE: a fifth reopen site, or a fourth one quietly going back to
 * a single field, fails here rather than on somebody's phone.
 */

/** Every `openCwd(...)` call in the file, with its balanced argument text. */
function openCwdCalls() {
  const out = [];
  for (const m of SRC.matchAll(/\bopenCwd\(/g)) {
    // The definition, not a call.
    if (/function\s+$/.test(SRC.slice(0, m.index).slice(-12))) continue;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < SRC.length; i++) {
      if (SRC[i] === "(") depth++;
      else if (SRC[i] === ")" && --depth === 0) {
        out.push({ line: where(m.index), args: SRC.slice(m.index + m[0].length, i) });
        break;
      }
    }
  }
  return out;
}

// `resumeIdOf` lives in sessionFacts.tsx (lifted out of App); the call sites
// it guards are still App's, which the next test reads.
const FACTS = readFileSync(fileURLToPath(new URL("./sessionFacts.tsx", import.meta.url)), "utf8");

test("resumeIdOf is the one reader, and it reads BOTH id fields", () => {
  const at = FACTS.indexOf("function resumeIdOf(");
  assert.notEqual(at, -1,
    "sessionFacts.tsx no longer defines `resumeIdOf` — the one place a row is asked which conversation it is");
  const body = FACTS.slice(at, FACTS.indexOf("\n}", at));
  for (const field of ["claudeSessionId", "backendSessionId"]) {
    assert.ok(body.includes(field),
      `resumeIdOf no longer reads \`${field}\`. Both are the same question asked of a different ` +
      "binary's row; dropping either makes every reopen of that backend's conversations approximate.");
  }
});

test("every reopen/resume tap passes the row's id through resumeIdOf", () => {
  const calls = openCwdCalls();
  // Not "every resume call names resumeIdOf": the ARCHIVE's two verbs are handed
  // a conversation uuid by the sheet itself (every row there is a claude log on
  // disk, which is why they also force `backend: undefined`), so there is no row
  // with two id fields for them to choose between. What no site may do is read
  // one of the two fields, which is what makes a reopen exact for claude and
  // approximate for everything else.
  for (const c of calls) {
    assert.doesNotMatch(
      c.args, /\.(claudeSessionId|backendSessionId)\b/,
      `${c.line} reads a conversation-id field directly. Which of the two carries the id ` +
      "depends on which binary wrote the row, and a single-field read silently resumes the wrong " +
      "conversation for the other one. Go through resumeIdOf().",
    );
  }
  const viaReader = calls.filter((c) => /resumeIdOf\(/.test(c.args));
  assert.ok(viaReader.length >= 4,
    `only ${viaReader.length} reopen sites go through resumeIdOf — the launcher's closed rows, its ` +
    "recent rows, the hidden recent rows and the ended-session overlay are four, and a reopen that " +
    "names no id at all is the directory's `--continue`, landing wherever the binary likes.");
});

test("a row that cannot be reopened exactly SAYS so, on the row", () => {
  // The sentence is `capReason`'s own (`resumePick`) and it belonged on the
  // reopen row all along: in the cants strip of an open session it arrives
  // after the decision it describes has already been made, on another screen.
  const at = SRC.indexOf("const reopenCant = (");
  assert.notEqual(at, -1,
    "neither App.tsx nor core/ defines `reopenCant` — the row's own sentence about an approximate reopen");
  const body = SRC.slice(at, SRC.indexOf("\n  };", at));
  assert.match(body, /resumeIdOf\(/,
    "reopenCant must stay silent for a row that HAS an id: that reopen is exact, and a warning " +
    "about the folder's conversation would be false.");
  assert.match(body, /capReason\([^)]*"resumePick"\)/,
    "the sentence must come from `capReason` — worded once, in `backendCaps.ts`, so the absent " +
    "picker and the inexact reopen cannot say two different things.");
  // …and it is actually rendered, on both lists of reopenable rows.
  assert.ok(
    SRC.split("{reopenCant(").length - 1 >= 2,
    "reopenCant is defined but drawn on fewer than two row kinds — 'Recently closed' and " +
    "'Resume recent' are both places the reopen decision is made.",
  );
});

test("no reopen title asserts a command the row may not run", () => {
  // These titles read "claude --resume" / "claude --continue" on every row,
  // including rows running another binary entirely — whose host-side flag is
  // `--session <id>`. The wording follows the EFFECT instead (`resumeHint`),
  // rather than putting a second copy of the host's argv table on the phone.
  for (const m of SRC.matchAll(/title=\{?[^}\n]*claude --(?:resume|continue)/g)) {
    assert.fail(
      `${where(m.index)} names a claude command in a row title. ` +
      "Say what the tap DOES (`resumeHint`) — the row may be running something else.",
    );
  }
});
