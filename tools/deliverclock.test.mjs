/**
 * The delivery path reads wall time through ONE seam: `waitclock.ts`'s `Clock`.
 *
 * A bare `Date.now()`, `sleep(` or `setTimeout(` on that path is a wait a test
 * can only watch in real seconds (79b2d0cf: a prompt overtook its picture, a
 * 53 s case found live). The path is `deliver.ts` + `deliver/*` (whole files),
 * `server/deliveries.ts` (`startPrompt`, `deliverChain`, the re-send, the inbox
 * hold), `settle.ts` (`awaitLanded` and the ask race of a backend's channel)
 * and `sessions/drive.ts`'s `waitReady` (only that function: the rest of that
 * file stamps facts, it does not wait). `clock.now()` / `clock.sleep()` read as
 * method calls and do not match.
 * An exception goes in ALLOWED below with the reason it is a fact and not a wait.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../packages/host/src/", import.meta.url).pathname;
const files = ["deliver.ts", ...readdirSync(join(SRC, "deliver")).filter((f) => f.endsWith(".ts")).map((f) => `deliver/${f}`),
  "server/deliveries.ts", "settle.ts"];

/** file → [pattern, reason] pairs that may stay. */
const ALLOWED = {
  "settle.ts": [
    [/const at = Date\.now\(\);/, "the transcript cache's stamp, compared with the log's mtime (wall time on disk) — a fact, not a wait"],
  ],
};

/** Functions on the path that live in files that are otherwise not: name → file. */
const FUNCTIONS = { waitReady: "sessions/drive.ts" };

const BARE = /(?<![\w.])(?:sleep\(|setTimeout\(|setInterval\()|\bDate\.now\(\)|\bperformance\.now\(\)/;

function scan(f, src, offset, bad) {
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || !BARE.test(line)) return;
    if ((ALLOWED[f] ?? []).some(([re]) => re.test(line))) return;
    bad.push(`${f}:${offset + i + 1}: ${line.trim()}`);
  });
}

test("the delivery path reads time only through the Clock", () => {
  const bad = [];
  for (const f of files) scan(f, readFileSync(join(SRC, f), "utf8"), 0, bad);
  for (const [fn, f] of Object.entries(FUNCTIONS)) {
    const src = readFileSync(join(SRC, f), "utf8");
    const start = src.search(new RegExp(`^export (?:async )?function ${fn}\\(`, "m"));
    assert.ok(start >= 0, `${f} no longer has ${fn} — move this entry to where it went`);
    const end = src.indexOf("\n}\n", start);
    scan(f, src.slice(start, end), src.slice(0, start).split("\n").length - 1, bad);
  }
  assert.deepEqual(bad, [], "use the delivery's clock (packages/host/src/waitclock.ts), or add an ALLOWED entry with a reason");
});

test("every ALLOWED exception still matches a line (a stale one would excuse the next bare wait)", () => {
  for (const [f, pairs] of Object.entries(ALLOWED)) {
    const src = readFileSync(join(SRC, f), "utf8");
    for (const [re] of pairs) assert.match(src, re, `${f}: ${re} matches nothing — drop it`);
  }
});

test("the real clock is the only place the ladder's seam touches Date.now", () => {
  const src = readFileSync(join(SRC, "waitclock.ts"), "utf8");
  assert.match(src, /now: \(\) => Date\.now\(\)/);
  assert.match(src, /t\.unref\?\.\(\)/, "the race bound never holds the process open by itself");
});
