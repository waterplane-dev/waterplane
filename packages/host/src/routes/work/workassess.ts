/**
 * Work routes — assess slice of `routes/work.ts` (see that file for the whole picture).
 */
import { findTarget } from "../../repos.js";
import { statInTree } from "../../files.js";
import { applyProposal, startAssessment } from "../../assess.js";
import type { Route, RouteSpec, RouteTable } from "../types.js";

/**
 * "Read this repo and tell me what is left."
 *
 * `build.run`'s two declarations, for `build.run`'s two reasons: `durable`
 * because a retry that arrived twice would pay twice for an agent reading a
 * whole repo, and `contain` because this spawns `claude` in a directory the
 * CLIENT named — the same gate a create and a build pass through, and the one
 * thing a handler must never re-implement.
 *
 * The refusal that is NOT about containment — a run already in flight for this
 * repo — comes back `ok:false` with a sentence rather than being queued behind
 * the first: two assessments over one list propose different verdicts about the
 * same rows.
 *
 * `ids` is the caller's CUT, and it passes straight through: every question
 * about whether it can be honoured — do these rows exist, are they this repo's,
 * is there anything assessable left in them — is `startAssessment`'s, decided
 * while there is still a socket to refuse on. `contain` still does the only
 * thing it has ever done here, which is resolve the DIRECTORY; the ids are
 * contained by being looked up in this repo's own rows and not by being parsed.
 */
const onAssessRun: RouteSpec<"assess.run"> = {
  durable: true,
  contain: "repoDir",
  run: (a) => {
    const r = startAssessment(a.c.intents, a.c.assess, a.dir, a.msg.ids);
    if ("error" in r) { a.c.send(a.ws, { t: "toast", text: `assess: ${r.error}` }); return { ok: false, reason: r.error }; }
    // The row is on disk before this returns (`post()` persists synchronously),
    // which is what the ack is a receipt for.
    a.c.broadcast(a.c.assessSnapshot(a.dir));
    return { ok: true, runId: r.runId, intentId: r.runId };
  },
};

/**
 * Apply exactly the approvals a person ticked.
 *
 * Durable, and here the ackId is not ceremony: applying a merge POSTS a prompt,
 * and a replay that posted it twice would put two agents on one job in one
 * worktree. Past the ledger's 45 minutes the run's own `applied` status is the
 * second guard.
 *
 * No `contain`: the repo is not named by the client at all — it is whatever the
 * run recorded, which was contained when the run was started.
 */
const onAssessApply: RouteSpec<"assess.apply"> = {
  durable: true,
  run: (a) => {
    const r = applyProposal(a.c.intents, a.c.assess, a.msg.runId, a.msg.choices ?? {});
    a.c.send(a.ws, { t: "toast", text: r.ok ? `applied · ${r.detail}` : `assess: ${r.detail}` });
    // `filed` rides the receipt, and it is the only thing between a post this
    // host REFUSED and a note the phone tombstones on the strength of `ok`. It
    // is passed through exactly as the outcome gave it — absent stays absent,
    // which is how an apply that could not say says so.
    return { ok: r.ok, reason: r.reason, runId: a.msg.runId, filed: r.filed };
  },
};

/**
 * Throw one proposal away.
 *
 * Deliberately NOT durable and never queued, for `intent.cancel`'s reason: a
 * discard delivered an hour late throws away a proposal the person has since
 * been reading. Nothing it discards was applied, so the words it was about are
 * exactly where they were.
 */
const onAssessDiscard: Route<"assess.discard"> = (a) => {
    const run = a.c.assess.get(a.msg.runId);
    if (!run) { a.c.send(a.ws, { t: "toast", text: "that proposal is already gone" }); return; }
    if (run.status === "running") { a.c.send(a.ws, { t: "toast", text: "that assessment is still running — it can be discarded once it finishes" }); return; }
    a.c.assess.drop(a.msg.runId);
};

const onAssessState: Route<"assess.state"> = (a) => {
    // Named repo ⇒ one frame, even when the answer is "never assessed" (`null`
    // is a fact; silence is not). No repo ⇒ one frame per repo that has a run,
    // which is what a client asks for on connect.
    if (a.msg.repoDir) { a.c.send(a.ws, a.c.assessSnapshot(a.msg.repoDir)); return; }
    for (const dir of a.c.assess.repos()) a.c.send(a.ws, a.c.assessSnapshot(dir));
};

    // ── Auto-download ──
