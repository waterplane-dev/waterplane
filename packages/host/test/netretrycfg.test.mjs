/**
 * The network-error retry switch (`netretrycfg.ts`, R-connection-025).
 *
 *  1. Never switched: no file, ON — the retry is the default.
 *  2. The switch is persisted and a fresh process reads it back.
 *  3. A torn file reads as the default (on), and is moved aside, never overwritten.
 *  4. `WATERPLANE_NET_RETRY=0` is a HARD override: off whatever the switch says,
 *     and the config says so (`envOff`) so the phone prints the sentence.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-netcfg-root-"));
const state = mkdtempSync(join(tmpdir(), "wp-netcfg-state-"));
process.env.WATERPLANE_ROOT = root;
process.env.WATERPLANE_STATE_DIR = state;
delete process.env.WATERPLANE_NET_RETRY;
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });

const fresh = (n) => import(`../dist/netretrycfg.js?v=${n}`);
const { hostStateDir } = await import("../dist/branddirs.js");
const { netRetryEnvOffText } = await import("@waterplane/shared");
const file = () => join(hostStateDir(root), "netretry.json");

test("never switched: no file, on", async () => {
  const c = await fresh(1);
  assert.equal(existsSync(file()), false);
  assert.equal(c.netRetryOn(), true);
  assert.deepEqual(c.netRetryConfig(), { enabled: true });
});

test("the switch is persisted and read back by a fresh process", async () => {
  const a = await fresh(2);
  assert.deepEqual(a.setNetRetry(false), { enabled: false });
  assert.equal(a.netRetryOn(), false);
  assert.deepEqual(JSON.parse(readFileSync(file(), "utf8")), { enabled: false });
  const b = await fresh(3);
  assert.equal(b.netRetryOn(), false, "a restart keeps it off");
  b.setNetRetry(true);
  assert.equal((await fresh(4)).netRetryOn(), true);
});

test("a torn file reads as the default and is moved aside", async () => {
  writeFileSync(file(), "{not json");
  const c = await fresh(5);
  assert.equal(c.netRetryOn(), true);
  assert.ok(readdirSync(dirname(file())).some((f) => f.startsWith(`${basename(file())}.corrupt-`)), "kept as .corrupt-<ts>");
});

test("WATERPLANE_NET_RETRY=0 forces it off whatever the switch says, and says so", async () => {
  (await fresh(6)).setNetRetry(true);
  process.env.WATERPLANE_NET_RETRY = "0";
  try {
    const c = await fresh(7);
    assert.equal(c.netRetryOn(), false);
    assert.deepEqual(c.netRetryConfig(), { enabled: true, envOff: true });
    assert.deepEqual(c.setNetRetry(false), { enabled: false, envOff: true }, "the switch still saves");
    assert.match(netRetryEnvOffText(), /WATERPLANE_NET_RETRY=0/);
  } finally { delete process.env.WATERPLANE_NET_RETRY; }
});
