/**
 * A share from another app (the Android shell's share sheet, `shellShare.ts`):
 * held in `shared` while the person picks where it goes (`ShareInSheet`), then
 * routed by `core().files.attachFiles` — the compose bar's paperclip path, so a
 * shared file and a picked one cannot be treated differently.
 */
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { repoBranchLabel } from "@waterplane/shared";
import { copyText } from "../../api";
import { onShellShare, type SharedItems } from "../../shellShare";
import type { Overlay } from "../../routing";
import { core } from "../../sdk";
import { shared } from "./store";

/** Listen for shares; the manifest's boot. */
export function bootShare(): () => void {
  return onShellShare(takeShare);
}

function goTo(o: Overlay): void {
  const nav = core().nav;
  if (o) nav.open(o);
  else if (nav.overlay) nav.close(nav.overlay);
}

/** A share arrived (the Android shell's share sheet): ask where it goes. A
 *  second share while the first is still being decided replaces it — the
 *  person is looking at the newer one — and says so. */
export function takeShare(s: SharedItems): void {
  const c = core();
  if (shared.get()) c.say.toast("a newer share replaced the one waiting");
  c.say.track("overlay:share");
  shared.set(s);
  c.nav.open("share");
}

/** Close the share sheet without sending anything. */
export function dropShare(): void {
  shared.set(null);
  goTo(null);
}

/** Where a share goes: a session that exists (the one on screen or another),
 *  a new session in a repo, or no session at all — just the repo's
 *  `.claude/inbox/`. `annotate` is whether pictures open in the annotator
 *  first (a session only); off, every file goes straight up. */
export type ShareTarget =
  | { kind: "session"; sessionId: string; annotate: boolean }
  | { kind: "new"; repo: RepoTarget; annotate: boolean }
  | { kind: "inbox"; repo: RepoTarget };

async function readShared(s: SharedItems): Promise<{ files: File[]; failed: number }> {
  const files: File[] = [];
  let failed = 0;
  for (const f of s.files) {
    try {
      // The shell's own copy on this page's origin (`parseShare` checked it),
      // not the host — there is no token, route or timeout for api.ts to add.
      // eslint-disable-next-line no-restricted-globals -- local share copy
      const r = await fetch(f.url);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      files.push(new File([blob], f.name, { type: f.type || blob.type }));
    } catch { failed++; }
  }
  return { files, failed };
}

/** How long a new session's launch question may stay unanswered before the
 *  share gives up waiting for its screen and comes back to be re-aimed. */
const SHARE_WAIT_MS = 10 * 60_000;

/**
 * Send a share where the person picked: open that screen, put the shared text
 * into its box (appended, never sent), then hand the files to the same routing
 * as the compose bar's paperclip — pictures through the annotator, the rest
 * parked and uploaded with their paths in the box.
 *
 * The files are routed only once that session IS the one on screen, because
 * the upload lane and the box they are named into are the active session's.
 */
export async function shareTo(t: ShareTarget): Promise<void> {
  const c = core();
  const s = shared.get();
  if (!s) return;
  let repo: RepoTarget | undefined;
  let session: SessionInfo | undefined;
  if (t.kind === "session") {
    session = [c.world.active, ...c.world.sessions].find((x) => x?.id === t.sessionId) ?? undefined;
    repo = session && c.world.repos.find((r) => r.worktreePath === session!.cwd);
    if (!session) { c.say.toast("that session is gone — pick another"); return; }
    if (!repo) { c.say.toast("that session is not in a known repo — pick another"); return; }
  } else {
    repo = t.repo;
  }
  const { files, failed } = await readShared(s);
  if (failed && !files.length && !s.text) { c.say.toast("couldn't read what was shared — share it again"); return; }
  if (t.kind === "inbox") { await shareToInbox(t.repo, s, files, failed); return; }
  shared.set(null);
  goTo(null);
  c.say.track(t.kind === "new" ? "action:share.new" : "action:share.session");
  const prevId = c.world.active?.id;
  let sid: string | null;
  if (session) {
    sid = session.id;
    if (session.id !== prevId) c.nav.attach(session);
  } else {
    sid = c.launch.openCwd(repo.worktreePath, repoBranchLabel(repo), false);
  }
  const cwd = repo.worktreePath;
  const repoId = repo.id;
  if (sid && s.text) c.compose.seedDraft(sid, s.text);
  if (failed) c.say.toast(`${failed} shared file${failed === 1 ? "" : "s"} couldn't be read`);
  const t0 = Date.now();
  const land = () => {
    const a = core().world.active;
    const here = sid ? a?.id === sid : !!a && a.id !== prevId && a.cwd === cwd;
    if (!here) {
      if (Date.now() - t0 > SHARE_WAIT_MS) {
        // Never dropped: back on the share sheet, to be aimed again.
        shared.set(s);
        core().nav.open("share");
        core().say.toast("the session never opened — pick where the share goes");
        return;
      }
      setTimeout(land, 250);
      return;
    }
    // The launch question answered: this screen's box is the one to fill.
    if (!sid && s.text) core().compose.insert(s.text);
    if (!files.length) { if (s.text) core().say.toast("shared text is in the prompt — read it over, then send"); return; }
    core().files.attachFiles(files, repoId, { annotate: t.annotate });
  };
  land();
}

/**
 * No session: the files are parked in the send queue for the repo's
 * `.claude/inbox/` and go up in the background (the queue bar shows them).
 * Their own lane — not the repo's `create:` lane, which a Start sheet's
 * session would queue behind. Shared text has no box to land in, so it goes
 * to the clipboard, and the toast says so.
 */
async function shareToInbox(repo: RepoTarget, s: SharedItems, files: File[], failed: number): Promise<void> {
  const c = core();
  c.say.track("action:share.inbox");
  if (files.length > 3) c.say.toast(`preparing ${files.length} files…`);
  const refs = await c.files.attachForInbox(repo, files, `inbox:${repo.worktreePath}`);
  if (!refs.length) { c.say.toast("couldn't queue the files — share them again"); return; }
  shared.set(null);
  goTo(null);
  if (s.text) await copyText(s.text);
  const n = refs.length;
  const parts = [
    `${n} file${n === 1 ? "" : "s"} → ${repo.repoName}/.claude/inbox`,
    c.conn.status === "open" ? "uploading" : "they upload when the link is back",
  ];
  if (failed) parts.push(`${failed} couldn't be read`);
  if (s.text) parts.push("text copied");
  c.say.toast(parts.join(" · "));
}
