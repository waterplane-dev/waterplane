/**
 * Forking a conversation log — fixture in, file out.
 *
 * `convfork.ts` is the one place in this app that writes a file the `claude`
 * CLI owns, and the argument that this is safe rests on three properties that
 * are cheap to state and easy to lose in a refactor: the cut lands on a TURN
 * boundary, only `sessionId` moves, and the SOURCE is never touched. Each is
 * pinned here with a hand-built log rather than through a booted host, because
 * a wrong cut does not crash — it produces a resumable conversation that is
 * quietly missing its own tail, which is exactly the failure a running e2e is
 * least likely to notice.
 *
 * `WATERPLANE_CLAUDE_HOME` points `transcriptPath` at a temp directory, so nothing
 * here can see (or write near) a real conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "waterplane-convfork-"));
process.env.WATERPLANE_CLAUDE_HOME = HOME;

const { forkConversationFile } = await import("../dist/convfork.js");
const { claudeProjectDir, transcriptPath } = await import("../dist/transcript.js");

const CWD = "/tmp/waterplane-convfork-repo";
const SRC = "11111111-1111-4111-8111-111111111111";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** A user PROMPT record — what `promptOf` accepts, and what a turn is named after. */
const prompt = (uuid, text, parent = null) => ({
  type: "user", uuid, parentUuid: parent, sessionId: SRC, session_id: SRC,
  timestamp: "2026-09-05T10:00:00.000Z", isSidechain: false,
  message: { role: "user", content: [{ type: "text", text }] },
});
/** An assistant reply, optionally carrying a tool call. */
const assistant = (uuid, text, parent, toolId = null) => ({
  type: "assistant", uuid, parentUuid: parent, sessionId: SRC, session_id: SRC,
  timestamp: "2026-09-05T10:00:01.000Z",
  message: { role: "assistant", content: toolId
    ? [{ type: "text", text }, { type: "tool_use", id: toolId, name: "Read", input: { file_path: "/x" } }]
    : [{ type: "text", text }] },
});
/** A tool RESULT. It is a `user` record, and `promptOf` must not read it as a
 *  prompt — if it did, the cut would land in the middle of a turn. */
const toolResult = (uuid, toolId, parent) => ({
  type: "user", uuid, parentUuid: parent, sessionId: SRC, session_id: SRC,
  timestamp: "2026-09-05T10:00:02.000Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] },
});
/** A record with no `uuid` at all — the format is full of them (`mode`,
 *  `last-prompt`, `file-history-*`), and they must ride along with their turn. */
const meta = (type) => ({ type, sessionId: SRC, session_id: SRC });

/** Write a fixture log and return its path plus the lines that went in. */
function fixture(records, { trailing } = {}) {
  mkdirSync(claudeProjectDir(CWD), { recursive: true });
  const path = transcriptPath(CWD, SRC);
  let body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (trailing) body += trailing;
  writeFileSync(path, body, "utf8");
  return path;
}

const readForked = (id) => readFileSync(transcriptPath(CWD, id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Three turns: turn 1 has a tool call and its result; turn 2 and 3 follow. */
const THREE_TURNS = [
  meta("last-prompt"),
  prompt("u1", "turn one please"),
  assistant("a1", "working", "u1", "tool-1"),
  toolResult("r1", "tool-1", "a1"),
  assistant("a1b", "done with one", "r1"),
  meta("file-history-snapshot"),
  prompt("u2", "turn two please", "a1b"),
  assistant("a2", "done with two", "u2"),
  prompt("u3", "turn three please", "a2"),
  assistant("a3", "done with three", "u3"),
];

test("the cut lands after the WHOLE turn, not at its prompt", () => {
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, SRC, "u1");
  assert.equal(res.error, undefined);
  const out = readForked(res.newId);
  // Everything turn 1 produced rides along: its assistant reply, the tool call,
  // the tool RESULT (a `user` record that is not a prompt) and the untyped
  // bookkeeping record that follows — and then it stops, before turn 2's prompt.
  assert.deepEqual(out.map((r) => r.uuid ?? r.type), ["last-prompt", "u1", "a1", "r1", "a1b", "file-history-snapshot"]);
});

test("forking at the last turn keeps the file to EOF", () => {
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, SRC, "u3");
  assert.equal(res.error, undefined);
  assert.equal(readForked(res.newId).length, THREE_TURNS.length);
});

