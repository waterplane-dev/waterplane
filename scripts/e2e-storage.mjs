// What the DESKTOP is holding, as the phone reaches it — the two reads and the
// one clear, over a real daemon.
//
// The rules themselves are pinned without a host: `shared/test/sweepfamilies.test.mjs`
// (which builds supersede which), `host/test/hoststore.test.mjs` (what a clear
// may touch) and `host/test/transportsurvey.test.mjs` (the ranking and the
// bound). This script owns the WIRING, and specifically the four things that
// only exist once a request has crossed the tunnel:
//
//   1. the survey's number for a repo is byte-identical to the per-repo
//      sweep's own total for that repo and scope. Two routes, one
//      `listTransport` — if they ever diverge, the row says 38 files and the
//      sheet it opens shows 39, and a person learns to distrust both
//   2. a look is not a change: a GET of either read leaves every file where it
//      was. This is the whole difference between a report and a sweep
//   3. the clear takes a catalogue ID and an INSTANT and nothing else. A
//      request naming a path, a ledger or a store outside the catalogue is
//      refused in WORDS at 200 — the refusal is a sentence a person is meant
//      to read, and a non-2xx would collapse it into the phone's generic
//      error state
//   4. `at` is the contract: a leftover written after the report was taken
//      survives the clear, because it was never on the screen anybody approved
//
// Plus the security line: the clear DELETES, so it is POST and never GET
// (CLAUDE.md — a side-effecting endpoint must not be a GET, which is what
// stops a cross-origin `<img src>` from firing it), and a cross-origin POST is
// refused by `origin.ts`.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8894;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-storage-`)));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gitIn = (dir, args) =>
  new Promise((r) => spawn("git", args, { cwd: dir, stdio: "ignore" }).on("exit", r));

/** A repo with a transport directory holding `files` (name → bytes). */
async function makeRepo(name, files) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  await gitIn(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  for (const [rel, size] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x".repeat(size));
  }
  return realpathSync(dir);
}

// `fat` is the case the survey exists for: several builds of one thing, plus a
// photo in the other direction. `thin` is there so a ranking has something to
// be a ranking OF.
await makeRepo("fat", {
  ".claude/outbox/app-1.1.0+330.apk": 3_000,
  ".claude/outbox/app-1.1.0+331.apk": 3_000,
  ".claude/outbox/app-1.1.0+332.apk": 3_000,
  ".claude/outbox/app-1.1.0+333.apk": 3_000,
  ".claude/inbox/shot.jpg": 500,
});
await makeRepo("thin", { ".claude/outbox/report.md": 40 });

// The daemon's own store, pre-seeded so the report has something of every kind
// to classify. `<ENV>_ROOT` is the scratch root, so `<ROOT>/<state>` is it.
const STORE = join(ROOT, STATE);
mkdirSync(STORE, { recursive: true });
writeFileSync(join(STORE, "intents.json.bak"), "x".repeat(120));      // a leftover
// Valid but empty, padded to size: a corrupt store is moved aside at boot
// (jsonstore), and then there is no ledger left for §4 to protect.
writeFileSync(join(STORE, "sent.json"), `[${" ".repeat(898)}]`);         // a bounded ledger
writeFileSync(join(STORE, "tokenstats.json"), `{${" ".repeat(698)}}`);   // the unbounded one

