/**
 * `installShutdown`'s `stops` (the push-failure watch's tick, which may WRITE a store) run on
 * SIGTERM, and BEFORE any store flush — else a tick lands mid-flush and its write is lost or torn
 * (design round 5). `tools/hostpins.test.mjs` pins the flush order as source text; this pins the
 * stops as behaviour: the handler is called in-process (no signal, no child) against a ctx that
 * only records what was asked of it, with `process.exit` held.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { installShutdown } = await import("../dist/server/shutdown.js");

/** Every member is a callable recorder: `ctx.acks.flush()` logs "acks.flush". */
function recorder(log, path = []) {
  return new Proxy(function () {}, {
    get: (_t, k) => (typeof k === "symbol" ? undefined : recorder(log, [...path, k])),
    apply: () => { log.push(path.join(".")); },
  });
}

async function fireSigterm(stops) {
  const log = [];
  const ctx = new Proxy({}, { get: (_t, k) => (k === "PORT" ? 0 : recorder(log, [k])) });
  const events = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"];
  const before = Object.fromEntries(events.map((e) => [e, process.listeners(e)]));
  const exit = process.exit;
  let exited;
  process.exit = (code) => { exited = code; log.push("exit"); };
  try {
    installShutdown(ctx, stops(log));
    const added = process.listeners("SIGTERM").filter((l) => !before.SIGTERM.includes(l));
    assert.equal(added.length, 1, "one SIGTERM handler installed");
    added[0]("SIGTERM");
  } finally {
    process.exit = exit;
    for (const e of events) for (const l of process.listeners(e)) if (!before[e].includes(l)) process.off(e, l);
  }
  return { log, exited };
}

test("SIGTERM runs every stop, before the first store flush, and still exits", async () => {
  const { log, exited } = await fireSigterm((log) => [() => log.push("stop:push"), undefined, () => log.push("stop:b")]);
  assert.equal(exited, 0);
  const firstFlush = log.findIndex((l) => /\.flush\w*$/.test(l));
  assert.ok(firstFlush > 0, `a store flush ran: ${log.join(", ")}`);
  assert.ok(log.includes("acks.flush"));
  for (const s of ["stop:push", "stop:b"]) {
    const at = log.indexOf(s);
    assert.ok(at >= 0, `${s} never ran on SIGTERM`);
    assert.ok(at < firstFlush, `${s} ran after ${log[firstFlush]}: a tick could write mid-flush`);
  }
});

test("a stop that throws does not keep the flushes or the exit from happening", async () => {
  const { log, exited } = await fireSigterm(() => [() => { throw new Error("boom"); }]);
  assert.equal(exited, 0);
  assert.ok(log.includes("acks.flush"));
  assert.ok(log.includes("intents.flush"));
});
