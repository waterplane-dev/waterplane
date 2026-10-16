// The conversation ARCHIVE, and the reopen stack that survives a restart.
//
// Closing a session is not a delete — the CLI's conversation log stays on disk
// and reopens with `--resume`. Two things make that true in practice, and both
// are asserted here:
//
//  - `/api/repos/:id/archive` lists every conversation on disk for a repo,
//    newest first, titled by its FIRST REAL PROMPT (slash plumbing, hook echoes
//    and tool-result records must not become a row's name), with `q` search,
//    paging, and a delete that refuses anything but a bare conversation id.
//  - the recently-closed shortlist is persisted (`<state>/closed.json`), so a host
//    restart — routine here — no longer turns the route back into a needle in
//    ~/.claude/projects.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait, waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8836;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-archive-`));
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-archivehome-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_HOME]: HOME,
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.IDLE_MS]: "600", [E.IDLE_PING_MS]: "400",
};
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (p) => fetch(base + p).then((r) => r.json());
const startHost = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
let host = startHost();
const finish = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 150); };

const user = (uuid, content, extra = {}) => ({ type: "user", uuid, timestamp: new Date(1e12).toISOString(), message: { role: "user", content }, ...extra });
const asst = (uuid, content) => ({ type: "assistant", uuid, timestamp: new Date(1e12).toISOString(), message: { role: "assistant", content } });

/** Write a conversation log where the CLI would keep it, with a chosen mtime so
 *  the newest-first order is a fact and not a race between two writes. */
function writeLog(cwd, convId, records, mtimeSec) {
  const dir = join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, convId + ".jsonl");
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (mtimeSec) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

