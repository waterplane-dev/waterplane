// The dial fuse (`dialFuse.ts`): a WebSocket handshake that never completes fires
// no close, so `ws.ts` must give it up on a deadline or the 1 s retry never runs.
// `ws.ts` cannot load under node (parameter properties), so its wiring is pinned
// by source: every dial arms the fuse, and an open or a close disarms it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DIAL_TIMEOUT_MAX_MS, DIAL_TIMEOUT_MS, dialTimeoutMs } from "./dialFuse.ts";

test("the fuse doubles per consecutive cut dial and stops at the cap", () => {
  assert.equal(dialTimeoutMs(0), DIAL_TIMEOUT_MS);
  assert.equal(dialTimeoutMs(1), DIAL_TIMEOUT_MS * 2);
  assert.equal(dialTimeoutMs(2), DIAL_TIMEOUT_MAX_MS);
  assert.equal(dialTimeoutMs(50), DIAL_TIMEOUT_MAX_MS);
  assert.equal(dialTimeoutMs(-3), DIAL_TIMEOUT_MS);
  assert.equal(dialTimeoutMs(Number.NaN), DIAL_TIMEOUT_MS);
});

test("the first dial's fuse outlasts the reload watchdog, so a wake reload still gets its chance", () => {
  const src = readFileSync(new URL("./ws.ts", import.meta.url), "utf8");
  const reload = Number(/const RELOAD_AFTER_MS = (\d+)/.exec(src)?.[1]);
  assert.ok(reload > 0);
  assert.ok(DIAL_TIMEOUT_MS > reload, "a wake arms the watchdog; the fuse must not pre-empt it");
});

test("ws.ts arms the fuse on every dial and disarms it on open, close and a forced reconnect", () => {
  const src = readFileSync(new URL("./ws.ts", import.meta.url), "utf8");
  const body = (name) => {
    const i = src.indexOf(`  private ${name}(`);
    assert.ok(i >= 0, name);
    return src.slice(i, src.indexOf("\n  }\n", i));
  };
  const connect = body("connect");
  assert.match(connect, /this\.ws = ws;\s*this\.armDialFuse\(ws\);/);
  assert.match(connect, /ws\.onopen = \(\) => \{\s*this\.clearDialFuse\(\);\s*this\.dialsCut = 0;/);
  assert.match(connect, /ws\.onclose = \(\) => \{\s*this\.clearDialFuse\(\);/);
  assert.match(body("forceReconnect"), /this\.clearDialFuse\(\);/);
  const fuse = body("armDialFuse");
  assert.match(fuse, /if \(this\.ws !== ws \|\| ws\.readyState !== WebSocket\.CONNECTING\) return;/);
  assert.match(fuse, /ws\.onopen = ws\.onmessage = ws\.onclose = ws\.onerror = null;/);
  assert.match(fuse, /this\.scheduleReconnect\(\);/);
  assert.doesNotMatch(fuse, /\.send\(/, "the fuse never sends — queued frames wait for the next onopen");
});
