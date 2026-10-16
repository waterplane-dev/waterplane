/**
 * The three repo-file sheets: the gallery, the file tree (`browse`) and the
 * transport-directory sweep. Thin entries over `Gallery.tsx`, `FilesSheet.tsx`
 * and `SweepSheet.tsx`, whose rules are theirs (skill `web-files`).
 */
import { sweepResultText } from "@waterplane/shared";
import { Gallery } from "../../Gallery";
import { FilesSheet } from "../../FilesSheet";
import { SweepSheet } from "../../SweepSheet";
import { SheetHead } from "../../Sheet";
import { Empty } from "../../Empty";
import { api } from "../../api";
import { core, useCore, useStore } from "../../sdk";
import { browseAim, browseRepoId, flow, galleryCtx, sweepFor } from "./store";
import {
  afterSweep, annBatch, annotateUrlForSession, closeBrowse, closeGallery, closeSweep, continueImageInSession, insertFromGallery, liveSessionsIn,
  offerCollage, remarksToChat, setSweepScope, sweepFromGallery,
} from "./actions";

/**
 * The gallery's `combine`: pictures the desktop made — a screenshot per device, a before and an
 * after — picked in order, fetched as files and handed to the same combine-or-not question every
 * multi-image pick gets (`offerCollage`), so one circle can point at a difference that spans two of
 * them. The session flow, like the gallery's `mark`; declining marks each in turn (`annBatch`). A
 * fetch that fails is SAID, and nothing half-combined goes on.
 */
function combineFromGallery(items: { url: string; name: string; repoId: string }[]): void {
  const repoId = items[0]?.repoId;
  if (!repoId || items.length < 2) return;
  flow.ret = "session";
  void Promise.all(items.map(async (it) => {
    const b = await api.fileBlob(it.url);
    return new File([b], it.name, { type: b.type || "image/png" });
  })).then(
    (files) => offerCollage(files, repoId, (ordered) => annBatch(ordered, repoId)),
    () => core().say.toast("Could not fetch the pictures from the desktop — nothing was combined."),
  );
}

export function GallerySheet() {
  const c = useCore();
  const ctx = useStore(galleryCtx);
  return <Gallery repoId={ctx?.repoId ?? c.world.activeRepo?.id ?? undefined} repos={c.world.visibleRepos}
    initialScope={ctx?.scope} initialAllTime={ctx?.allTime} initialNew={ctx?.newCut}
    openFile={ctx?.openFile}
    onClose={closeGallery}
    onInsertPath={insertFromGallery}
    onContinueInSession={continueImageInSession}
    sessionsIn={liveSessionsIn}
    // Only where there IS one transport directory to clear: the all-repos
    // scope has no single outbox, and "this repo" is a whole worktree rather
    // than a drop zone. The gallery hands over the tab you were on.
    onSweep={sweepFromGallery}
    // On "all repos" there is no single directory to clear, and that is the
    // scope somebody is on when the question is WHICH repo is fat.
    onSurvey={() => { c.say.track("overlay:storage"); c.nav.open("storage"); }}
    onAnnotate={annotateUrlForSession}
    onCombine={combineFromGallery} />;
}

/** Clearing out a transport directory. The manifest guards it: with no target
 *  it falls through rather than painting a destructive sheet aimed at nothing. */
export function SweepEntrySheet() {
  const c = useCore();
  const s = useStore(sweepFor);
  const target = s ? c.world.repos.find((r) => r.id === s.repoId) ?? null : null;
  if (!s || !target) return null;
  return <SweepSheet repoId={target.id} repoName={target.repoName} scope={s.scope}
    onScope={setSweepScope}
    // The badge counts UNSEEN outbox files, so deleting some of them changes
    // it — and the gallery underneath is holding a listing that now names
    // files that are gone.
    onDone={(r) => { afterSweep(); if (r.deleted) c.say.toast(sweepResultText(r)); }}
    onClose={closeSweep} />;
}

/**
 * The file tree. Repo-scoped by design: a tree is a worktree's tree, and the
 * cross-repo question is what the gallery's all-repos search already answers.
 * WHICH repo is the launcher's pick when it made one, else the repo in context.
 */
export function FileTreeSheet() {
  const c = useCore();
  const pick = useStore(browseRepoId);
  const aim = useStore(browseAim);
  const target = c.world.repos.find((r) => r.id === (pick ?? c.world.activeRepo?.id)) ?? null;
  // Reachable by restoring the persisted route into a session whose repo has
  // since gone. Say so — never set state during a render to bounce out.
  if (!target) return (
    <div className="sheet">
      <SheetHead title={"Files"} onClose={closeBrowse} />
      <Empty>That repo is not in the listing any more — pick one from the launcher.</Empty>
    </div>
  );
  // Keyed on the aim: a pinned tab tapped while the viewer is open names a
  // new file, and `initialFile` is read once per mount.
  return <FilesSheet key={`${target.id}:${aim?.file ?? ""}`} repoId={target.id} repoName={target.repoName}
    initialFile={aim?.file}
    socketOpen={c.conn.status === "open"}
    onInsertPath={insertFromGallery}
    onRemarks={(_rel, text) => remarksToChat(target.id, text)}
    onClose={closeBrowse} />;
}