bootWait(PORT, 1200, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "arch" }) }).then((r) => r.json());
    const repoId = (await j("/api/repos")).targets[0].id;

    // ── Three conversations, oldest to newest, plus the awkward shapes ──
    writeLog(repo.path, "aaaaaaaa-0000-0000-0000-000000000001", [
      user("u1", "Fix the scroll jank in the terminal"),
      asst("a1", [{ type: "text", text: "ok" }]),
    ], 1_600_000_000);
    // The first records are NOT prompts: a slash-command envelope, a hook echo,
    // a meta record and a tool result. A row titled `<command-name>` is the bug.
    writeLog(repo.path, "aaaaaaaa-0000-0000-0000-000000000002", [
      { type: "mode", mode: "normal" },
      user("u0", "<command-name>/context</command-name>"),
      user("u0b", "<user-prompt-submit-hook>noise</user-prompt-submit-hook>"),
      user("u0c", "a meta record", { isMeta: true }),
      user("u0d", [{ type: "tool_result", tool_use_id: "t9", content: "output" }]),
      user("u1", "Write the release notes for the schedule sheet"),
    ], 1_600_000_100);
    // A conversation that was opened and never typed into: no prompt at all.
    writeLog(repo.path, "aaaaaaaa-0000-0000-0000-000000000003", [
      { type: "mode", mode: "normal" },
      asst("a1", [{ type: "text", text: "hello" }]),
    ], 1_600_000_200);

    const list = await j(`/api/repos/${repoId}/archive`);
    check(list.scanned === 3, `all three conversations are listed (got ${list.scanned})`);
    check(list.rows.map((r) => r.id.slice(-1)).join("") === "321", `newest first by log mtime (got ${list.rows.map((r) => r.id.slice(-1)).join("")})`);
    const byId = Object.fromEntries(list.rows.map((r) => [r.id.slice(-1), r]));
    check(byId["1"].title === "Fix the scroll jank in the terminal", `titled by its first prompt (got ${JSON.stringify(byId["1"].title)})`);
    check(byId["2"].title === "Write the release notes for the schedule sheet",
      `slash plumbing / hook echo / meta / tool-result records never become the title (got ${JSON.stringify(byId["2"].title)})`);
    check(byId["3"].title === "", "a conversation with no prompt gets an empty title, not a crash");
    check(byId["1"].cwd === repo.path && byId["1"].size > 0 && byId["1"].mtime > 0, "rows carry cwd, size and mtime");

    // ── Search: filters on the title, and says how much it looked at ──
    const hit = await j(`/api/repos/${repoId}/archive?q=${encodeURIComponent("release notes")}`);
    check(hit.total === 1 && hit.rows[0].id.endsWith("002"), `q filters on the first prompt (total ${hit.total})`);
    check(hit.scanned === 3, "scanned still reports everything on disk, so the UI can say N of M");
    const miss = await j(`/api/repos/${repoId}/archive?q=nothingmatchesthis`);
    check(miss.total === 0 && miss.rows.length === 0, "a query that matches nothing returns no rows (not everything)");
    const caseless = await j(`/api/repos/${repoId}/archive?q=SCROLL%20JANK`);
    check(caseless.total === 1, "search is case-insensitive");

    // ── Paging: offset + limit over the same newest-first order ──
    const p1 = await j(`/api/repos/${repoId}/archive?limit=2`);
    const p2 = await j(`/api/repos/${repoId}/archive?limit=2&offset=2`);
    check(p1.rows.length === 2 && p2.rows.length === 1, `paging splits 3 rows as 2+1 (got ${p1.rows.length}+${p2.rows.length})`);
    check(p1.total === 3 && p2.offset === 2, "each page reports the full total and its own offset");
    check(!p1.rows.some((r) => p2.rows.some((x) => x.id === r.id)), "pages don't overlap");

    // ── A live session's conversation is in the archive too ──
    // The phone needs it there to mark the row "open now"; hiding it would make
    // the list disagree with the session list.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null, conv = null, closedList = null, sessionList = null, born = [];
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") { born.push(m.session); if (!sid) { sid = m.session.id; conv = m.session.claudeSessionId; } }
      if (m.t === "closed.list") closedList = m.closed;
      if (m.t === "session.list") sessionList = m.sessions;
    });
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "live one", cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && !sid; i++) await sleep(100);
    check(!!conv, "live session minted a conversation id");
    writeLog(repo.path, conv, [user("u1", "the live conversation")], 1_600_000_300);
    const withLive = await j(`/api/repos/${repoId}/archive`);
    check(withLive.rows[0].id === conv, "a live session's conversation is listed too (newest), so the UI can mark it open");

    // ── Delete: the one destructive verb, and it is guarded ──
    const badId = await fetch(`${base}/api/repos/${repoId}/archive?id=${encodeURIComponent("../../../etc/passwd")}`, { method: "DELETE" });
    check(badId.status === 400, `a traversal id is refused (got ${badId.status})`);
    const absent = await fetch(`${base}/api/repos/${repoId}/archive?id=aaaaaaaa-0000-0000-0000-00000000dead`, { method: "DELETE" });
    check(absent.status === 400, "deleting a conversation that isn't there is refused, not a 500");
    const delRes = await fetch(`${base}/api/repos/${repoId}/archive?id=aaaaaaaa-0000-0000-0000-000000000001`, { method: "DELETE" }).then((r) => r.json());
    check(delRes.ok === true, "deleting an archived conversation succeeds");
    const after = await j(`/api/repos/${repoId}/archive`);
    check(!after.rows.some((r) => r.id.endsWith("001")), "the deleted conversation is gone from the listing");
    check(!existsSync(join(HOME, ".claude", "projects", repo.path.replace(/[^a-zA-Z0-9]/g, "-"), "aaaaaaaa-0000-0000-0000-000000000001.jsonl")),
      "…and gone from disk");

    // ── `session.remove` on a RUNNING session: kill AND de-list, in one act ──
    // The phone's × is one tap and means one thing — "archive this". `kill`
    // alone stops the process and leaves the row in `session.list()` as
    // `exited`, which is what made that tap look like it did nothing (and, on
    // the phone, hid the row's own "Recently closed" entry, since a listed
    // session counts as its conversation being open). Assert both halves.
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "one to archive", cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && born.length < 2; i++) await sleep(100);
    const doomed = born[1];
    check(!!doomed, "a second session was created to archive");
    closedList = null; sessionList = null;
    ws.send(JSON.stringify({ t: "session.remove", id: doomed?.id }));
    for (let i = 0; i < 40 && !(sessionList && closedList); i++) await sleep(100);
    check(!!sessionList && !sessionList.some((x) => x.id === doomed?.id), "session.remove takes a RUNNING session straight off the list");
    check((closedList ?? []).some((c) => c.id === doomed?.id), "…and puts it on the recently-closed stack, so the route back is there");
    for (let i = 0; i < 40 && !(closedList ?? []).find((c) => c.id === doomed?.id)?.closedBy; i++) await sleep(100);
    const doomedRow = (closedList ?? []).find((c) => c.id === doomed?.id);
    check(doomedRow?.closedBy === "you" && doomedRow?.kind === "hand",
      `a person's × is closedBy "you" on a session opened by hand (${doomedRow?.closedBy}/${doomedRow?.kind})`);
    check(typeof doomedRow?.openedAt === "number", "…with when it was opened");

    // ── A session whose process ends ON ITS OWN says so, with its exit code ──
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "one that exits", cols: 80, rows: 24 }));
    for (let i = 0; i < 40 && born.length < 3; i++) await sleep(100);
    const exiting = born[2];
    await sleep(400);
    ws.send(JSON.stringify({ t: "session.input", id: exiting?.id, data: "exit 3\r" }));
    let exitedRow = null;
    for (let i = 0; i < 50 && !exitedRow; i++) { await sleep(100); exitedRow = (closedList ?? []).find((c) => c.id === exiting?.id) ?? null; }
    check(exitedRow?.closedBy === "exited", `a process that ended by itself is closedBy "exited" (got ${exitedRow?.closedBy})`);
    // The PTY is a tmux CLIENT, which exits 0 whatever the CLI did, so the CLI's
    // code is not known here — absent, never the client's 0 passed off as it.
    check(exitedRow?.exitCode === undefined, `…carrying no exit code it cannot know (got ${exitedRow?.exitCode})`);

    // An id the host doesn't know still gets the authoritative list back: the
    // client asking is holding a row for it (a snapshot rendered offline, or a
    // list from before a restart) and silence leaves that row on screen for good.
    sessionList = null;
    ws.send(JSON.stringify({ t: "session.remove", id: "no-such-session" }));
    for (let i = 0; i < 30 && !sessionList; i++) await sleep(100);
    check(!!sessionList, "session.remove for an unknown id is still answered with the session list");

    // ── Closing a session ARCHIVES it: log kept, entry on the reopen stack ──
    closedList = null;
    ws.send(JSON.stringify({ t: "session.kill", id: sid }));
    for (let i = 0; i < 40 && !closedList; i++) await sleep(100);
    const entry = (closedList ?? []).find((c) => c.id === sid);
    check(!!entry, "killing a session puts it on the recently-closed stack");
    check(entry?.claudeSessionId === conv, "the closed entry names the conversation, so a reopen resumes exactly it");
    check(entry?.closedBy === "you", `a person's kill is closedBy "you" (got ${entry?.closedBy})`);
    const stillThere = await j(`/api/repos/${repoId}/archive`);
    check(stillThere.rows.some((r) => r.id === conv), "closing a session does NOT delete its conversation");
    ws.close();

    check(existsSync(join(ROOT, STATE, "closed.json")), "the reopen stack is written to <state>/closed.json");

    // ── …and it survives a restart, which is the whole point ──
    host.kill();
    await new Promise((r) => host.once("exit", r));
    await sleep(900);
    host = startHost();
    await waitForHost(PORT);
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let closed2 = null;
    await new Promise((res, rej) => { ws2.on("open", res); ws2.on("error", rej); });
    ws2.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.t === "closed.list") closed2 = m.closed; });
    ws2.send(JSON.stringify({ t: "hello", protocol: 1 }));
    for (let i = 0; i < 40 && !closed2; i++) await sleep(100);
    const survivor = (closed2 ?? []).find((c) => c.id === sid);
    check(!!survivor, "the recently-closed stack survives a host restart");
    check(survivor?.claudeSessionId === conv, "…still naming the conversation to resume");
    check(survivor?.alive !== true, "a stack entry is never reported as still-running after a restart it did not survive");
    check(survivor?.closedBy === "you" && survivor?.kind === "hand", "…and still says why it closed and how it opened");
    const persisted = JSON.parse(readFileSync(join(ROOT, STATE, "closed.json"), "utf8"));
    check(Array.isArray(persisted) && persisted.some((c) => c.id === sid), "the persisted file holds the entry itself, not a marker");
    ws2.close();
  } catch (e) {
    check(false, `threw: ${e?.stack || e}`);
  }
  finish();
});

setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 40000);
