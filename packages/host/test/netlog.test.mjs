/**
 * Did the turn end because the CLI gave up on a TRANSIENT API error — asked of
 * its own log (`netlog.ts`), plus the retry ladder (`netRetryDelay`).
 *
 * The texts are the CLI's own, as seen in real logs (2026-10-27). They are
 * built from halves anyway, the convention for CLI wording kept in source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshGiveUp, netRetryDelay, NET_LADDER_MS, NET_MAX_ATTEMPTS, readNetLog, transientApiError } from "../dist/netlog.js";

const DIR = mkdtempSync(join(tmpdir(), "waterplane-netlog-"));
let n = 0;
const iso = (ms) => new Date(ms).toISOString();
const E = "API " + "Error: ";

const REAL = {
  dns: E + "Can't reach the API server — check your internet or DNS (ENOTFOUND)",
  overloaded: E + "529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
  lost: E + "Connection lost mid-response. The response above may be incomplete.",
  refused: E + "Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
  reset: E + "Connection dropped (ECONNRESET)",
  noResponse: E + "No response from API (waited 3m). If a proxy or gateway on your network holds responses, raise its timeout.",
};

const apiErr = (at, text, error = "server_error", extra = {}) => JSON.stringify({
  type: "assistant", timestamp: iso(at), isApiErrorMessage: true, error, apiErrorStatus: 500,
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] }, ...extra,
});
const reply = (at) => JSON.stringify({ type: "assistant", timestamp: iso(at), message: { model: "claude-opus-4", role: "assistant", content: [{ type: "text", text: "Done." }] } });
const user = (at) => JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: "continue" } });
const log = (...rows) => { const p = join(DIR, `l${n++}.jsonl`); writeFileSync(p, rows.join("\n") + "\n"); return p; };

test("every real transient give-up reads as transient, with a short line", () => {
  assert.equal(transientApiError(REAL.dns), "Can't reach the API server — check your internet or DNS (ENOTFOUND)");
  assert.equal(transientApiError(REAL.overloaded), "529 Overloaded.");
  assert.equal(transientApiError(REAL.lost), "Connection lost mid-response.");
  assert.equal(transientApiError(REAL.refused), "Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)");
  assert.equal(transientApiError(REAL.reset), "Connection dropped (ECONNRESET)");
  assert.equal(transientApiError(REAL.noResponse), "No response from API (waited 3m).");
});

test("not transient: a stub's 400, an unknown shape, no API-error prefix, a spend wall", () => {
  assert.equal(transientApiError(E + "400 waterplane stub"), null);
  assert.equal(transientApiError(E + "Something nobody has seen before"), null);
  assert.equal(transientApiError("Can't reach the API server (ENOTFOUND)"), null);
  assert.equal(transientApiError(E + "Credit balance is " + "too low"), null);
});

test("the newest row decides: a fresh give-up is transient and dated", () => {
  const at = Date.parse("2026-10-27T10:00:00Z");
  const v = readNetLog(log(reply(at - 60_000), user(at - 5000), apiErr(at, REAL.dns)));
  assert.equal(v.state, "transient");
  assert.equal(v.at, at);
  assert.match(v.error, /ENOTFOUND/);
});

test("a served reply after the give-up clears it", () => {
  const at = Date.parse("2026-10-27T10:00:00Z");
  assert.equal(readNetLog(log(apiErr(at, REAL.dns), user(at + 20_000), reply(at + 30_000))).state, "clear");
});

test("error must be server_error: the stub's `unknown` never counts, even on a transient text", () => {
  const at = Date.now();
  assert.equal(readNetLog(log(apiErr(at, REAL.dns, "unknown"))).state, "clear");
  assert.equal(readNetLog(log(apiErr(at, E + "400 waterplane stub", "unknown"))).state, "clear");
});

test("a usage-limit rejection row is never ours", () => {
  const at = Date.now();
  const row = apiErr(at, REAL.overloaded, "server_error", { quotaLimits: { status: "rejected", resetsAt: Math.floor(at / 1000) + 3600 } });
  assert.equal(readNetLog(log(row)).state, "clear");
});

test("no log, an empty log, or no assistant row is unknown — never a verdict", () => {
  assert.equal(readNetLog(join(DIR, "absent.jsonl")).state, "unknown");
  assert.equal(readNetLog(log("")).state, "unknown");
  assert.equal(readNetLog(log(user(Date.now()))).state, "unknown");
});

test("fresh means stamped inside the turn that just ended", () => {
  const at = 1_000_000;
  const v = { state: "transient", at, error: "x" };
  assert.equal(freshGiveUp(v, at - 30_000), true);
  assert.equal(freshGiveUp(v, at + 1000), true, "clock slack");
  assert.equal(freshGiveUp(v, at + 60_000), false, "an old error still newest in the log");
  assert.equal(freshGiveUp(v, undefined), false, "no turn start known ⇒ never");
  assert.equal(freshGiveUp({ state: "clear", at: null, error: null }, at), false);
});

test("the ladder widens, repeats its last rung, and stops at the cap", () => {
  assert.deepEqual(NET_LADDER_MS, [20_000, 60_000, 120_000, 300_000, 600_000, 900_000]);
  assert.equal(NET_MAX_ATTEMPTS, 8);
  const got = [];
  for (let i = 0; i < 10; i++) got.push(netRetryDelay(i));
  assert.deepEqual(got, [20_000, 60_000, 120_000, 300_000, 600_000, 900_000, 900_000, 900_000, null, null]);
  assert.equal(netRetryDelay(0, 0), null, "a cap of 0 retries nothing");
  assert.equal(netRetryDelay(1, 3, [5, 7]), 7);
  assert.equal(netRetryDelay(5, 8, []), 900_000, "an empty ladder is the default");
});
