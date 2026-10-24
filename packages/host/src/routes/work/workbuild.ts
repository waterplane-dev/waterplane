/**
 * Work routes — build slice of `routes/work.ts` (see that file for the whole picture).
 */
import { scanRepoBuilds } from "../../buildscan.js";
import { artifactPolicy, saveArtifactPolicy } from "../../artifacts.js";
import { probeCaptureBackends } from "../../capture.js";
import type { BuildCandidate, BuildParamAnswer } from "@waterplane/shared";
import type { Route, RouteSpec, RouteTable } from "../types.js";

const onBuildList: Route<"build.list"> = (a) => {
    // Contained like its `build.save` sibling. A read, not a spawn — but the
    // directory is still one the CLIENT named, and unguarded it reads back
    // `<any absolute path>/.waterplane{,-shared}/builds.json`. The gate is the gate.
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) return;
      a.c.send(a.ws, { t: "build.list", repoDir, builds: a.c.builds.list(repoDir), runs: a.c.builds.runsFor(repoDir), localIds: a.c.builds.localIds(repoDir) });
      // Seed the retained output tail for each run so a reconnect / fresh open
      // sees the in-progress log, not just future deltas.
      for (const r of a.c.builds.runsFor(repoDir)) {
        const o = a.c.builds.getOutput(r.runId);
        if (o) a.c.send(a.ws, { t: "build.output", runId: r.runId, dataB64: Buffer.from(o, "utf8").toString("base64"), full: true });
      }
    });
};

const onBuildSave: Route<"build.save"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) { a.c.send(a.ws, { t: "toast", text: "that folder is outside the configured root" }); return; }
      const local = Array.isArray(a.msg.local) ? a.msg.local.filter((x): x is string => typeof x === "string") : undefined;
      const saved = a.c.builds.save(repoDir, a.msg.builds, local);
      a.c.broadcast({ t: "build.list", repoDir, builds: saved, runs: a.c.builds.runsFor(repoDir), localIds: a.c.builds.localIds(repoDir) });
    });
};

/**
 * Run a repo's build command without a session — the rate-limit escape hatch.
 *
 * `durable` because a retried build is a second full compile, and two of them
 * writing the same output dir at once is worse than slow. `contain` because
 * `builds.ts` contains a build's own `dir` to its repo but never the repo
 * itself, and a build is a shell command: an unchecked repoDir here is command
 * execution in an arbitrary directory.
 */
const onBuildRun: RouteSpec<"build.run"> = {
  durable: true,
  contain: "repoDir",
  run: (a) => {
    // The values ride with the tap. Absent (an unattended fire, an older
    // bundle) is not an error: `builds.run` falls back to the stored defaults
    // and refuses in words only where a parameter has neither.
    const r = a.c.builds.run(a.dir, a.msg.buildId, a.msg.params);
    if ("error" in r) { a.c.send(a.ws, { t: "toast", text: `build: ${r.error}` }); return { ok: false, reason: r.error }; }
    return { ok: true, runId: r.runId };
  },
};

/**
 * What a build's parameters may be set to — the drop-downs behind the run tap.
 *
 * Contained for `build.list`'s reason and the stronger form of it: this ends in
 * a shell, so an unguarded directory here is command execution wherever the
 * client pointed. Not durable — it lists and writes nothing, so a repeated
 * frame costs a second listing and answers the same.
 *
 * The answer is sent even when it is empty: the form is waiting on this frame
 * to stop saying "reading the options…", and a phone that never hears back
 * cannot tell a slow desktop from a broken one.
 */
const onBuildOptions: Route<"build.options"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then(async (repoDir) => {
      if (!repoDir) return;
      let options: Record<string, BuildParamAnswer> = {};
      try { options = await a.c.builds.paramOptions(repoDir, a.msg.buildId, a.msg.approve === true && typeof a.msg.paramId === "string" ? { paramId: a.msg.paramId, cmd: typeof a.msg.cmd === "string" ? a.msg.cmd : undefined } : undefined); }
      catch { options = {}; }
      a.c.send(a.ws, { t: "build.options", repoDir, buildId: a.msg.buildId, options });
    });
};

const onBuildCancel: Route<"build.cancel"> = (a) => {
    a.c.builds.cancel(a.msg.runId);
};

/**
 * What this repo does with what its builds produce.
 *
 * Contained for the same reason `pull.save` is: `saveArtifactPolicy` MKDIRs and
 * WRITES `<repoDir>/.waterplane/artifacts.json`, so an unguarded `repoDir` puts a
 * file wherever the daemon can write. `cleanArtifactPolicy` shape-checks the
 * content, which makes this arbitrary PLACEMENT rather than arbitrary bytes.
 *
 * The save BROADCASTS: the policy is a property of the project, so a second
 * phone must not go on showing the switch the desktop just flipped.
 */
const onArtifactsGet: Route<"artifacts.get"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) return;
      a.c.send(a.ws, { t: "artifacts.config", repoDir, policy: artifactPolicy(repoDir) });
    });
};

const onArtifactsSave: Route<"artifacts.save"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) { a.c.send(a.ws, { t: "toast", text: "that folder is outside the configured root" }); return; }
      a.c.broadcast({ t: "artifacts.config", repoDir, policy: saveArtifactPolicy(repoDir, a.msg.policy) });
    });
};

