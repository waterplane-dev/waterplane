/**
 * The images feature's writers for the gallery, the file tree and the sweep:
 * what opens them, what they hand back, and where a file goes from the viewer.
 */
import type { RepoTarget, SweepScope } from "@waterplane/shared";
import { repoBranchLabel } from "@waterplane/shared";
import type { Overlay } from "../../routing";
import { copyText } from "../../api";
import { startDownload } from "../../download";
import { SEND_DRAFT } from "../../sendIntent";
import { tabLabel } from "../../sessionTabs";
import { core, type CoreApi } from "../../sdk";
import { browseAim, browseRepoId, galleryCtx, sweepFor } from "../../features/images/store";
import { galleryCtxForFile, outboxCut, type GalleryCtx } from "../../features/images/logic";
import { goTo, insertPath } from "./navActions";

// ── Gallery, file tree, sweep ────────────────────────────────────────

/** Open the gallery scoped to a repo (inbox/images count tap). */
export function openGalleryFor(repoId: string, scope?: GalleryCtx["scope"], allTime?: boolean, newCut?: { since: number; count: number }): void {
  galleryCtx.set({ repoId, scope, allTime, newCut });
  core().nav.open("gallery");
}
/** Open the outbox from an unread count. The count is "since you last looked",
 *  so the tab's 4h default has to come off — otherwise the badge says 42 and
 *  the grid says nothing here. Carry the EDGE, not just the window: the grid
 *  opens on exactly the files the badge counted, says so, and offers "show
 *  everything". */
export function openOutboxFor(repoId: string): void {
  openGalleryFor(repoId, "outbox", true, outboxCut(core().world.repos.find((x) => x.id === repoId)));
}
/** Reference a file the repo ALREADY has, from the Send sheet. The gallery takes
 *  the overlay, `returnTo` brings the sheet back and `insertInto` puts the path
 *  into its draft — the same round trip the annotator makes, and a round trip
 *  rather than the clipboard because a plain `http://100.x` origin has none. */
export function openGalleryForSend(repo: RepoTarget): void {
  galleryCtx.set({ repoId: repo.id, scope: "outbox", allTime: true, returnTo: "send", insertInto: "send" });
  core().nav.open("gallery");
}

/** Show an artifact in the gallery's viewer — the ONE thing in this app that
 *  renders a file, so there is no second markdown/PDF/image surface to keep in
 *  step with it. The download stays one tap away INSIDE the viewer. `returnTo`
 *  defaults to the notification feed when that is where the tap came from. */
export function openArtifact(f: { repoId: string; relPath: string; name?: string; size?: number; mtime?: number }, returnTo?: Overlay): void {
  // A caller naming its own return (the assessment's plan link) is not a
  // notification tap, and App's inlined copy of it counted nothing.
  if (returnTo === undefined) core().say.track("notif:open-file");
  const back = returnTo ?? (core().nav.overlay === "notifications" ? "notifications" : undefined);
  galleryCtx.set(galleryCtxForFile(f, back));
  core().nav.open("gallery");
}
/**
 * Fetch a repo artifact to this device — through the ONE download path
 * (`download.ts`): the resumable queue, the Downloads sheet, and the device
 * hand-off that says where the file landed. Never a hidden `<a download>`,
 * which was nothing whatsoever in the APK.
 */
export function downloadArtifact(f: { repoId: string; relPath: string; name: string; size?: number; mtime?: number; src?: string }): void {
  startDownload(f);
}

export function closeGallery(): void {
  const back = galleryCtx.get()?.returnTo ?? null;
  galleryCtx.set(null);
  goTo(back);
  core().world.refreshRepos(); // inbox marked seen on open → refresh the unread badge
}
/** The gallery's and the tree's *insert path*: into whichever surface asked for
 *  it. The close fires right after and carries the overlay back (`returnTo`),
 *  so the sheet remounts and re-reads the draft with the path already in it. */
export function insertFromGallery(pth: string): void {
  if (galleryCtx.get()?.insertInto === "send") {
    core().compose.appendSheetDraft(SEND_DRAFT, pth);
    core().say.toast("added to the prompt");
    return;
  }
  insertPath(pth);
}
/** The live sessions a gallery file can be sent to: the ones in its repo, the
 *  session on screen first. The viewer lists them by name and the person picks —
 *  "the first running one in this repo" was a session nobody chose. */
export function liveSessionsIn(repoId: string): { id: string; label: string; onScreen: boolean }[] {
  const c = core();
  const repo = c.world.repos.find((r) => r.id === repoId);
  if (!repo) return [];
  const activeId = c.world.active?.id;
  return c.world.sessions
    .filter((s) => s.cwd === repo.worktreePath && s.running)
    .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
    .map((s) => ({ id: s.id, label: tabLabel(s, repo.repoName), onScreen: s.id === activeId }));
}
/** From the gallery viewer: pull a file into a coding session as context —
 *  the live session the person picked, or (`sessionId` null) a new one in the
 *  file's repo — with the path in that screen's compose box. */
