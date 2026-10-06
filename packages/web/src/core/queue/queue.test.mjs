/**
 * **At-most-once, pinned as a fact about the source.**
 *
 *     node --test packages/web/src/core/queue/queue.test.mjs
 *
 * Every retry path in this app is safe for one reason: it re-sends the SAME
 * ackId (or the op's frozen bytes, which carry it), and the host's ledger
 * re-acks a repeat instead of running it twice. A fresh `newAckId()` is the
 * one move that makes a message NEW — which is right for a message that has
 * provably never been sent (a new prompt, a re-aim whose old id may hold a
 * stale verdict) and is a prompt run twice anywhere else.
 *
 * So where ids are minted is counted, not described. The queue core
 * (`core/queue/`) owns the sends and the retries; the handful of other sites
 * are named below with their counts, and moving one is a line in this file —
 * a decision somebody makes on purpose, in review, rather than a `newAckId()`
 * that drifts into a sheet.
 *
 * The same file pins the other half of the queue's shape: the store is written
 * by `writeOutbox` alone, ref first, never through an updater.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(SRC, p).split("\\").join("/");
/** Code, not prose: a comment that names `newAckId()` is not a site. Crude on
 *  purpose (a `//` inside a string drops the rest of that line), which can only
 *  ever UNDER-count a line that also holds a URL — none does today. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
/** Import and re-export lists, which NAME the minter without minting. */
const noImports = (c) => c
  .replace(/^\s*import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?/gm, "")
  .replace(/^\s*export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/gm, "");
/**
 * Minting sites in one file. Not just `newAckId()` calls: EVERY use of the
 * identifier outside an import counts — `mintAckId: newAckId` binds the minter
 * by reference and hands it to whoever holds that object, which is a mint path
 * as surely as a call is — and every `mintAckId(` call, which is the same
 * minter reached through `core().queue`. The two definitions are not sites.
 */
