// A build button that ASKS before it runs: what the values do, and what happens
// when there are none.
//
// Four things are pinned here, and three of them are refusals or near-misses
// that would otherwise fail QUIETLY on somebody's desktop:
//
//  • The value reaches the command VERBATIM at `{{app}}`, reaches the working
//    dir the same way (`apps/{{app}}` is how one entry serves one member of a
//    monorepo), and is exported as `<ENV>_PARAM_APP` whether or not the command
//    line names it.
//  • A parameter with no value and no default REFUSES the run, in words naming
//    the field — it does not run on a blank and it does not pick the first
//    option. That is what an unattended fire hits, and what an older bundle
//    sending no `params` at all hits.
//  • A `dir` built out of a value is still traversal-guarded: `{{app}}` set to
//    `../..` is refused, not resolved.
//  • `build.options` runs the entry's listing command in the repo and answers
//    with what it printed — and answers with an ERROR SENTENCE, never an empty
//    list, when the command fails. "That command is broken" and "this monorepo
//    has no apps" are opposite facts and the form draws them differently.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8829;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-buildparams-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };

// The build prints both halves of the contract: the substituted argument, and
// the environment copy a script would rather read.
const CMD = `echo "ARG={{app}} ENV=$${E.PARAM_APP} CWD=$(basename $PWD)"`;
const BUILDS = [
  {
    id: "shoot", name: "Screenshot", cmd: CMD, dir: "apps/{{app}}",
    params: [
      { id: "app", kind: "choice", label: "Garmin app", optionsCmd: "ls -1 apps" },
      { id: "flavour", kind: "text", default: "debug" },
    ],
  },
  // The same shape with nothing to fall back on — what an unattended fire hits.
  { id: "nodefault", name: "Needs one", cmd: "echo {{app}}", params: [{ id: "app", kind: "text", label: "Garmin app" }] },
  // A listing command that does not work. The form must be TOLD, not handed [].
  { id: "broken", name: "Broken list", cmd: "echo x", params: [{ id: "app", kind: "choice", optionsCmd: "exit 7" }] },
];

bootWait(PORT, 800, async () => {
  await fetch(`http://127.0.0.1:${PORT}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "paramrepo" }) }).then((r) => r.json());
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  const wt = repos.targets[0].worktreePath;
  // Two members of the "monorepo", so the listing has something honest to read.
  for (const a of ["acorn", "boulder"]) mkdirSync(join(wt, "apps", a), { recursive: true });
  writeFileSync(join(wt, "apps", "acorn", "README"), "x");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  let saved = false, out = "", sawOptions = false, refusal = "", sawTraversalRefusal = false;

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      send({ t: "build.save", repoDir: wt, builds: BUILDS });
    } else if (m.t === "build.list" && m.repoDir === wt && !saved) {
      saved = true;
      const shoot = m.builds.find((b) => b.id === "shoot");
      if (!shoot?.params?.length) fail("params were not persisted: " + JSON.stringify(m.builds));
      if (shoot.params[0].kind !== "choice" || shoot.params[0].optionsCmd !== "ls -1 apps") fail("param not round-tripped: " + JSON.stringify(shoot.params));
      // The options behind the drop-down, then the three runs.
      send({ t: "build.options", repoDir: wt, buildId: "shoot" });
      send({ t: "build.options", repoDir: wt, buildId: "broken" });
      send({ t: "build.run", repoDir: wt, buildId: "shoot", params: { app: "acorn" } });
      send({ t: "build.run", repoDir: wt, buildId: "nodefault" });
      send({ t: "build.run", repoDir: wt, buildId: "shoot", params: { app: "../../../etc" } });
    } else if (m.t === "build.options" && m.buildId === "shoot") {
      const a = m.options.app;
      if (!a?.options) fail("the listing command answered nothing: " + JSON.stringify(m.options));
      if (a.options.join(",") !== "acorn,boulder") fail("wrong options: " + JSON.stringify(a.options));
      // A parameter with no `optionsCmd` needs no round trip — the phone
      // already has its static list (or its typed field) off the config.
      if (m.options.flavour) fail("a parameter with nothing to discover must not be answered for: " + JSON.stringify(m.options));
      sawOptions = true;
    } else if (m.t === "build.options" && m.buildId === "broken") {
      const a = m.options.app;
      if (!a?.error) fail("a failed listing must answer with a sentence, never an empty list: " + JSON.stringify(a));
      if (a.options) fail("a failed listing must not also offer options: " + JSON.stringify(a));
    } else if (m.t === "toast") {
      // Both refusals arrive as toasts (`build.run`'s synchronous answer).
      if (/Garmin app/.test(m.text)) refusal = m.text;
      if (/working dir/.test(m.text)) sawTraversalRefusal = true;
    } else if (m.t === "build.output") {
      out += Buffer.from(m.dataB64, "base64").toString("utf8");
    } else if (m.t === "build.run" && (m.run.status === "done" || m.run.status === "failed")) {
      const r = m.run;
      if (r.buildId !== "shoot") fail("only the answered build may run: " + JSON.stringify(r));
      if (r.status !== "done") fail("the parameterised build failed: " + JSON.stringify(r));
      // Snapshotted onto the row, so a run can say which app it was about.
      if (r.params?.app !== "acorn" || r.params?.flavour !== "debug") fail("the values are not on the run row: " + JSON.stringify(r.params));
      // `name` stays the BUTTON's name (`BuildRun.name` has always meant "the
      // config's name at fire time"); what the run was asked FOR is `params`,
      // drawn as its own line on the row. The intent's title carries both,
      // which is what Activity and the notification read.
      if (!r.cmd.includes("ARG=acorn")) fail("the value was not substituted into the command: " + r.cmd);
      if (r.cmd.includes("{{")) fail("a placeholder survived into the command: " + r.cmd);
      if (!r.cwd.endsWith("/apps/acorn")) fail("the value was not substituted into the working dir: " + r.cwd);

      setTimeout(() => {
        if (!/ARG=acorn/.test(out)) fail("the command did not see the substituted value: " + JSON.stringify(out));
        if (!/ENV=acorn/.test(out)) fail(`${E.PARAM_APP} was not exported: ` + JSON.stringify(out));
        if (!/CWD=acorn/.test(out)) fail("the build did not run in the substituted dir: " + JSON.stringify(out));
        if (!sawOptions) fail("build.options never answered");
        if (!refusal) fail("a parameter with no value and no default must refuse the run, naming the field");
        if (!/needs a value for “Garmin app”/.test(refusal)) fail("the refusal must name the field: " + refusal);
        if (!sawTraversalRefusal) fail("a working dir built out of a value must still be traversal-guarded");
        console.log("PASS: a value reaches the command, the dir and the environment; a missing one refuses by name; a value cannot walk out of the repo; a broken listing says so");
        host.kill(); process.exit(0);
      }, 400);
    }
  });
  ws.on("error", (e) => fail("ws error: " + e.message));
});
watchdog(() => fail("timeout — the parameterised build did not complete"));
