/**
 * The files a turn or a build leaves behind, noticed: the per-session image and
 * auto-pull baselines, the per-repo outbox baseline, the scanners over them,
 * the auto-pull hand-over (`considerPull`, `pullNewFiles`, `pullCatchUp`), the
 * build announcement, and the one `autopull.on("item")` listener.
 *
 * Moved verbatim out of `main.ts` (M4 of the host split, see
 * docs/notes/host-architecture.md). Every manager is read as `ctx.<x>` at CALL
 * time — `announceBuild` is reached from the intent store's `settled` event and
 * the scanners from session listeners, all long after boot.
 *
 * `createScan(ctx)` REGISTERS the `autopull.on("item")` listener, so `main.ts`
 * calls it immediately after `new AutoPullManager(ROOT)` has been assigned into
 * `ctx.autopull` — the position the listener held there. The construction
 * itself stays in `main.ts`.
 */
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { BuildRun, NewImage, PullItem } from "@waterplane/shared";
import { discoverArtifacts } from "../files.js";
import { targetId } from "../repos.js";
import { catchUpCandidates } from "../autopull.js";
import type { ServerCtx } from "./ctx.js";
import { logTag } from "@waterplane/shared";

/** Everything `createScan` built; `main.ts` assigns each into `ctx`. */
export type Scan = ReturnType<typeof createScan>;