const sites = (text) => {
  const c = noImports(code(text));
  const ids = (c.match(/\bnewAckId\b/g) ?? []).length - (c.match(/function newAckId\(\)/g) ?? []).length;
  const viaCore = (c.match(/\bmintAckId\(/g) ?? []).length - (c.match(/\bmintAckId\(\)\s*:/g) ?? []).length;
  return ids + viaCore;
};

const files = walk(SRC).map((p) => ({ rel: rel(p), text: readFileSync(p, "utf8") }));

/**
 * The queue core's own sites: submitInput, queueOp, queueImageUpload,
 * queueBacklog, answerPrompt (send.ts) · retryPendingCreate,
 * queueSessionPrompt (pending.ts) · retargetQueued, handToDesktop (verbs.ts) ·
 * migrateGiveUps (migrate.ts). Each is a message that has never been sent.
 */
const QUEUE_SITES = 10;

/**
 * Everywhere else an id is minted, by file. `outbox.ts` mints two that are not
 * ack ids at all (an inbox filename's suffix, and `padNoteId()` — the one pad
 * note id every *keep it on the pad* site takes, `useCompose.ts` included).
 * `App.tsx` holds ONE: `mintAckId: newAckId` in `bindCore`, the by-reference
 * bind that is `core().queue.mintAckId` — no call of its own, but the reason a
 * feature can mint at all. `core/send/useSend.tsx` mints the send sheet's
 * re-attach (`reattachKept`): bytes kept from a dead upload, queued again as a
 * NEW upload row that has never been sent. `core/launch/useLaunch.ts` mints the
 * three creates that name their own ack before queueing (`openRepoWith`,
 * `openCwd`, `startSessionWithPrompt`) so the pending screen and a prompt chain
 * can address the create before it is sent. `features/backlog/actions.ts`
 * mints the assessment's two live ops (`runAssessment`, `applyAssessment`)
 * through `core().queue.mintAckId()`: sent LIVE, never retried, so the fresh
 * id is the only one those words ever have. `core/pluginCalls.ts` mints a `plugin.call`'s id: a LIVE
 * question, never queued; only a read is re-sent after a reconnect, with the SAME id.
 */
const ELSEWHERE = {
  "App.tsx": 1,
  "core/launch/useLaunch.ts": 3,
  "core/pluginCalls.ts": 1,
  "core/send/useSend.tsx": 1,
  "features/backlog/actions.ts": 2,
  "outbox.ts": 2,
};

test(`core/queue mints exactly ${QUEUE_SITES} ackIds`, () => {
  const inCore = files.filter((f) => f.rel.startsWith("core/queue/"));
  const found = Object.fromEntries(inCore.map((f) => [f.rel, sites(f.text)]).filter(([, n]) => n > 0));
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  assert.equal(total, QUEUE_SITES,
    `newAckId() call sites in core/queue: ${JSON.stringify(found)}. A new site is a new way to make a message\n` +
    `the host has never seen — which is only right for words that have provably never been sent. If it is,\n` +
    `raise QUEUE_SITES and name it in the comment above; a retry must re-send the SAME ackId instead.`);
});

test("nothing outside core/queue mints an ackId except the named files", () => {
  const found = Object.fromEntries(files
    .filter((f) => !f.rel.startsWith("core/queue/"))
    .map((f) => [f.rel, sites(f.text)])
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(found, ELSEWHERE,
    `newAckId / mintAckId( outside core/queue. The queue core is where a message becomes a message: a sheet\n` +
    `or a feature that mints its own id has a send path the retry rules do not cover. Queue it through\n` +
    `core().queue instead — or, if a site genuinely MOVED (a core module took it from App), move its count\n` +
    `in ELSEWHERE with it.`);
});

/**
 * `queueOp(op, lane, text, { ackId })` takes a caller's id: the second way in.
 * The queue core uses it (a retried create keeps its ack); outside it, only
 * the three creates in `useLaunch.ts` hand one over — each the id they minted
 * a line above (counted in ELSEWHERE), so the pending screen can name the
 * create before it is sent. A feature passing an id it did not just mint is a
 * RE-SEND under an old ack, which the host re-acks and never runs.
 */
const QUEUE_OP_WITH_ACK = { "core/launch/useLaunch.ts": 3 };

/** Every `queueOp(` call's balanced argument text (not its declarations). */
function queueOpArgs(text) {
  const c = code(text);
  const out = [];
  for (const m of c.matchAll(/\bqueueOp\(/g)) {
    if (/function\s+$/.test(c.slice(Math.max(0, m.index - 12), m.index))) continue;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < c.length; i++) {
      if (c[i] === "(") depth++;
      else if (c[i] === ")" && --depth === 0) { out.push(c.slice(m.index + m[0].length, i)); break; }
    }
  }
  return out;
}

test("outside core/queue, only the named creates hand queueOp an ackId of their own", () => {
  const found = Object.fromEntries(files
    .filter((f) => !f.rel.startsWith("core/queue/") && !f.rel.startsWith("sdk/"))
    .map((f) => [f.rel, queueOpArgs(f.text).filter((a) => /\backId\s*:|[{,]\s*ackId\s*[,}]/.test(a)).length])
    .filter(([, n]) => n > 0));
  assert.deepEqual(found, QUEUE_OP_WITH_ACK,
    "queueOp(…, { ackId }) outside core/queue. A caller-supplied id is a mint path the ELSEWHERE count\n" +
    "does not see, and an OLD id there is a re-send the host swallows. Let queueOp mint it — or, if\n" +
    "something must name the op before it exists, mint it on the line above and add the file here.");
});

test("the store is written by writeOutbox alone, ref first, never through an updater", () => {
  const writers = files.filter((f) => /outboxStore\.set\(/.test(f.text)).map((f) => f.rel).sort();
  assert.deepEqual(writers, ["core/queue/store.ts", "core/queue/useQueue.ts"],
    "only writeOutbox (useQueue.ts) and the one-shot seed (store.ts) may set the outbox store");
  const hook = files.find((f) => f.rel === "core/queue/useQueue.ts").text;
  assert.equal((hook.match(/outboxStore\.set\(/g) ?? []).length, 1, "one store write in the hook: writeOutbox's");
  const body = hook.slice(hook.indexOf("function writeOutboxImpl("));
  const order = ["saveOutbox(list)", "outboxRef.current = list", "outboxStore.set(list)", "reportShellQueueDepth("]
    .map((s) => body.indexOf(s));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])),
    "writeOutbox: persist → ref → store → shell depth, in that order (the flusher reads the ref synchronously)");
  assert.doesNotMatch(hook, /outboxStore\.set\(\s*\(/, "never a functional updater — the ref is the truth");
});
