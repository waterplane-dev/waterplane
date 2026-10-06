// Auto-download: the rule engine that decides what the phone fetches on its own,
// the persisted queue that survives the phone being offline when the file lands,
// and the STREAMING byte-range serve that makes a resume cost only what is left.
//
// The transport half is the point of the feature, so the assertions are about
// exact bytes and status codes, not "did it 200": a resume that silently returns
// the whole file, or an unsatisfiable range that falls through to a 200, both
// produce a corrupt download that looks complete.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8807;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-pull-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
let host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const die = (m) => { console.error("FAIL:", m); try { host.kill(); } catch {} process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One WS round-trip: send `msg`, resolve on the first frame `want` matches.
 *  NOTE: `hello` already pushes a `pull.list`, so a predicate that only checks
 *  `m.t` can resolve on the pre-send snapshot. Match on CONTENT. */
function ask(msg, want, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("timeout waiting for " + JSON.stringify(msg))); }, timeout);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "welcome") { ws.send(JSON.stringify(msg)); return; }
      if (want(m)) { clearTimeout(timer); ws.close(); resolve(m); }
    });
    ws.on("error", reject);
  });
}

bootWait(PORT, 1200, async () => {
  try {
    await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pullrepo" }) }).then((r) => r.json());
    const target = (await fetch(`${base}/api/repos`).then((r) => r.json())).targets[0];
    const { id: repoId, worktreePath: wt } = target;

    // ── the rule round-trips and persists where the project can see it ──
    const cfg = { enabled: true, scope: "outbox", match: ["*.apk", "report-*.md"], maxBytes: 4 * 1024 * 1024, builds: true };
    const saved = await ask({ t: "pull.save", repoDir: wt, config: cfg }, (m) => m.t === "pull.config" && m.repoDir === wt);
    check(saved.config.enabled === true && saved.config.match.length === 2 && saved.config.maxBytes === cfg.maxBytes, "rule saved and echoed back");
    const onDisk = JSON.parse(readFileSync(join(wt, STATE, "autopull.json"), "utf8"));
    check(onDisk.match[0] === "*.apk" && onDisk.scope === "outbox", "rule persisted to <repo>/<state>/autopull.json");
    const fetched = await ask({ t: "pull.get", repoDir: wt }, (m) => m.t === "pull.config" && m.repoDir === wt);
    check(fetched.config.match.join() === "*.apk,report-*.md", "rule reads back over the wire");

    // A hand-edited/garbage rule must not take the host down or become a wildcard.
    const junk = await ask({ t: "pull.save", repoDir: wt, config: { enabled: "yes", scope: "everything", match: "nope", maxBytes: -5 } }, (m) => m.t === "pull.config" && m.repoDir === wt);
    check(junk.config.scope === "outbox" && Array.isArray(junk.config.match) && junk.config.match.length === 0, "a malformed rule is sanitized, not trusted");
    await ask({ t: "pull.save", repoDir: wt, config: cfg }, (m) => m.t === "pull.config" && m.repoDir === wt);

    // ── manual queueing: the gallery's "to phone" button ────────────
    const outbox = join(wt, ".claude", "outbox");
    mkdirSync(outbox, { recursive: true });
    // 5 MB: over the streaming threshold AND over the rule's 4 MB cap, so it
    // exercises both the stream path and the "too big for the rule" branch.
    const big = randomBytes(5 * 1024 * 1024);
    writeFileSync(join(outbox, "app-e2e.apk"), big);
    writeFileSync(join(outbox, "notes.txt"), "not a match");

    const listed = await ask({ t: "pull.add", repoId, relPath: ".claude/outbox/app-e2e.apk" },
      (m) => m.t === "pull.list" && m.items.some((i) => i.name === "app-e2e.apk"));
    const manual = listed.items.find((i) => i.name === "app-e2e.apk");
    check(!!manual && manual.source === "manual", "a manual add queues the file even though it is over the rule's size cap");
    check(manual.size === big.length && manual.repoId === repoId, "queued item carries the real size + repo id");

    // The phone supplies the path, so it must never reach outside the worktree.
    const escaped = await ask({ t: "pull.add", repoId, relPath: "../../../etc/hosts" }, (m) => m.t === "toast");
    check(/can't queue/.test(escaped.text), "a traversing path is refused, not queued");

    // ── the queue survives a host RESTART ───────────────────────────
    // This is the whole reason it is on disk: `npm run restart` is routine, and a
    // queue a restart empties silently drops exactly the pull you were waiting for.
    check(existsSync(join(ROOT, STATE, "pulls.json")), "queue persisted to <root>/<state>/pulls.json");
    host.kill();
    await sleep(600);
    host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
    host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
    await sleep(1200);
    const afterBoot = await ask({ t: "pull.list" }, (m) => m.t === "pull.list" && m.items.length > 0);
    check(afterBoot.items.some((i) => i.name === "app-e2e.apk"), "queued pull survives a host restart");

    // A re-add of the same file must not duplicate it — the id is derived from
    // repo+path+mtime precisely so a re-detect is the same entry.
    const readd = await ask({ t: "pull.add", repoId, relPath: ".claude/outbox/app-e2e.apk" },
      (m) => m.t === "pull.list" && m.items.some((i) => i.name === "app-e2e.apk"));
    check(readd.items.filter((i) => i.name === "app-e2e.apk").length === 1, "re-adding the same file does not queue it twice");

    // ── streaming byte-range serve (the resumable transport) ────────
    const url = `${base}/api/repos/${repoId}/artifact?path=${encodeURIComponent(".claude/outbox/app-e2e.apk")}&download=1`;

    const whole = await fetch(url);
    const wholeBuf = Buffer.from(await whole.arrayBuffer());
    check(whole.status === 200 && wholeBuf.length === big.length && wholeBuf.equals(big), `full download is the exact file (${big.length} B)`);
    check(whole.headers.get("accept-ranges") === "bytes", "a big file advertises accept-ranges (without it, a resume is impossible)");
    check(/attachment; filename="app-e2e.apk"/.test(whole.headers.get("content-disposition") || ""), "download=1 still forces a save-as on the streamed path");
    check(!whole.headers.get("content-encoding"), "a streamed binary is not compressed");

    // The resume: ask for the tail and get exactly the tail.
    const at = 3_000_000;
    const tail = await fetch(url, { headers: { range: `bytes=${at}-` } });
    const tailBuf = Buffer.from(await tail.arrayBuffer());
    check(tail.status === 206, "a Range request answers 206, not the whole file");
    check(tailBuf.length === big.length - at && tailBuf.equals(big.subarray(at)), "the resumed range is exactly the missing bytes");
    check(tail.headers.get("content-range") === `bytes ${at}-${big.length - 1}/${big.length}`, "content-range names the real total");

    // A bounded middle slice (what a chunked downloader asks for).
    const mid = await fetch(url, { headers: { range: "bytes=100-199" } });
    const midBuf = Buffer.from(await mid.arrayBuffer());
    check(mid.status === 206 && midBuf.length === 100 && midBuf.equals(big.subarray(100, 200)), "a bounded range returns exactly that slice");

    // Unsatisfiable must be 416. A 200 here would make a resuming client APPEND
    // the whole file to what it already has and call the result complete.
    const past = await fetch(url, { headers: { range: `bytes=${big.length + 10}-` } });
    check(past.status === 416, "a range past the end is 416, not a silent full body");

    // `if-range`: a resume says "continue ONLY if this is still the same file".
    // A stale validator must fall back to the whole body — answering 206 with
    // bytes from a rebuilt file makes the client append them to the old prefix
    // and end up with a corrupt artifact that passes every check it can make.
    const etag = whole.headers.get("etag");
    check(!!etag, "an artifact carries an etag (the resume validator)");
    const stale = await fetch(url, { headers: { range: `bytes=${at}-`, "if-range": '"not-the-same-file"' } });
    const staleBuf = Buffer.from(await stale.arrayBuffer());
    check(stale.status === 200 && staleBuf.length === big.length,
      "a stale if-range gets the WHOLE file back (200), never a 206 of the new build");
    const fresh = await fetch(url, { headers: { range: `bytes=${at}-`, "if-range": etag } });
    check(fresh.status === 206 && Buffer.from(await fresh.arrayBuffer()).length === big.length - at,
      "a matching if-range still resumes");

    // The same two rules on the BUFFERED path (small artifacts skip streaming) —
    // a resuming client cannot tell which path served it.
    const smallRel = ".claude/outbox/note-e2e.txt";
    const smallBody = Buffer.from("x".repeat(5000));
    writeFileSync(join(outbox, "note-e2e.txt"), smallBody);
    const surl = `${base}/api/repos/${repoId}/artifact?path=${encodeURIComponent(smallRel)}&download=1`;
    const spast = await fetch(surl, { headers: { range: `bytes=${smallBody.length + 10}-` } });
    check(spast.status === 416, "a small file answers 416 past the end too (not a 206 of the whole body)");
    const sstale = await fetch(surl, { headers: { range: "bytes=100-", "if-range": '"stale"' } });
    check(sstale.status === 200 && Buffer.from(await sstale.arrayBuffer()).length === smallBody.length,
      "a stale if-range on a small file returns the whole body");

    // ── the rule actually filters ───────────────────────────────────
    // Drive `consider` the way the host does, through the manual path's sibling:
    // start a session in the repo so the turn-end scan has a baseline, then drop
    // files and let the stub finish a turn.
    const ws = new WebSocket(`${base}/ws`);
    const created = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("session never started")), 8000);
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd: wt, cols: 80, rows: 24 }));
        if (m.t === "session.created") { clearTimeout(timer); resolve(m.session); }
      });
      ws.on("error", reject);
    });

    // Files dropped AFTER the session's baseline snapshot: one matching and small
    // enough, one matching but over the cap, one not matching at all.
    const pulled = new Promise((resolve) => {
      const t = setTimeout(() => resolve([]), 25000);
      const seen = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "pull.new") {
          seen.push(m.item);
          clearTimeout(t);
          setTimeout(() => resolve(seen), 1500); // let any siblings arrive too
        }
      });
    });
    await sleep(500);
    writeFileSync(join(outbox, "report-turn.md"), "# produced this turn\n");
    writeFileSync(join(outbox, "huge.apk"), randomBytes(5 * 1024 * 1024));
    writeFileSync(join(outbox, "ignored.log"), "no rule matches this");
    // Nudge the session so it produces output and the turn-end scan runs.
    ws.send(JSON.stringify({ t: "session.input", id: created.id, data: "hello\r" }));

    const got = await pulled;
    const names = got.map((i) => i.name);
    check(names.includes("report-turn.md"), `a matching new outbox file is queued on its own (saw: ${names.join(", ") || "nothing"})`);
    check(!names.includes("ignored.log"), "a file no pattern matches is not queued");
    check(!names.includes("huge.apk"), "a matching file over the size cap is not queued");
    check(got.every((i) => i.source === "outbox"), "auto-queued items are tagged with where they came from");

    // ── newest-only: an older build of the same artifact is dropped ──
    // The failure this exists for: an APK named with the build's hash is a NEW
    // path every time, so five rebuilds over an afternoon queue five 23 MB files
    // and the phone (one download at a time) spends 115 MB to reach the one it
    // actually wants — which is LAST in the queue.
    const { familyKey } = await import("../packages/host/dist/autopull.js");
    check(familyKey(".claude/outbox/tiptoi-debug-0f98c1ab.apk") === familyKey(".claude/outbox/tiptoi-debug-39a2f7e1.apk"),
      "two hash-named builds of the same artifact share a family");
    check(familyKey(".claude/outbox/app-debug.apk") !== familyKey(".claude/outbox/app-release.apk"),
      "a debug and a release build are NOT the same artifact");
    check(familyKey(".claude/outbox/app.apk") !== familyKey(".claude/outbox/app.aab"),
      "the extension is part of the identity");
    check(familyKey(".claude/outbox/report.md") !== familyKey("docs/report.md"),
      "the directory is part of the identity");
    check(familyKey("out/1000074170.jpg") !== familyKey("out/1000074171.jpg"),
      "an all-variable name falls back to the exact path, so unrelated photos never merge");
    check(familyKey("out/facade-1.zip") === familyKey("out/facade-2.zip"),
      "a hex-looking WORD stays stable (only hashes containing a digit are folded out)");
    check(familyKey("out/build_2.apk") === familyKey("out/build.apk"),
      "the _N uniquifier suffix is not a different artifact");

    await ask({ t: "pull.dismiss" }, (m) => m.t === "pull.list" && m.items.length === 0);
    const builds = ["tiptoi-debug-0f98c1ab.apk", "tiptoi-debug-39a2f7e1.apk", "tiptoi-debug-d03bd7c9.apk"];
    const t0 = Math.floor(Date.now() / 1000) - 600;
    builds.forEach((n, i) => {
      writeFileSync(join(outbox, n), randomBytes(1024));
      utimesSync(join(outbox, n), t0 + i * 60, t0 + i * 60); // distinct, ascending mtimes
    });
    // A sibling artifact built LAST — it must survive, or "newest only" would
    // mean "keep one file per repo".
    writeFileSync(join(outbox, "tiptoi-release-aa11bb22.apk"), randomBytes(1024));
    utimesSync(join(outbox, "tiptoi-release-aa11bb22.apk"), t0 + 300, t0 + 300);

    for (const n of builds) {
      await ask({ t: "pull.add", repoId, relPath: `.claude/outbox/${n}` },
        (m) => m.t === "pull.list" && m.items.some((i) => i.name === n));
    }
    const afterSup = await ask({ t: "pull.add", repoId, relPath: ".claude/outbox/tiptoi-release-aa11bb22.apk" },
      (m) => m.t === "pull.list" && m.items.some((i) => i.name === "tiptoi-release-aa11bb22.apk"));
    const apkNames = afterSup.items.filter((i) => i.name.endsWith(".apk")).map((i) => i.name);
    check(apkNames.includes("tiptoi-debug-d03bd7c9.apk"), "the newest build stays queued");
    check(!apkNames.includes("tiptoi-debug-0f98c1ab.apk") && !apkNames.includes("tiptoi-debug-39a2f7e1.apk"),
      `older builds of the same artifact are dropped (queue: ${apkNames.join(", ")})`);
    check(apkNames.includes("tiptoi-release-aa11bb22.apk"), "a newer SIBLING artifact does not eat the other family");
    const newest = afterSup.items.find((i) => i.name === "tiptoi-debug-d03bd7c9.apk");
    // One, not two: each add drops the previous build as it lands, so by the time
    // build 3 is queued build 1 is already gone. The client follows the same
    // chain live, and reconciles by family on reconnect for the ids it missed.
    check((newest?.supersedes || []).length === 1, "the surviving item names the id it replaced (so the phone can cancel that download)");
    check(typeof newest?.family === "string" && newest.family.includes("tiptoi-debug"), "queued items carry their family key");

    // Turning the rule off leaves both versions queued — the escape hatch.
    await ask({ t: "pull.save", repoDir: wt, config: { ...cfg, supersede: false } }, (m) => m.t === "pull.config" && m.repoDir === wt);
    writeFileSync(join(outbox, "tiptoi-debug-ffee1122.apk"), randomBytes(1024));
    utimesSync(join(outbox, "tiptoi-debug-ffee1122.apk"), t0 + 900, t0 + 900);
    const noSup = await ask({ t: "pull.add", repoId, relPath: ".claude/outbox/tiptoi-debug-ffee1122.apk" },
      (m) => m.t === "pull.list" && m.items.some((i) => i.name === "tiptoi-debug-ffee1122.apk"));
    check(noSup.items.some((i) => i.name === "tiptoi-debug-d03bd7c9.apk"),
      "with newest-only off, an older build is kept");

    // ── a rule switched ON catches up with what is already here ────
    // The miss this exists for is one minute wide: a rule saved at 10:43 for
    // the 227 MB APK a build finished at 10:42 queued nothing, ever, silently —
    // every other path here only sees a file produced AFTER the rule existed.
    await ask({ t: "pull.dismiss" }, (m) => m.t === "pull.list" && m.items.length === 0);
    await ask({ t: "pull.save", repoDir: wt, config: { ...cfg, enabled: false } }, (m) => m.t === "pull.config" && m.repoDir === wt);
    writeFileSync(join(outbox, "already-here-1.0.0.apk"), randomBytes(1024));
    const caughtToast = await ask({ t: "pull.save", repoDir: wt, config: cfg }, (m) => m.t === "toast");
    check(/fetching/.test(caughtToast.text), `switching the rule on says what it queued (said: ${caughtToast.text})`);
    const caught = await ask({ t: "pull.list" }, (m) => m.t === "pull.list" && m.items.length > 0);
    check(caught.items.some((i) => i.name === "already-here-1.0.0.apk"),
      `a file that was already on disk is queued when the rule is switched on (queue: ${caught.items.map((i) => i.name).join(", ") || "empty"})`);

    // …and a rule that matches nothing yet SAYS so. Silence here is the same
    // defect as the miss above: a switch that looks like it did nothing.
    await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pullrepo2" }) }).then((r) => r.json());
    const wt2 = (await fetch(`${base}/api/repos`).then((r) => r.json())).targets.find((t) => t.repoName === "pullrepo2").worktreePath;
    const empty = await ask({ t: "pull.save", repoDir: wt2, config: cfg }, (m) => m.t === "toast");
    check(/nothing here matches yet/.test(empty.text), `an empty catch-up says so rather than nothing (said: ${empty.text})`);

    // ── dismiss clears it ───────────────────────────────────────────
    const cleared = await ask({ t: "pull.dismiss" }, (m) => m.t === "pull.list" && m.items.length === 0);
    check(cleared.items.length === 0, "dismiss with no id clears the whole queue");

    try { ws.close(); } catch {}
    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  } catch (e) {
    die(String(e?.stack || e));
  }
});

setTimeout(() => die("timeout — auto-pull e2e did not finish"), 70000);