export function continueImageInSession(relPath: string, repoId: string, sessionId: string | null): void {
  const c = core();
  const repo = c.world.repos.find((r) => r.id === repoId);
  if (!repo) { c.say.toast("unknown repo"); return; }
  const existing = sessionId ? c.world.sessions.find((s) => s.id === sessionId && s.running) : undefined;
  if (sessionId && !existing) { c.say.toast("that session has ended — pick another, or start a new one"); return; }
  galleryCtx.set(null);
  goTo(null);
  void copyText(relPath);
  // Seeded into the draft of the screen being OPENED (`compose.seedDraft`),
  // never `insert` — that types into the box being left, and the incoming
  // screen's own draft then replaced it: the path was lost while the toast
  // named it. An APPEND either way (`local/no-draft-clobber`).
  if (existing) {
    c.nav.attach(existing);
    c.compose.seedDraft(existing.id, relPath);
    c.say.toast(`opened session · ${relPath}`);
  } else {
    const sid = c.launch.openCwd(repo.worktreePath, repoBranchLabel(repo));
    // null: the tap waits on the launch question, and no screen was opened
    // yet — the box on screen is still the one to add to.
    if (sid) c.compose.seedDraft(sid, relPath); else c.compose.insert(relPath);
    c.say.toast(`new session · ${relPath}`);
  }
}

/**
 * Remarks on a file (`FileReview.tsx`) into the chat of the repo the file is
 * in: the session on screen if it is that repo's, else a live one there, else
 * a new one picking up its last conversation. Seeded into
 * the draft of the screen being opened (APPENDED, never sent): the person
 * reads the remarks over in the box and sends them like any prompt, which is
 * where *now* or *when it's free* is decided.
 */
export function remarksToChat(repoId: string, text: string): boolean {
  const c = core();
  const repo = c.world.repos.find((r) => r.id === repoId);
  if (!repo) { c.say.toast("unknown repo — the remarks are kept on the file"); return false; }
  browseRepoId.set(null); browseAim.set(null);
  goTo(null);
  void copyText(text);
  const here = [c.world.active, ...c.world.sessions].find((s) => s && s.cwd === repo.worktreePath && s.running);
  if (here) {
    if (here.id !== c.world.active?.id) c.nav.attach(here);
    c.compose.seedDraft(here.id, text);
    c.say.toast("remarks are in the prompt — read them over, then send");
    return true;
  }
  const sid = c.launch.openCwd(repo.worktreePath, repoBranchLabel(repo), true);
  if (sid) c.compose.seedDraft(sid, text); else c.compose.insert(text);
  c.say.toast("new session · remarks are in the prompt");
  return true;
}

/** Clear out a transport directory; `back` is the screen the sweep closes to. */
export function openSweep(repoId: string, scope: SweepScope, back: Overlay): void {
  core().say.track("overlay:sweep");
  sweepFor.set({ repoId, scope, back });
  core().nav.open("sweep");
}
/** The gallery's sweep: only where there IS one transport directory to clear. */
export function sweepFromGallery(scope: SweepScope): void {
  const id = galleryCtx.get()?.repoId ?? core().world.activeRepo?.id;
  if (id) openSweep(id, scope, "gallery");
}
export function setSweepScope(scope: SweepScope): void {
  sweepFor.set((cur) => (cur ? { ...cur, scope } : cur));
}
export function closeSweep(): void {
  const back = sweepFor.get()?.back ?? null;
  sweepFor.set(null);
  goTo(back);
}
/** The sweep changed what the badges count, and the gallery underneath is
 *  holding a listing that now names files that are gone. */
export function afterSweep(): void {
  core().world.refreshRepos();
}

/** The file tree for a repo; closing it returns to `back` (the launcher's: none). */
export function openBrowseFor(repoId: string, back: Overlay = null): void {
  browseRepoId.set(repoId); if (back) browseAim.set({ file: "", back });
  core().nav.open("browse");
}
/** The file tree, straight on one file; closing returns to `back`. */
export function openBrowseAt(repoId: string, relPath: string, back: Overlay): void {
  browseRepoId.set(repoId);
  browseAim.set({ file: relPath, back });
  core().nav.open("browse");
}
/** The toolbar's `files`: the gallery, on whatever it was last opened for. */
export function openGalleryHere(): void {
  core().nav.open("gallery");
}
/** A repo-scoped toolbar command; with no repo in context it says so. */
export function inActiveRepo(run: (repoId: string) => void): (c: CoreApi) => void {
  return (c) => {
    const id = c.world.activeRepo?.id;
    if (id) run(id); else c.say.toast("not a known repo");
  };
}
/** The toolbar's `browse`: the repo in context, never a stale launcher pick. */
export function openBrowseHere(): void {
  browseRepoId.set(null);
  core().nav.open("browse");
}
export function closeBrowse(): void {
  const back = browseAim.get()?.back ?? null;
  browseRepoId.set(null); browseAim.set(null);
  goTo(back);
}