const host = spawn("node", ["packages/host/dist/main.js"], {
  env: {
    ...process.env,
    // e2e must never touch the shared tmux server, and the boot doctor must
    // not print into output anything here reads.
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
    [E.CONFIG_DIR]: join(ROOT, "config"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
process.on("exit", () => { try { host.kill("SIGKILL"); } catch { /* already gone */ } });

const api = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json, and that is a fact too */ }
  return { status: res.status, body };
};
const post = (path, body = {}, headers = {}) =>
  api(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

await waitForHost(PORT);

// ── §1 the survey and the per-repo sweep are one function ───────────────────
const survey = (await api("/api/storage/transport")).body;
const rows = survey?.repos ?? [];
check(rows.length === 2, `both scratch repos are in the survey (got ${rows.map((r) => r.repoName).join(", ") || "none"})`);
check(rows[0]?.repoName === "fat", `the biggest repo is ranked first (got ${rows[0]?.repoName})`);
check(survey?.partial === false, "nothing was uncounted, so the total is a total and not a floor");
check(survey?.total?.count === 6 && survey?.total?.bytes === 12_540,
  `the total is every transport file in both repos (got ${JSON.stringify(survey?.total)})`);

const fat = rows.find((r) => r.repoName === "fat");
const sweep = (await api(`/api/repos/${fat.repoId}/sweep?scope=outbox`)).body;
// THE assertion this script exists for. Both numbers are `listTransport`'s, and
// the survey row is what a person taps to reach that sweep.
check(fat.outbox.count === sweep.total.count && fat.outbox.bytes === sweep.total.bytes,
  `the survey's outbox figure equals the sweep's own total (${JSON.stringify(fat.outbox)} vs ${JSON.stringify(sweep.total)})`);
check(fat.inbox.count === 1 && fat.inbox.bytes === 500,
  `the two scopes are separate numbers, never folded (got ${JSON.stringify(fat.inbox)})`);

// ── §2 a look is not a change ───────────────────────────────────────────────
await api("/api/storage/transport");
await api("/api/storage/host");
const again = (await api(`/api/repos/${fat.repoId}/sweep?scope=outbox`)).body;
check(again.total.count === sweep.total.count,
  `reading either report left every file where it was (${again.total.count} of ${sweep.total.count})`);

// ── §3 the desktop's own store, classified ──────────────────────────────────
const store = (await api("/api/storage/host")).body;
const row = (id) => (store?.rows ?? []).find((r) => r.id === id);
check(store?.dir === STORE, `the report names the directory it is about (got ${store?.dir})`);
check(row("rollback")?.count === 1 && row("rollback")?.bytes === 120,
  `the leftover is a row of its own (got ${JSON.stringify(row("rollback"))})`);
check(!row("rollback")?.cant, "…and it is the one that may be cleared");
check(!!row("ledgers")?.cant && !!row("tokenstats")?.cant && !!row("live")?.cant,
  "every record and every live store says in words why it is not offered");
check(/no bound of its own/.test(row("tokenstats")?.cant ?? ""),
  "the unbounded store is named as such — that is the finding this report exists for");

// ── §4 a clear takes an id and an instant, and refuses everything else ──────
const ledger = await post("/api/storage/host/clear", { store: "ledgers", at: Date.now() + 1000 });
check(ledger.status === 200 && ledger.body?.deleted === 0 && !!ledger.body?.refused,
  `a ledger is refused in WORDS at 200, not at a 4xx (got ${ledger.status} ${JSON.stringify(ledger.body?.refused ?? null)})`);
check(existsSync(join(STORE, "sent.json")), "…and the ledger is still on disk");

const traversal = await post("/api/storage/host/clear", { store: "../../etc", at: Date.now() + 1000 });
check(traversal.status === 200 && !!traversal.body?.refused && traversal.body?.deleted === 0,
  "a path where a catalogue id belongs is simply not a catalogue id");

const noAt = await post("/api/storage/host/clear", { store: "rollback" });
check(noAt.status === 400, `a clear with no instant is refused outright (got ${noAt.status})`);

// ── §5 `at` is the contract ─────────────────────────────────────────────────
// A second leftover, written AFTER the report above was taken. It must survive
// a clear carrying that report's instant: it was never on the screen anybody
// approved.
const later = join(STORE, "launches.json.migrated");
writeFileSync(later, "x".repeat(60));
const future = Date.now() / 1000 + 600;
utimesSync(later, future, future);
const cleared = await post("/api/storage/host/clear", { store: "rollback", at: store.at });
check(cleared.status === 200 && cleared.body?.deleted === 1 && cleared.body?.bytes === 120,
  `the clear removed exactly what the report showed (got ${JSON.stringify(cleared.body)})`);
check(!existsSync(join(STORE, "intents.json.bak")), "…the leftover that was on screen is gone");
check(existsSync(later), "…and the one written since the reading survived");

// ── §6 the security line ────────────────────────────────────────────────────
// It deletes, so it is POST. A GET of the same path must not be a second door
// to it — that is what keeps a cross-origin `<img src>`, which carries no
// `Origin` for `origin.ts` to judge, from firing a delete.
const asGet = await api("/api/storage/host/clear");
check(asGet.status === 404, `the clear is not reachable by GET (got ${asGet.status})`);

const crossOrigin = await post("/api/storage/host/clear", { store: "rollback", at: Date.now() }, { origin: "https://evil.example" });
check(crossOrigin.status === 403, `a cross-origin clear is refused by the origin guard (got ${crossOrigin.status})`);
const crossRead = await api("/api/storage/transport", { headers: { origin: "https://evil.example" } });
check(crossRead.status === 403, `…and so is a cross-origin read of the survey (got ${crossRead.status})`);

host.kill("SIGKILL");
console.log(failed ? "\nSOME CHECKS FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