test("a synthetic prompt does not cut the file", () => {
  // A hook echo / slash-command envelope is a `user` record that `promptOf`
  // rejects. If a second copy of that rule ever appears here, the fork gets cut
  // in the middle of turn 1 and this is what says so.
  fixture([
    prompt("u1", "turn one please"),
    { ...prompt("hook", "<user-prompt-submit-hook>ran", "u1") },
    assistant("a1", "done with one", "hook"),
    prompt("u2", "turn two please", "a1"),
  ]);
  const res = forkConversationFile(CWD, SRC, "u1");
  assert.deepEqual(readForked(res.newId).map((r) => r.uuid), ["u1", "hook", "a1"]);
});

test("sessionId is rewritten on every record and NOTHING else changes", () => {
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, SRC, "u2");
  const out = readForked(res.newId);
  for (const r of out) {
    assert.equal(r.sessionId, res.newId, `sessionId not reseated on ${r.uuid ?? r.type}`);
    // `session_id` is provenance — which session PRODUCED the record — and the
    // CLI's own `--fork-session` output leaves the parent's value on every
    // copied record (verified over 1,226 of them). Rewriting it would make the
    // fork claim it produced turns it did not.
    assert.equal(r.session_id, SRC);
  }
  // uuid / parentUuid / timestamp untouched: they are what makes every
  // reference in the copied prefix still resolve.
  const src = readFileSync(transcriptPath(CWD, SRC), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  out.forEach((r, i) => {
    assert.deepEqual(
      { ...r, sessionId: SRC },
      src[i],
      "a field other than sessionId moved",
    );
  });
});

test("the source is byte-identical afterwards", () => {
  const path = fixture(THREE_TURNS);
  const before = sha(readFileSync(path, "utf8"));
  const a = forkConversationFile(CWD, SRC, "u1");
  const b = forkConversationFile(CWD, SRC, "u1");
  assert.equal(sha(readFileSync(path, "utf8")), before);
  // Two forks from one turn are two files, never a mutation of the original.
  assert.notEqual(a.newId, b.newId);
  assert.ok(existsSync(transcriptPath(CWD, a.newId)) && existsSync(transcriptPath(CWD, b.newId)));
});

test("an unparseable trailing line is dropped, not fatal", () => {
  // A live session appends while we read: the tail is routinely half a record.
  // Dropping it is safe because nothing already copied can reference a record
  // nobody has finished writing — and aborting would make the feature fail
  // exactly when the session you want to fork is busy.
  fixture(THREE_TURNS, { trailing: '{"type":"assistant","uuid":"a4","sessi' });
  const res = forkConversationFile(CWD, SRC, "u3");
  assert.equal(res.error, undefined);
  assert.equal(res.dropped, 1);
  assert.equal(readForked(res.newId).length, THREE_TURNS.length);
});

test("a turn uuid that is not in this log is an error, never an empty or whole-file fork", () => {
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, SRC, "nosuchturn");
  assert.equal(res.newId, undefined);
  assert.match(res.error, /turn/);
  // Nothing was left behind under a resumable name.
  assert.equal(readFileSync(transcriptPath(CWD, SRC), "utf8").length > 0, true);
});

test("a traversal-shaped id is refused, not sanitised", () => {
  fixture(THREE_TURNS);
  for (const bad of ["../../etc/passwd", "..", "a/b", ".hidden", ""]) {
    assert.match(forkConversationFile(CWD, bad, "u1").error ?? "", /bad id/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.match(forkConversationFile(CWD, SRC, "../x").error ?? "", /bad turn/);
});

test("a conversation that is not there is an error", () => {
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, "22222222-2222-4222-8222-222222222222", "u1");
  assert.match(res.error, /no such conversation/);
});

test("nothing half-written is left in the project directory", () => {
  // The write is tmp+rename because `archive.ts` may `readdir` this directory at
  // any moment and a partial `<id>.jsonl` is an archive row that resumes into a
  // truncated conversation. The tmp name must therefore both be cleaned up and,
  // while it exists, be invisible to a listing that filters on `.jsonl`.
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, SRC, "u1");
  assert.equal(res.error, undefined);
  const left = readdirSync(claudeProjectDir(CWD)).filter((n) => !n.endsWith(".jsonl"));
  assert.deepEqual(left, [], `stray files: ${left.join(", ")}`);
});

