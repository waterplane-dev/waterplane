// Build buttons: configure a repo build, run it (no claude session), assert the
// output streams, the produced artifact is detected, and it downloads.
//
// Third phase: `build.scan` — the editor's free suggest list. What it must get
// right is what it REFUSES: a directory outside the root (contained like
// `build.list`), and a CI step carrying an unresolved `${{ }}` expression,
// which the workflow runner would have substituted and our shell would not.
//
// Second phase: a build that writes NOTHING still offers the artifact that is
// already there, flagged `stale`. That is the everyday incremental build —
// gradle prints BUILD SUCCESSFUL and "50 up-to-date" — and a strict
// "modified since the run started" rule answered zero artifacts for it, so a
// working setup looked like it had produced nothing at all.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SHARED, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8802;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-build-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };

// A build that writes an "APK" under a build/ dir (which the gallery skips but
// build-output detection descends) and prints a marker to stdout.
const MARKER = "BUILD_LOG_MARKER_42";
const ARTIFACT = "BUILDARTIFACT"; // 13 bytes
const CMD = `mkdir -p build/out && printf %s '${ARTIFACT}' > build/out/app-e2e.apk && echo ${MARKER}`;
// The up-to-date case: succeeds, touches nothing.
const CMD_NOOP = "echo everything up-to-date";