const onPullGet: Route<"pull.get"> = (a) => {
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) return;
      a.c.send(a.ws, { t: "pull.config", repoDir, config: a.c.autopull.config(repoDir) });
    });
};

const onPullSave: Route<"pull.save"> = (a) => {
    // `saveConfig` MKDIRs and WRITES — `join(repoDir, ".waterplane", "autopull.json")`
    // — so an unguarded `repoDir` puts a file anywhere the daemon can write.
    // The content is shape-checked by `cleanConfig`, which makes this arbitrary
    // PLACEMENT rather than arbitrary bytes; it is still the one gate being
    // skipped, on the one verb that touches the disk.
    void a.c.containRepoDir(a.msg.repoDir).then((repoDir) => {
      if (!repoDir) { a.c.send(a.ws, { t: "toast", text: "that folder is outside the configured root" }); return; }
      const saved = a.c.autopull.saveConfig(repoDir, a.msg.config);
      a.c.broadcast({ t: "pull.config", repoDir, config: saved });
      // A rule that just changed scope invalidates every session snapshot taken
      // under the old one; drop them so the next turn re-seeds instead of
      // reporting the whole new scope as freshly produced.
      for (const info of a.c.sessions.list()) if (info.cwd === repoDir) a.c.pullSeen.delete(info.id);
      // A rule is switched on while looking at the artifact it is being
      // switched on FOR, and every other path here only sees a file produced
      // AFTER the rule existed — so a save that ENABLES one asks the same
      // question of what is already on disk (`server/scan.ts`, `pullCatchUp`).
      //
      // It answers either way. A queue the person cannot see filling is the
      // failure this fixes; "nothing yet" is the other half of it, and a save
      // that says nothing at all is indistinguishable from a switch that does
      // nothing at all.
      if (!saved.enabled) return;
      const queued = a.c.pullCatchUp(repoDir);
      a.c.send(a.ws, { t: "toast", text: queued.length === 1
        ? `fetching ${queued[0].name} — it was already here`
        : queued.length
          ? `fetching ${queued.length} files that were already here`
          : "nothing here matches yet — the next one comes down on its own" });
    });
};

const onPullList: Route<"pull.list"> = (a) => {
    a.c.send(a.ws, { t: "pull.list", items: a.c.autopull.list() });
};

const onPullAdd: Route<"pull.add"> = (a) => {
    // "Send this file to my phone" — an explicit tap, so it bypasses the rule
    // (see AutoPullManager.consider). The path is validated by resolving it in
    // the repo's own tree: the phone supplies it, so it never becomes a way to
    // queue something outside the worktree. The router is sync; repo lookup
    // isn't, and the result is only a toast + a list broadcast.
    const { repoId, relPath } = a.msg;
    void (async () => {
      const target = await findTarget(a.c.ROOT, repoId);
      const st = target ? statInTree(target.worktreePath, relPath) : null;
      if (!target || !st) { a.c.send(a.ws, { t: "toast", text: "can't queue that file" }); return; }
      const queued = a.c.autopull.consider(
        { repoId: target.id, repoDir: target.worktreePath, repoName: target.repoName },
        [{ name: relPath.split("/").pop() || "artifact", relPath, size: st.size, mtime: st.mtime }],
        "manual",
      );
      a.c.send(a.ws, { t: "pull.list", items: a.c.autopull.list() });
      a.c.send(a.ws, { t: "toast", text: queued.length ? `queued ${queued[0].name} for download` : "already queued" });
    })();
};

const onPullDismiss: Route<"pull.dismiss"> = (a) => {
    a.c.autopull.dismiss(a.msg.id);
    a.c.broadcast({ t: "pull.list", items: a.c.autopull.list() });
};

export const workassessRoutes: RouteTable = {
  "assess.run": onAssessRun,
  "assess.apply": onAssessApply,
  "assess.discard": onAssessDiscard,
  "assess.state": onAssessState,
  "pull.get": onPullGet,
  "pull.save": onPullSave,
  "pull.list": onPullList,
  "pull.add": onPullAdd,
  "pull.dismiss": onPullDismiss,
};