test("blank lines are skipped and are not counted as dropped records", () => {
  // The distinction matters because `dropped` is the only signal a caller has
  // that it forked a log it could not fully read; a trailing newline must not
  // make every fork look damaged.
  fixture(THREE_TURNS, { trailing: "\n\n   \n" });
  const res = forkConversationFile(CWD, SRC, "u3");
  assert.equal(res.error, undefined);
  assert.equal(res.dropped, 0);
});

/**
 * The forward-pointing bookkeeping. Two record kinds are written when a turn
 * BEGINS and name a message that lands after them, so a cut on a turn boundary
 * keeps them and drops what they point at. `pruneStranded()` removes them.
 */
const COMPACT_TURNS = [
  prompt("u1", "turn one please"),
  assistant("a1", "done with one", "u1"),
  // A snapshot taken at the start of turn 2, naming turn 2's own prompt.
  { type: "file-history-snapshot", messageId: "u2", snapshot: { messageId: "u2", trackedFileBackups: {} }, sessionId: SRC },
  // The `system` record a /compact writes, whose preserved-segment anchor names
  // the compact SUMMARY that follows it.
  { type: "system", uuid: "sys", parentUuid: null, logicalParentUuid: "a1", sessionId: SRC,
    compactMetadata: { trigger: "manual", preservedSegment: { headUuid: "a1", anchorUuid: "u2", tailUuid: "a1" } } },
  // The summary is a `user` record `promptOf` accepts — so it IS the next turn,
  // and the cut lands right here, between the two records above and this one.
  { ...prompt("u2", "This session is being continued from a previous conversation."), isCompactSummary: true },
  assistant("a2", "done with two", "u2"),
];

test("a record that is ABOUT the turn we cut away is pruned", () => {
  fixture(COMPACT_TURNS);
  const res = forkConversationFile(CWD, SRC, "u1");
  assert.equal(res.error, undefined);
  assert.equal(res.pruned, 2);
  const out = readForked(res.newId);
  assert.deepEqual(out.map((r) => r.uuid ?? r.type), ["u1", "a1"]);
  // The point is not tidiness. Keeping that `system` record means keeping the
  // instruction to discard the pre-compact history while losing the summary
  // that stood in for it — a fork that arrives with LESS history than the turn
  // number it was cut at promises. Observed against the real CLI, not reasoned.
  assert.ok(!out.some((r) => r.compactMetadata), "the compact header must not outlive its summary");
});

test("pruning can never take a message record", () => {
  // `parentUuid` points backward without exception (132,320 of them across three
  // projects' logs, none forward), so every chain record's reference is inside
  // the prefix by construction and the filter cannot reach it. This is the
  // assertion that says so out loud.
  fixture(COMPACT_TURNS);
  for (const at of ["u1", "u2"]) {
    const out = readForked(forkConversationFile(CWD, SRC, at).newId);
    for (const r of out) assert.ok(r.type !== "user" || r.uuid, "a message record was pruned");
    assert.ok(out.some((r) => r.uuid === "u1"), "turn 1 survives every cut");
  }
});

test("an ordinary fork prunes nothing", () => {
  // The pruning is allowed to delete records, so it has to be provably inert on
  // a log that has no forward references — which is the overwhelming majority.
  fixture(THREE_TURNS);
  for (const at of ["u1", "u2", "u3"]) {
    const res = forkConversationFile(CWD, SRC, at);
    assert.equal(res.pruned, 0, `cut at ${at} pruned something`);
  }
});

test("an id from another namespace is not treated as a reference", () => {
  // `id` / `tool_use_id` / `toolUseID` are API message and tool-call ids: 100,808
  // of them in the corpus, not one naming a record uuid. If they were read as
  // references, pruning would delete most of the conversation — so a fixture
  // full of them must come through untouched.
  fixture(THREE_TURNS);
  const res = forkConversationFile(CWD, SRC, "u1");
  const out = readForked(res.newId);
  assert.equal(res.pruned, 0);
  assert.ok(out.some((r) => r.message?.content?.[0]?.tool_use_id === "tool-1"), "the tool result survived");
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
