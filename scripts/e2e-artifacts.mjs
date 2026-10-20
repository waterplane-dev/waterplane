// What a build leaves behind, end to end: the per-repo policy on the wire, the
// collected name, and the prune.
//
// `shared/test/artifacts.test.mjs` pins the rules and
// `packages/host/test/artifactcollect.test.mjs` pins the disk half. What only a
// real daemon can show is here: that the policy round-trips over the socket and
// is BROADCAST (a second phone must not go on showing the switch the desktop
// just flipped), that a run's reported artifact is the collected one, that an
// older build of the same artifact stops existing when `keep` says so — and
// that `collect: false` gives back exactly the behaviour every build had
// before any of this.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8813;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-artifacts-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const die = (m) => { console.error("FAIL:", m); try { host.kill(); } catch { /* already gone */ } process.exit(1); };

/** One WS round-trip: send `msg`, resolve on the first frame `want` matches. */
function ask(msg, want, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws`);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } reject(new Error("timeout waiting for " + JSON.stringify(msg))); }, timeout);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "welcome") { ws.send(JSON.stringify(msg)); return; }
      if (want(m)) { clearTimeout(timer); ws.close(); resolve(m); }
    });
    ws.on("error", reject);
  });
}

const apks = (wt) => { try { return readdirSync(join(wt, ".claude", "outbox")).filter((n) => n.endsWith(".apk")).sort(); } catch { return []; } };
/** Each run writes different bytes, or the fold would correctly call two runs
 *  one artifact and there would be nothing for a prune to remove. */
const cmd = (body) => `mkdir -p build/out && printf %s '${body}' > build/out/app-e2e.apk && echo built ${body}`;
const runBuild = (wt, id) => ask({ t: "build.run", repoDir: wt, buildId: id },
  (m) => m.t === "build.run" && m.run.buildId === id && (m.run.status === "done" || m.run.status === "failed"));
/** Detection counts a file as this run's if it is newer than the run's start
 *  MINUS a second of clock slack, so two builds inside that second are one
 *  run's output as far as the host can tell — and the previous build's
 *  collected copy would be protected from its own successor's prune. A real
 *  gradle run is never that fast; this waits so the case under test is the one
 *  a person actually hits. */
const settle = () => new Promise((r) => setTimeout(r, 1300));

bootWait(PORT, 1000, async () => {
  try {
    await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "artrepo" }) }).then((r) => r.json());
    const wt = (await fetch(`${base}/api/repos`).then((r) => r.json())).targets[0].worktreePath;

    // ── the policy, read and written ────────────────────────────────
    const got = await ask({ t: "artifacts.get", repoDir: wt }, (m) => m.t === "artifacts.config" && m.repoDir === wt);
    check(got.policy.collect === true && got.policy.prune === true && got.policy.keep === 3,
      `a repo nobody has configured is already collecting and pruning (${JSON.stringify(got.policy)})`);
    const saved = await ask({ t: "artifacts.save", repoDir: wt, policy: { collect: true, prune: true, keep: 1 } },
      (m) => m.t === "artifacts.config" && m.repoDir === wt && m.policy.keep === 1);
    check(saved.policy.keep === 1, "the policy round-trips and is broadcast, not answered only to the sender");
    check(existsSync(join(wt, STATE, "artifacts.json")), "and it is stored with the project, beside builds.json");

    // ── a run's artifact is the collected one ───────────────────────
    await ask({ t: "build.save", repoDir: wt, builds: [{ id: "b1", name: "apk", cmd: cmd("ONE") }] },
      (m) => m.t === "build.list" && m.repoDir === wt && m.builds.length === 1);
    const first = await runBuild(wt, "b1");
    check(first.run.status === "done", "the build succeeded");
    const art = (first.run.artifacts || [])[0];
    check((first.run.artifacts || []).length === 1 && art.relPath.startsWith(".claude/outbox/"),
      `one artifact, in the outbox (${JSON.stringify(first.run.artifacts)})`);
    check(/^artrepo-e2e-/.test(art.name), `named after the repo and the variant, not app-e2e.apk (${art.name})`);
    check(existsSync(join(wt, "build", "out", "app-e2e.apk")), "what the build wrote is still where the build wrote it");

    // ── the prune removes the PREVIOUS build of the same artifact ───
    await settle();
    await ask({ t: "build.save", repoDir: wt, builds: [{ id: "b1", name: "apk", cmd: cmd("TWO") }] },
      (m) => m.t === "build.list" && m.repoDir === wt && m.builds[0].cmd.includes("TWO"));
    const second = await runBuild(wt, "b1");
    const after = apks(wt);
    check(second.run.status === "done" && after.length === 1,
      `keep 1 ⇒ one APK survives in the outbox (${after.join(", ") || "none"})`);
    check(after[0] === (second.run.artifacts || [])[0]?.name, "and it is the one this run produced");

    // ── collect off ⇒ exactly the old behaviour ─────────────────────
    await ask({ t: "artifacts.save", repoDir: wt, policy: { collect: false, prune: false, keep: 3 } },
      (m) => m.t === "artifacts.config" && m.repoDir === wt && m.policy.collect === false);
    await settle();
    await ask({ t: "build.save", repoDir: wt, builds: [{ id: "b1", name: "apk", cmd: cmd("THREE") }] },
      (m) => m.t === "build.list" && m.repoDir === wt && m.builds[0].cmd.includes("THREE"));
    const third = await runBuild(wt, "b1");
    const raw = (third.run.artifacts || []).find((a) => a.relPath === "build/out/app-e2e.apk");
    check(!!raw, `with collect off the build is offered where it landed (${JSON.stringify(third.run.artifacts)})`);
    check(apks(wt).length === 1, "and nothing new was written into the outbox, nor anything removed from it");

    host.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  } catch (e) {
    die(String(e?.stack || e));
  }
});

watchdog(() => die("timeout — artifacts e2e did not finish"), 90000);
