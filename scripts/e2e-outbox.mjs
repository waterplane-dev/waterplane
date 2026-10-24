// Outbox artifact notification + download-disposition check, plus the VERB:
// the alert has to promise what a tap actually does — a report the phone can
// paint says "tap to read", an APK says "tap to download" (host `readsInline`,
// web `docKind.ts`).
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-outbox-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_PING_MS]: "600" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
// Both drops must be announced, and each with its own verb — module scope so
// the timeout can say WHICH one never arrived.
let seenDoc = false, seenApk = false;

bootWait(PORT, 800, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "outbox" }) }).then((r) => r.json());
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  const wt = repos.targets[0].worktreePath, rid = repos.targets[0].id;

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let sid = null;
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd: wt, cols: 80, rows: 24 }));
    else if (m.t === "session.created" && !sid) {
      sid = m.session.id;
      // Drop an "APK" into the outbox mid-session, then poke the PTY so a turn ends (idle scan runs).
      setTimeout(() => {
        mkdirSync(join(wt, ".claude", "outbox"), { recursive: true });
        writeFileSync(join(wt, ".claude", "outbox", "app-299.apk"), Buffer.alloc(2048, 7));
        writeFileSync(join(wt, ".claude", "outbox", "report-299.md"), "# report\n\nreadable on the phone.\n");
        ws.send(JSON.stringify({ t: "session.input", id: sid, data: "echo done\r" }));
      }, 700);
    } else if (m.t === "notification" && m.item.kind === "artifact") {
      console.log("notification:", m.item.title, "·", m.item.body);
      const f = m.item.file;
      if (!f || f.repoId !== rid) fail("file ref wrong: " + JSON.stringify(f));
      if (f.name === "report-299.md") {
        if (!/tap to read/.test(m.item.body)) fail("a markdown drop must offer to be READ: " + m.item.body);
        console.log("PASS: the markdown drop's alert says tap to read");
        seenDoc = true;
        return;
      }
      if (f.name !== "app-299.apk") fail("unexpected artifact: " + f.name);
      if (!/tap to download/.test(m.item.body)) fail("an APK is a download: " + m.item.body);
      const res = await fetch(`http://127.0.0.1:${PORT}/api/repos/${f.repoId}/artifact?path=${encodeURIComponent(f.relPath)}&download=1`);
      const dispo = res.headers.get("content-disposition") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (!/attachment; filename="app-299.apk"/.test(dispo)) fail("bad disposition: " + dispo);
      if (buf.length !== 2048) fail("bad bytes: " + buf.length);
      // H1: repo bytes on the host origin must not run as the host. Buffered, ranged, and 304-less.
      const url = `http://127.0.0.1:${PORT}/api/repos/${f.repoId}/artifact?path=`;
      for (const [label, r] of [["download", res], ["inline", await fetch(url + encodeURIComponent(f.relPath))],
        ["ranged", await fetch(url + encodeURIComponent(f.relPath), { headers: { range: "bytes=0-9" } })]]) {
        const csp = r.headers.get("content-security-policy") || "";
        if (r.headers.get("x-content-type-options") !== "nosniff") fail(label + ": no nosniff");
        if (!/(^|; )sandbox allow-scripts(;|$)/.test(csp) || /allow-same-origin/.test(csp)) fail(label + ": csp sandbox: " + csp);
        if (!/connect-src 'none'/.test(csp) || !/form-action 'none'/.test(csp)) fail(label + ": csp exfil: " + csp);
        if (r !== res) await r.arrayBuffer();
      }
      console.log("PASS: artifact responses carry nosniff + sandboxed CSP (download, inline, ranged)");
      // The git sheet's picture route serves an .svg too: same sandbox, never script on the host origin.
      writeFileSync(join(wt, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
      const blob = await fetch(`http://127.0.0.1:${PORT}/api/repos/${f.repoId}/git/blob/x?path=logo.svg&side=new`);
      const bcsp = blob.headers.get("content-security-policy") || "";
      await blob.arrayBuffer();
      if (blob.status !== 200 || !/(^|; )sandbox allow-scripts(;|$)/.test(bcsp) || /allow-same-origin/.test(bcsp)) fail("git/blob svg: " + blob.status + " csp: " + bcsp);
      console.log("PASS: git/blob serves an svg under the sandboxed CSP");
      console.log("PASS: outbox artifact notification with working download link (attachment, 2048 B)");
      seenApk = true;
      // Both alerts are wanted; whichever lands second ends the run.
      if (seenDoc) { host.kill(); process.exit(0); }
    }
  });
});
watchdog(() => fail(`timeout — artifact notification missing (md=${seenDoc}, apk=${seenApk})`));
