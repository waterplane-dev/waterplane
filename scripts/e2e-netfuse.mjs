// The HTTP fuse: a host that never answers must not hang the client forever.
//
// This is the failure the phone actually hits — a dead Tailscale path does not
// refuse a connection, it swallows it, so `fetch` waits indefinitely and every
// offline fallback (the reader's cached transcript, the slash cache, the
// gallery's stale rows) becomes unreachable code, because all of them hang off
// the fetch REJECTING. Observed: a reader parked on "loading transcript…" with
// a perfectly good cached document one IndexedDB read away.
//
// Real server, real sockets, real clock — the point is what happens when bytes
// never come back, which a stubbed fetch cannot prove.
import http from "node:http";
import { timedFetch, isOffline, TimeoutError, FETCH_TIMEOUT_MS, TRANSCRIPT_TIMEOUT_MS, SLOW_OP_TIMEOUT_MS }
  from "../packages/shared/dist/netfuse.js";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const eq = (a, b, l) => check(a === b, `${l}${a === b ? "" : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);

// A host that accepts the connection and then says nothing — the dead-tunnel
// shape. Never `res.end()`, so only the fuse can end these requests.
const hung = [];
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/hang")) { hung.push(res); return; }            // silence, forever
  if (req.url.startsWith("/slow")) { setTimeout(() => res.end("late"), 600); return; }
  if (req.url.startsWith("/404")) { res.writeHead(404); res.end("nope"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

// ── The fuse fires, and says what happened ────────────────────────────────
{
  const t0 = Date.now();
  let err = null;
  try { await timedFetch(`${base}/hang`, undefined, 400); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check(err instanceof TimeoutError, "a host that never answers rejects with TimeoutError");
  check(ms >= 350 && ms < 3000, `…at roughly the budget, not the OS default (${ms}ms)`);
  check(isOffline(err), "a timeout classifies as offline (so the UI says 'can't reach the host')");
  eq(err?.ms, 400, "the error carries the budget it blew");
}

// ── A live host is untouched ──────────────────────────────────────────────
{
  const r = await timedFetch(`${base}/ok`, undefined, 5000);
  eq(r.status, 200, "a normal response passes straight through");
  eq((await r.json()).ok, true, "…body intact");
  const slow = await timedFetch(`${base}/slow`, undefined, 5000);
  eq(await slow.text(), "late", "a slow-but-answering host is NOT cut off inside its budget");
}

// ── A status is an ANSWER, not an outage ──────────────────────────────────
// The distinction decides what the user is told: "can't reach the host" vs the
// host's own no. Getting it wrong sends someone to check their tunnel over a 404.
{
  const r = await timedFetch(`${base}/404`, undefined, 5000);
  eq(r.status, 404, "a 404 resolves (the caller decides what a status means)");
  check(!isOffline(new Error("404 transcript")), "a status-derived error is not 'offline'");
  check(isOffline(new TypeError("Failed to fetch")), "fetch's transport failure IS offline");
  check(isOffline(new Error("fetch failed")), "node's transport failure IS offline");
}

// ── A caller's own abort stays the caller's ───────────────────────────────
// Cancel buttons and upload aborts must not be reported as a dead link: the
// user pressed cancel, and telling them the tunnel died is a wrong diagnosis
// they would then go and act on.
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  let err = null;
  try { await timedFetch(`${base}/hang`, { signal: ac.signal }, 60000); } catch (e) { err = e; }
  check(err && !(err instanceof TimeoutError), "an abort the CALLER raised is not reported as a timeout");
  check(String(err?.name) === "AbortError", `…it stays an AbortError (got ${err?.name})`);
}
{
  // Already-aborted signal: the request must not go out at all.
  const ac = new AbortController();
  ac.abort();
  let err = null;
  try { await timedFetch(`${base}/ok`, { signal: ac.signal }, 5000); } catch (e) { err = e; }
  check(err && !(err instanceof TimeoutError), "a pre-aborted signal short-circuits without a timeout");
}

// ── The budgets themselves ────────────────────────────────────────────────
// Ordering is the load-bearing part: the reader polls, so its fuse must be
// shorter than the generic one (a poll still pending when the next is due has
// failed), while a push/checkout runs a real command and must NOT be cut at the
// generic budget — reporting failure for work the host then completes is worse
// than the hang the fuse replaced.
check(TRANSCRIPT_TIMEOUT_MS < FETCH_TIMEOUT_MS, "the polling fuse is shorter than the generic one");
check(SLOW_OP_TIMEOUT_MS > FETCH_TIMEOUT_MS * 4, "git push/checkout get a much larger budget");

for (const res of hung) res.destroy();
srv.close();
console.log(failed ? "\nFAILED" : "\nAll netfuse checks passed");
process.exit(failed ? 1 : 0);