/**
 * "What can this repo already build?" — the free half of the Build sheet's
 * "set up", answered off the repo's own manifests instead of an agent turn.
 *
 * Contained for `build.list`'s reason and no other: it reads files under a
 * directory the CLIENT named. Not durable — it reads and writes nothing, so a
 * duplicate frame costs a second walk and yields the same list.
 *
 * A walk of a big monorepo is bounded in `buildscan.ts` rather than here, and a
 * failed scan answers with an EMPTY list rather than silence: the editor is
 * waiting on this frame to stop saying "reading the repo…", and a phone that
 * never hears back has no way to tell a slow desktop from a broken one.
 */
const onBuildScan: Route<"build.scan"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) return;
      let found: { candidates: BuildCandidate[]; total: number };
      try { found = scanRepoBuilds(repoDir, a.c.builds.list(repoDir)); }
      catch { found = { candidates: [], total: 0 }; }
      a.c.send(a.ws, { t: "build.candidates", repoDir, candidates: found.candidates, total: found.total });
    });
};

// ── Verified capture ────────────────────────────────────────────────────────

/**
 * A repo's capture targets, its recent runs, and which backends this desktop
 * can actually drive.
 *
 * Contained for `build.list`'s reason and no other: the directory is the
 * CLIENT's word, and unguarded this reads back `<any absolute path>/.waterplane/
 * capture.json`. Not durable — it reads and writes nothing.
 *
 * The backend availability rides on this frame rather than on a probe of its
 * own, because the sheet needs it at exactly the moment it draws the buttons
 * and a missing Playwright must arrive as a SENTENCE it can print, never as a
 * greyed-out control. `probeCaptureBackends` is passed the repo dir for the
 * same reason: Playwright lives in the TARGET repo's `node_modules`, so a
 * host-scoped probe would tell a repo that has it that it does not.
 */
const onCaptureList: Route<"capture.list"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then(async (repoDir) => {
      if (!repoDir) return;
      const backends = await probeCaptureBackends(repoDir);
      const runs = a.c.capture.runsFor(repoDir);
      a.c.send(a.ws, { t: "capture.list", repoDir, targets: a.c.capture.list(repoDir), runs, backends });
      // Seed the retained output tail per run, `build.list`'s rule: a reconnect
      // or a fresh open must see the log a run has already printed, not only
      // whatever it prints from now on.
      for (const r of runs) {
        const o = a.c.capture.getOutput(r.runId);
        if (o) a.c.send(a.ws, { t: "capture.output", runId: r.runId, dataB64: Buffer.from(o, "utf8").toString("base64"), full: true });
      }
    });
};

/** The whole target list, saved as one document — `build.save`'s contract.
 *  Contained, not durable: a replayed save writes the same list. */
const onCaptureSave: Route<"capture.save"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then(async (repoDir) => {
      if (!repoDir) { a.c.send(a.ws, { t: "toast", text: "that folder is outside the configured root" }); return; }
      const saved = a.c.capture.save(repoDir, a.msg.targets);
      a.c.broadcast({
        t: "capture.list",
        repoDir,
        targets: saved,
        runs: a.c.capture.runsFor(repoDir),
        backends: await probeCaptureBackends(repoDir),
      });
    });
};

/**
 * Take the picture now.
 *
 * `build.run`'s two declarations, for two reasons of its own. `durable`,
 * because a replayed run is two captures in a fight over one lease — one
 * simulator, one device, one browser on one port — and they photograph each
 * other's state. `contain`, because the run resolves a target out of a
 * directory the CLIENT named and then drives a device from it.
 */
const onCaptureRun: RouteSpec<"capture.run"> = {
  durable: true,
  contain: "repoDir",
  run: (a) => {
    const r = a.c.capture.run(a.dir, a.msg.targetId, a.msg.watch);
    if ("error" in r) { a.c.send(a.ws, { t: "toast", text: `capture: ${r.error}` }); return { ok: false, reason: r.error }; }
    // The row is on disk before this returns, which is what the ack receipts.
    return { ok: true, runId: r.runId, intentId: r.runId };
  },
};

/**
 * Call a run off.
 *
 * Deliberately NOT durable and never queued offline, for `intent.cancel`'s
 * reason: a cancel delivered an hour late calls off work that has since run.
 * A run that could not be called off says so rather than answering silently —
 * the tap has to mean something.
 *
 * The sentence is the MANAGER's, not this route's: "already finished" was this
 * route's guess about every `false`, and it was wrong about the case that
 * matters — a run posted and still waiting its turn, whose cancel used to be
 * dropped on the floor while the run went on to happen. `cancel()` now knows
 * the difference between a row that finished, one it just called off before it
 * started, and one running in a process this one cannot reach.
 */
const onCaptureCancel: Route<"capture.cancel"> = (a) => {
    const why = a.c.capture.cancel(a.msg.runId);
    if (why) a.c.send(a.ws, { t: "toast", text: why });
};

// ── Assessment ──────────────────────────────────────────────────────────────

export const workbuildRoutes: RouteTable = {
  "build.list": onBuildList,
  "build.save": onBuildSave,
  "build.run": onBuildRun,
  "build.options": onBuildOptions,
  "build.cancel": onBuildCancel,
  "artifacts.get": onArtifactsGet,
  "artifacts.save": onArtifactsSave,
  "build.scan": onBuildScan,
  "capture.list": onCaptureList,
  "capture.save": onCaptureSave,
  "capture.run": onCaptureRun,
  "capture.cancel": onCaptureCancel,
};