export function createScan(ctx: ServerCtx) {
  /**
   * A completed build, announced.
   *
   * Driven off the store's own `settled` event now rather than off a manager's
   * in-memory ring, which is what lets a build that was running when the daemon
   * died end as a row that says so instead of one nobody can account for.
   */
  function announceBuild(run: BuildRun): void {
    if (run.status !== "done" && run.status !== "failed") return;
    const verdict = run.status === "done" ? "succeeded" : `failed${run.exitCode != null ? ` (exit ${run.exitCode})` : ""}`;
    // A build deliverable is the artifact auto-download exists for: it is the
    // biggest file the workflow produces and the one you want on the phone before
    // you go looking for it. `stat` for the mtime the pull id is keyed on — a
    // rebuilt APK at the same path must be a NEW pull, not a silent no-op.
    if (run.status === "done" && run.artifacts?.length) {
      considerPull(run.repoDir, run.artifacts.map((a) => {
        let mtime = run.finishedAt ?? Date.now();
        try { mtime = statSync(join(run.repoDir, a.relPath)).mtimeMs; } catch { /* keep the run's clock */ }
        return { name: a.name, relPath: a.relPath, size: a.size, mtime };
      }), "build");
    }
    const art = run.artifacts?.[0];
    if (art) {
      ctx.notify("artifact", {
        title: `Build “${run.name}”: ${art.name}`,
        body: `${fmtSize(art.size)} · ${verdict} — tap to download`,
        tag: `build-${run.runId}`,
        file: { repoId: art.repoId, relPath: art.relPath, name: art.name, size: art.size, mtime: art.mtime },
      });
    } else {
      ctx.notify("info", { title: `Build “${run.name}” ${verdict}`, body: run.cwd, tag: `build-${run.runId}` });
    }
  }

  // `ctx.autopull` was constructed (in main.ts) immediately before this call;
  // its doc comment stays beside the construction.
  ctx.autopull.on("item", (item: PullItem) => {
    ctx.broadcast({ t: "pull.new", item });
    ctx.broadcast({ t: "pull.list", items: ctx.autopull.list() });
    const dropped = item.supersedes?.length ? ` · superseded ${item.supersedes.length} older` : "";
    console.log(`${logTag} auto-pull queued · ${item.repoName} · ${item.relPath} (${fmtSize(item.size)})${dropped}`);
    ctx.notify("artifact", {
      title: `Downloading: ${item.name}`,
      body: `${fmtSize(item.size)} · ${item.repoName} — auto-download`,
      tag: `pull-${item.id}`,
      file: { repoId: item.repoId, relPath: item.relPath, name: item.name, size: item.size, mtime: item.mtime },
      pull: item.id,
    });
  });

  /** Offer a repo's freshly-detected files to its auto-pull rule. Repo identity is
   *  derived the same way every other artifact reference does it (`targetId`), so
   *  the queued item's `repoId` is directly usable against the artifact endpoint. */
  function considerPull(cwd: string, files: { name: string; relPath: string; size: number; mtime: number }[], source: "outbox" | "build"): void {
    if (!files.length) return;
    try {
      ctx.autopull.consider({ repoId: targetId(cwd), repoDir: cwd, repoName: basename(cwd) }, files, source);
    } catch { /* a pull rule must never break a turn end or a build */ }
  }

  // Per-session image baseline: relPaths already present so only NEW images notify.
  const imgSeen = new Map<string, Set<string>>();
  function scanImages(cwd: string): NewImage[] {
    const { files } = discoverArtifacts(cwd, { scope: "repo", kind: "image", limit: 1000 });
    return files.map((f) => ({ name: f.name, relPath: f.relPath, mtime: f.mtime }));
  }
  /**
   * Per-REPO outbox baseline (non-image artifacts: APKs, zips, pdfs …). Images
   * already flow through the image scan above; this catches the deliverables an
   * agent drops repo→phone, and its notification tap downloads the file directly.
   *
   * **Keyed by `cwd`, not by session id — and that is the whole point.** It used
   * to be per session while the thing it watches, `scanOutboxDocs(cwd)`, is
   * per repo: every session open in that checkout ran its own turn-end scan,
   * found the same new file against its own baseline, and fired its own
   * notification. Two sessions in one repo produced two "Outbox: …apk" rows for
   * one APK — photographed from a phone with two of each, plus the separate
   * "Downloading:" row auto-pull adds, i.e. three notifications for one file.
   * A repo's outbox is a fact about the repo; the first turn to see a file claims
   * it for everyone.
   *
   * `imgSeen` above stays per session deliberately: its scan feeds a per-session
   * broadcast (`session.images`, the session's own new-image strip) as well as a
   * notification, so its key is doing a second job this one's never had.
   */
  const outSeen = new Map<string, Set<string>>();
  function scanOutboxDocs(cwd: string): { name: string; relPath: string; size: number; mtime: number }[] {
    const { files } = discoverArtifacts(cwd, { scope: "outbox", kind: "doc", limit: 200 });
    return files.map((f) => ({ name: f.name, relPath: f.relPath, size: f.size, mtime: f.mtime }));
  }
  /**
   * Auto-pull's OWN baseline, separate from the notification ones above on purpose.
   * The image scan is repo-wide and the outbox scan is doc-only, but an auto-pull
   * rule is a scope plus a pattern and has to see every candidate in that scope —
   * an `*.png` rule scoped to the outbox must not depend on which of the two
   * notification scans happened to cover it.
   *
   * Keyed by session, holding the scope it was taken under: a rule edited from
   * "outbox" to "repo" mid-session invalidates the snapshot, and without noticing
   * that we'd hand the rule every pre-existing file in the repo as "new".
   */
  const pullSeen = new Map<string, { scope: "outbox" | "repo"; paths: Set<string> }>();
  function scanPullCandidates(cwd: string, scope: "outbox" | "repo") {
    const { files } = discoverArtifacts(cwd, { scope, kind: "all", limit: 1000 });
    return files.map((f) => ({ name: f.name, relPath: f.relPath, size: f.size, mtime: f.mtime }));
  }
  /** Diff this repo's auto-pull scope against the session's snapshot and queue what
   *  is new. A snapshot taken under a different scope (or none) is re-seeded and
   *  this round queues nothing — "new" has to mean new, not "first look". */
  function pullNewFiles(id: string, cwd: string): void {
    const cfg = ctx.autopull.config(cwd);
    if (!cfg.enabled) return;
    const found = scanPullCandidates(cwd, cfg.scope);
    const prev = pullSeen.get(id);
    if (!prev || prev.scope !== cfg.scope) {
      pullSeen.set(id, { scope: cfg.scope, paths: new Set(found.map((f) => f.relPath)) });
      return;
    }
    const fresh = found.filter((f) => !prev.paths.has(f.relPath));
    if (!fresh.length) return;
    fresh.forEach((f) => prev.paths.add(f.relPath));
    considerPull(cwd, fresh, "outbox");
  }

  /**
   * The same rule, applied to what is ALREADY here — run when a rule is SAVED.
   *
   * Everything above only ever sees a file produced after the rule existed, and
   * the rule is typically switched on while looking at the artifact it is being
   * switched on FOR (`catchUpCandidates` carries the measurement). A save is a
   * decision, so this queues; it stays bounded — newest per family, three at
   * most, nothing older than a day — because turning a whole-repo rule on must
   * not push a year of artifacts at a phone.
   *
   * The last build is asked SEPARATELY from the scope, for the reason that made
   * this miss in the first place: a build writes where it writes
   * (`build/app/outputs/…`, the repo root), which an "outbox" scope does not
   * cover at all, and the build hand-over is how such a file normally reaches
   * the queue.
   */
  function pullCatchUp(cwd: string): PullItem[] {
    const cfg = ctx.autopull.config(cwd);
    if (!cfg.enabled) return [];
    const repo = { repoId: targetId(cwd), repoDir: cwd, repoName: basename(cwd) };
    const queued: PullItem[] = [];
    try {
      queued.push(...ctx.autopull.consider(repo, catchUpCandidates(scanPullCandidates(cwd, cfg.scope)), "outbox"));
      if (cfg.builds) {
        const run = ctx.builds.runsFor(cwd).find((r) => r.status === "done" && r.artifacts?.length);
        const arts: { name: string; relPath: string; size: number; mtime: number }[] = [];
        for (const a of run?.artifacts ?? []) {
          // Stat, and SKIP what no longer exists: a run's row outlives the file
          // it produced, and queueing a path that was cleaned up is a download
          // the phone can only fail at.
          try {
            const st = statSync(join(cwd, a.relPath));
            arts.push({ name: a.name, relPath: a.relPath, size: a.size, mtime: st.mtimeMs });
          } catch { /* gone since the run — nothing to fetch */ }
        }
        if (arts.length) queued.push(...ctx.autopull.consider(repo, catchUpCandidates(arts), "build"));
      }
    } catch { /* a rule save must never fail on a scan */ }
    return queued;
  }
  const fmtSize = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;

  return {
    announceBuild, considerPull,
    imgSeen, outSeen, pullSeen,
    scanImages, scanOutboxDocs, scanPullCandidates,
    pullNewFiles, pullCatchUp, fmtSize,
  };
}