bootWait(PORT, 800, async () => {
  await fetch(`http://127.0.0.1:${PORT}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "buildrepo" }) }).then((r) => r.json());
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  const wt = repos.targets[0].worktreePath, rid = repos.targets[0].id;

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  let fired = false, sawOutput = false, sawMarker = false, sawOpAck = false;
  let phase = 1, firedNoop = false;

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      // Save one build config, then the broadcast build.list echoes it back.
      send({ t: "build.save", repoDir: wt, builds: [{ id: "b1", name: "apk", cmd: CMD }] });
    } else if (m.t === "build.list" && m.repoDir === wt) {
      if (phase === 1) {
        if (m.builds.length !== 1 || m.builds[0].id !== "b1" || m.builds[0].cmd !== CMD) fail("saved config not returned: " + JSON.stringify(m.builds));
        // A new entry with no `local` goes to the COMMITTED shared file, so the run
        // below is a shared-only entry running.
        let onDisk = null;
        try { onDisk = JSON.parse(readFileSync(join(wt, SHARED, "builds.json"), "utf8")); } catch { /* checked below */ }
        if (!Array.isArray(onDisk) || onDisk[0]?.id !== "b1") fail("a new build must land in the shared file: " + JSON.stringify(onDisk));
        if (existsSync(join(wt, STATE, "builds.json"))) fail("a new build must not be written to this desktop's own file");
        if (!Array.isArray(m.localIds) || m.localIds.length) fail("build.list must say no entry is local: " + JSON.stringify(m.localIds));
        if (!fired) { fired = true; send({ t: "build.run", repoDir: wt, buildId: "b1" }); }
      } else if (!firedNoop) {
        firedNoop = true;
        // Wait out the detector's 1 s clock slack, so the APK phase 1 wrote is
        // unambiguously OLDER than this run — which is the whole point of it.
        setTimeout(() => send({ t: "build.run", repoDir: wt, buildId: "b2" }), 1500);
      }
    } else if (m.t === "op.ack") {
      sawOpAck = true;
    } else if (m.t === "build.candidates") {
      if (m.repoDir !== wt) fail("build.scan answered for a directory outside the root: " + m.repoDir);
      const has = (cmd) => m.candidates.some((c) => c.cmd === cmd);
      if (!has("npm run build")) fail("package.json scripts not offered: " + JSON.stringify(m.candidates));
      if (!has("npm run test:unit")) fail("package.json scripts not offered: " + JSON.stringify(m.candidates));
      if (has("npm run postinstall")) fail("a lifecycle script is nobody's build button");
      if (!has("./scripts/pack.sh")) fail("the repo's own script not offered: " + JSON.stringify(m.candidates));
      // The one that matters: an unresolved workflow expression would reach
      // our shell verbatim, so the step carrying it is not a candidate.
      if (m.candidates.some((c) => c.cmd.includes("${{"))) fail("a CI step with an unresolved expression must not be suggested");
      if (has("npm ci")) fail("CI plumbing must not be suggested");
      const pack = m.candidates.find((c) => c.cmd === "./scripts/pack.sh");
      if (pack.name !== "pack the release") fail("a script is titled by its own first comment: " + pack.name);
      if (pack.source !== "scripts/pack.sh") fail("a candidate must say where it was read from: " + pack.source);
      if (typeof m.total !== "number" || m.total < m.candidates.length) fail("build.candidates must carry the pre-cap total: " + m.total);
      console.log(`PASS: build.scan read ${m.total} candidates out of the repo, refused the out-of-root dir, dropped CI plumbing and the \${{ }} step`);
      host.kill(); process.exit(0);
    } else if (m.t === "build.output") {
      sawOutput = true;
      const txt = Buffer.from(m.dataB64, "base64").toString("utf8");
      if (txt.includes(MARKER)) sawMarker = true;
    } else if (m.t === "build.run" && m.run.buildId === "b2" && (m.run.status === "done" || m.run.status === "failed")) {
      const r = m.run;
      if (r.status !== "done" || r.exitCode !== 0) fail("no-op build did not succeed: " + JSON.stringify(r));
      // The fallback offers what THIS build left in its own tree, never the
      // outbox copy: `.claude/` holds what every build collected, so a file
      // there is no evidence this build is up to date (ea7bea26). One entry,
      // flagged as not written by this run, and nothing re-collected.
      const arts = r.artifacts || [];
      const art = arts.find((a) => a.name === "app-e2e.apk");
      if (!art) fail("a build that wrote nothing must still offer the artifact already there: " + JSON.stringify(arts));
      if (art.relPath !== "build/out/app-e2e.apk") fail("the stale artifact is the build's own output: " + JSON.stringify(art));
      if (art.stale !== true) fail("a pre-existing artifact must be flagged stale (the run did not write it): " + JSON.stringify(art));
      if (!art.mtime) fail("a stale artifact must carry its mtime: " + JSON.stringify(art));
      if (arts.length !== 1) fail("a no-op build offers its own output once, nothing from the outbox: " + JSON.stringify(arts));
      console.log("PASS: an up-to-date build offers its own existing output once, flagged stale, never the outbox copy");

      // ── Phase 3: what this repo says it can build ──────────────────────
      // Files a real repo would have, written now so the scan has something
      // honest to read.
      writeFileSync(join(wt, "package.json"), JSON.stringify({
        scripts: { build: "tsc", "test:unit": "node --test", postinstall: "patch" },
      }));
      mkdirSync(join(wt, ".github", "workflows"), { recursive: true });
      writeFileSync(join(wt, ".github", "workflows", "ci.yml"), [
        "jobs:", "  ci:", "    steps:",
        "      - run: npm ci",
        "      - run: ./scripts/pack.sh",
        "      - run: ./publish.sh --token ${{ secrets.NPM }}",
      ].join("\n"));
      mkdirSync(join(wt, "scripts"), { recursive: true });
      writeFileSync(join(wt, "scripts", "pack.sh"), "#!/bin/bash\n# pack the release\n");

      // The refusal goes FIRST: a repoDir outside the root must be answered
      // with nothing at all, so if the only `build.candidates` that ever
      // arrives is the contained one, the gate held.
      send({ t: "build.scan", repoDir: "/etc" });
      send({ t: "build.scan", repoDir: wt });
      return;
    } else if (m.t === "build.run" && (m.run.status === "done" || m.run.status === "failed")) {
      const r = m.run;
      if (r.status !== "done" || r.exitCode !== 0) fail("build did not succeed: " + JSON.stringify(r));
      if (!sawOutput || !sawMarker) fail(`output not streamed (sawOutput=${sawOutput} sawMarker=${sawMarker})`);
      // What a run produced is COLLECTED before it is offered: one entry, in
      // `.claude/outbox/`, under a name carrying the repo, the variant and an
      // identifier for this build (`shared/artifacts.ts`). `app-e2e.apk` in a
      // build dir is what three repos on this desktop each called their APK.
      if ((r.artifacts || []).length !== 1) fail("one artifact, collected: " + JSON.stringify(r.artifacts));
      const art = r.artifacts[0];
      if (art.repoId !== rid) fail("artifact repoId wrong: " + art.repoId);
      if (!art.relPath.startsWith(".claude/outbox/")) fail("a produced artifact is collected into the outbox: " + art.relPath);
      if (!/^buildrepo-e2e-\S+\.apk$/.test(art.name)) fail("the collected name must carry the repo, the variant and a build identifier: " + art.name);
      // The build's own output is left exactly where the build wrote it.
      const orig = await fetch(`http://127.0.0.1:${PORT}/api/repos/${rid}/artifact?path=${encodeURIComponent("build/out/app-e2e.apk")}`);
      if (orig.status !== 200) fail("collecting must not move or delete what the build wrote: " + orig.status);
      // Download it through the artifact endpoint (build outputs are now serveable).
      const res = await fetch(`http://127.0.0.1:${PORT}/api/repos/${rid}/artifact?path=${encodeURIComponent(art.relPath)}&download=1`);
      const dispo = res.headers.get("content-disposition") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (!dispo.includes(`filename="${art.name}"`)) fail("bad disposition: " + dispo);
      if (buf.toString("utf8") !== ARTIFACT) fail("bad bytes: " + JSON.stringify(buf.toString("utf8")));
      // This build.run carried no ackId: the durable-op receipt (e2e-opqueue.mjs)
      // is opt-in, and the un-acked form must behave exactly as it always did.
      if (sawOpAck) fail("an ackId-less build.run must not produce an op.ack");
      if (art.stale) fail("an artifact this run WROTE must not be flagged stale: " + JSON.stringify(art));
      console.log(`PASS: build ran (exit 0), output streamed, artifact collected as ${art.name} (${buf.length} B) + downloaded, no op.ack for the ackId-less form`);
      phase = 2;
      send({ t: "build.save", repoDir: wt, builds: [{ id: "b1", name: "apk", cmd: CMD }, { id: "b2", name: "noop", cmd: CMD_NOOP }] });
    }
  });
  ws.on("error", (e) => fail("ws error: " + e.message));
});
watchdog(() => fail("timeout — build did not complete"));
