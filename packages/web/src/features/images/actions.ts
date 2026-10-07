/**
 * Every writer of the images feature: the pickers, the annotator's state
 * machine and where its result goes, the viewer, the gallery / file tree /
 * sweep entries and the "new N" strip. The upload BUFFER is not here — the
 * bytes are the send path, so it is the queue's (`core().queue.uploads`).
 */
import type { BacklogItem, NewImage, RepoTarget, SweepScope } from "@waterplane/shared";
import { repoBranchLabel } from "@waterplane/shared";
import type { Overlay } from "../../routing";
import type { AnnDispatch, AnnSend, AnnSource } from "../../ImageAnnotator";
import type { AttachOpenDetail } from "../../attachments";
import { ATTACH_OPEN_EVENT, localPreview } from "../../attachments";
import { api, copyText } from "../../api";
import { startDownload } from "../../download";
import { ensureMtime, knownMtime } from "../../fileMtime";
import { isAnnotatable, sized, viewerWidth } from "../../media";
import { effectiveMaxWidth, scaleForUpload } from "../../uploadScale";
import { LS, lsSetJson } from "../../storage";
import { SEND_DRAFT } from "../../sendIntent";
import type { SwipeItem } from "../../ImageSwiper";
import { core, type CoreApi } from "../../sdk";
import {
  ann, browseAim, browseRepoId, collage, flow, galleryCtx, minimizedNewImg, newImages, sweepFor, swipe,
} from "./store";
import {
  annReturnOverlay, dropStrip, findInStrips, galleryCtxForFile, isVideoPath, isViewable, markedRef, mergeNewImages, ocrBlock, outboxCut,
  parkLane, swapImageRef, trimNewImages, type GalleryCtx, type NewImg, type SwipeState,
} from "./logic";



/** Show `o`, or close whatever is on top when `o` is null (App's `setOverlay(o)`). */
function goTo(o: Overlay): void {
  const nav = core().nav;
  if (o) nav.open(o);
  else if (nav.overlay) nav.close(nav.overlay);
}

// ── Seeding (App, once) ──────────────────────────────────────────────

/** One ad-hoc viewer row for a repo-relative file. */
function swipeRow(repoId: string, relPath: string): SwipeItem {
  const url = api.artifactUrl(repoId, relPath);
  const video = isVideoPath(relPath);
  // Versioned when this device has seen the file's mtime (fileMtime.ts) — the
  // viewer opened from a tapped mention would otherwise be the one screen whose
  // picture no cache is allowed to keep. `ensureMtime` learns it for next time.
  ensureMtime(repoId, relPath);
  const mtime = knownMtime(repoId, relPath);
  return { name: relPath.split("/").pop() || relPath, relPath, url: video ? url : sized(url, viewerWidth(), mtime), fullUrl: url, video, repoId };
}

/**
 * The cold-start route: a notification tap that encoded a picture (→ the
 * viewer) or a file the viewer renders (→ the gallery, straight on it). App
 * calls this with its first `parseHash()`, before the first render reads
 * a sheet. The strip is persisted, so a cold start can still open the picture
 * at its place in that session's batch and swipe the rest. Once per page:
 * App calls it in render, and every render after the first is a no-op.
 */
let seeded = false;
export function seedFromRoute(r: { image?: { repoId: string; relPath: string }; file?: { repoId: string; relPath: string; name?: string; mtime?: number } }, fileViewable: boolean): void {
  if (seeded) return;
  seeded = true;
  if (r.image) {
    const hit = findInStrips(newImages.get(), r.image);
    swipe.set(hit ?? { items: [swipeRow(r.image.repoId, r.image.relPath)], repoId: r.image.repoId, i: 0 });
  }
  if (r.file && fileViewable) galleryCtx.set(galleryCtxForFile(r.file));
}

/** The viewer's state, with the object URL it drew from released the moment it
 *  lets go of it — on close, on a swap to another file, alike. Keyed on the
 *  URL so no exit from the viewer can be the one that leaks. */
export function setSwipe(next: SwipeState | null | ((cur: SwipeState | null) => SwipeState | null)): void {
  const prev = swipe.get()?.revoke;
  swipe.set(next);
  const now = swipe.get()?.revoke;
  if (prev && prev !== now) URL.revokeObjectURL(prev);
}

// ── Pickers ──────────────────────────────────────────────────────────

let imageInput: HTMLInputElement | null = null;
let docInput: HTMLInputElement | null = null;

/** Open the file picker, recording which repo the result should target. */
export function pickImageFor(repoId: string): void {
  flow.ret = "session"; // default; backlog flow overrides after
  flow.pickRepo = repoId;
  imageInput?.click();
}
/** Open the ANY-TYPE picker (PDFs, docs, archives, audio, source files…),
 *  recording which repo the result should target. */
export function pickFileFor(repoId: string): void {
  flow.ret = "session"; // default; backlog flow overrides after
  flow.pickRepo = repoId;
  docInput?.click();
}

function takePick(input: HTMLInputElement): { files: File[]; repoId: string } | null {
  const files = Array.from(input.files ?? []);
  input.value = "";
  const repoId = flow.pickRepo;
  flow.pickRepo = null;
  return files.length && repoId ? { files, repoId } : null;
}

/** Files picked through the any-type picker. A PDF or a zip has nothing to
 *  draw on, so those go straight up (`scaleForUpload` shrinks images and passes
 *  everything else through untouched) and their paths land in the compose box.
 *
 *  IMAGES picked here still go through the annotator. This picker is
 *  deliberately unfiltered, so it is a perfectly ordinary way to reach a
 *  screenshot — and the whole reason to send one from a phone is usually to
 *  point at the part that is wrong. Routing by the file's own type rather than
 *  by which button was tapped means the two entry points can't disagree about
 *  what happens to the same JPEG; the "no annotator" rule was never about this
 *  picker, it was about bytes a canvas can't decode. */
function onPickFiles(input: HTMLInputElement): void {
  const pick = takePick(input);
  if (!pick) return;
  core().say.track("action:attach.file");
  routeFiles(pick.files, pick.repoId);
}
/** The any-type picker's routing, by each file's own type — also what a share
 *  from another app runs (`core().files.attachFiles`, features/share), so the
 *  two cannot disagree. Into the ACTIVE session's box and upload lane. */
export function routeFiles(files: File[], repoId: string): void {
  flow.ret = "session";
  const images = files.filter(isAnnotatable);
  const rest = files.filter((f) => !isAnnotatable(f));
  // Non-images leave first: their paths are appended to the compose box by
  // `uploadMany`, and the annotator's own send appends after it, so the
  // references come out in the order they were picked.
  if (rest.length) void uploadMany(rest, repoId);
  if (!images.length) return;
  if (images.length === 1) { openAnnotator({ source: images[0], repoId }); return; }
  // Same offer as `onPickImage`, and the same fallback: backlog and other
  // non-session targets never annotate, they just want the paths.
  offerCollage(images, repoId, (ordered) => {
    if (flow.ret !== "session") { void uploadMany(ordered, repoId); return; }
    annBatch(ordered, repoId);
  });
}
function onPickImage(input: HTMLInputElement): void {
  const pick = takePick(input);
  if (!pick) return;
  const { files, repoId } = pick;
  if (files.length === 1) { openAnnotator({ source: files[0], repoId }); return; }
  // Many images: one picture or several? Declining resumes what this flow did
  // before — a batch through the annotator for a session, a plain multi-upload
  // for the backlog and the other non-annotating targets.
  offerCollage(files, repoId, (ordered) => {
    if (flow.ret === "session") { annBatch(ordered, repoId); return; }
    void uploadMany(ordered, repoId);
  });
}

/**
 * The two hidden `<input type=file>`s, created once rather than rendered by
 * each screen (the launcher, the session screen and the empty state each drew
 * their own pair). The camera one keeps `accept="image/*"` because that is what
 * makes a phone offer "take a photo" at all — dropping the attribute to cover
 * PDFs would have cost the one-tap camera path. The other is the separate
 * picker for NON-image documents.
 */
function mountPickers(): () => void {
  const make = (accept: string | null, onChange: (el: HTMLInputElement) => void) => {
    const el = document.createElement("input");
    el.type = "file";
    el.multiple = true;
    el.hidden = true;
    if (accept) el.accept = accept;
    el.addEventListener("change", () => onChange(el));
    document.body.appendChild(el);
    return el;
  };
  imageInput = make("image/*", onPickImage);
  docInput = make(null, onPickFiles);
  return () => { imageInput?.remove(); docInput?.remove(); imageInput = docInput = null; };
}

// ── The annotator ────────────────────────────────────────────────────

function openAnnotator(a: { source: AnnSource; repoId: string; facts?: string }): void {
  ann.set(a);
  core().nav.open("image");
}
/** Start a multi-image batch: the annotator, one picture at a time. */
function annBatch(files: AnnSource[], repoId: string): void {
  ann.set({ source: files[0], repoId, rest: files.slice(1), total: files.length, index: 1 });
  core().nav.open("image");
}
/**
 * More than one image was picked — ask whether they are one picture.
 *
 * In front of EVERY multi-image pick (compose bar, any-type picker, Start
 * sheet, pad, backlog), because the reason to combine is a property of the
 * pictures, not of where they were picked: a mark cannot cross from one image
 * to the next, so a bug that spans three screens can only be circled once they
 * are on one canvas. `separate` is exactly what that pick site did before this
 * existed, so declining costs one tap and changes nothing.
 */
function offerCollage(files: File[], repoId: string, separate: (files: File[]) => void): void {
  collage.set({ files, repoId, separate });
  core().nav.open("collage");
}
/** Advance a batch to the next image, or close when done. Used by send + skip. */
function advanceBatch(): void {
  const cur = ann.get();
  if (cur?.rest && cur.rest.length) {
    const [next, ...rest] = cur.rest;
    ann.set({ source: next, repoId: cur.repoId, rest, total: cur.total, index: (cur.index ?? 1) + 1 });
    return;
  }
  goTo(null);
  ann.set(null);
}

/** Collage sheet: combined into ONE picked file, so from here on every flow is
 *  the ordinary single-image one — the annotator, then the same upload, the
 *  same lane, the same return route. Nothing downstream knows this happened. */
export function collageCombine(file: File, facts: string): void {
  const c = collage.get();
  if (!c) return;
  collage.set(null);
  openAnnotator({ source: file, repoId: c.repoId, facts });
}
export function collageSeparate(ordered: File[]): void {
  const c = collage.get();
  if (!c) return;
  collage.set(null);
  c.separate(ordered);
}
export function collageClose(): void {
  const back = annReturnOverlay(flow.ret, core().nav.sendSeeded());
  flow.ret = "session";
  collage.set(null);
  goTo(back);
}

/** Upload several picked files at once and route every saved path (no
 *  annotation). Type-agnostic: images are shrunk, everything else goes as-is. */
async function uploadMany(files: File[], repoId: string): Promise<void> {
  flow.ret = "session";
  const c = core();
  const saved: string[] = [];
  const repoDir = c.world.repos.find((r) => r.id === repoId)?.worktreePath ?? repoId;
  // Park them in the lane the PATHS are about to be used from — the active
  // session, or the repo when there is none. A lane of its own would let the
  // message naming these files overtake them; `guardUploadRefs` corrects the
  // lane at send time too, but only for text queued through this app — getting
  // it right here is what keeps the ordering true for everything else.
  const lane = c.world.active?.id ?? repoDir;
  // Same rule as `UploadBuf.fail`: say WHICH half failed. A picture that
  // couldn't be parked is a storage problem on this phone (and the file is
  // still in the picker); one that couldn't be read never had bytes.
  let why = "";
  for (const f of files) {
    try {
      const { width } = effectiveMaxWidth();
      const shrunk = await scaleForUpload(f, f.name, width);
      // Park, never POST from here — same rule as `queueUpload`: the bytes
      // reach durable storage before anything can go wrong, and the path they
      // WILL have is known immediately. A dead tunnel, a mid-transfer reload
      // and a plain slow uplink all become "it goes out when it can".
      const parked = await c.queue.queueImageUpload(repoId, shrunk.blob, shrunk.name, lane, repoDir);
      if (parked) saved.push(parked.relPath);
      else why ||= "this browser can't hold files offline — reconnect and re-attach";
    } catch { why ||= "couldn't read that file"; }
  }
  const say = core().say;
  if (!saved.length) { say.toast(why || "Upload failed"); return; }
  saved.forEach((p) => core().compose.insert(p));
  await copyText(saved.join(" "));
  goTo(null); ann.set(null);
  say.toast(core().conn.status === "open"
    ? `Sent ${saved.length} · paths copied`
    : `${saved.length} queued · they upload when the link is back`);
}

/** The annotator's `onPark` (backlog / gallery flows upload inline inside the
 *  sheet; with no tunnel that used to throw away a picture that had just been
 *  marked up). */
export async function parkAnnotated(blob: Blob, name: string): Promise<string | null> {
  const a = ann.get();
  if (!a) return null;
  const c = core();
  const dir = c.world.repos.find((r) => r.id === a.repoId)?.worktreePath ?? a.repoId;
  const lane = parkLane(flow.ret, dir, c.world.active?.id ?? null, flow.sendRepo?.worktreePath, flow.padRepo?.worktreePath);
  return (await c.queue.queueImageUpload(a.repoId, blob, name, lane, dir))?.relPath ?? null;
}

/** Per-image send from the annotator (session flow). `cur.blob` may still be
 *  ENCODING (the annotator hands it over as a promise so its sheet can close on
 *  the tap); `queueUpload` awaits it inside the background slot. Uploads in the
 *  background and advances to the next image immediately — no waiting. `mode`
 *  marks the batch to submit — or to queue as an auto-fire backlog item — once
 *  every upload lands. */
export function dispatchImage(cur: AnnDispatch, mode: AnnSend): void {
  const a = ann.get();
  if (!a) return;
  const up = core().queue.uploads;
  const buf = up.ensureUploadBuf(a.repoId);
  if (mode === "run") buf.submit = true;
  if (mode === "queue") buf.queue = true;
  up.queueUpload(buf, cur.blob, cur.name, cur.note, cur.size);
  if (a.rest && a.rest.length) {
    advanceBatch();
    core().say.toast(`Sent ${a.index}/${a.total} · next…`);
  } else {
    buf.closed = true;
    ann.set(null); goTo(null);
    up.settleUploads(buf);
  }
}
/** Skip the current image (batch). Closes the buffer if it was the last one. */
export function skipImage(): void {
  const a = ann.get();
  if (a?.rest && a.rest.length) { advanceBatch(); core().say.toast(`Skipped ${a.index}/${a.total}`); return; }
  const up = core().queue.uploads;
  const buf = up.current();
  if (buf) { buf.closed = true; up.settleUploads(buf); }
  const back = annReturnOverlay(flow.ret, core().nav.sendSeeded());
  flow.ret = "session";
  ann.set(null); goTo(back);
}
/** Batch "send all": dispatch the current flattened image + every remaining one
 *  raw/as-is through the background buffer, then close. `mode` submits or
 *  queues the compose text once they all land. */
export function sendAllBatch(cur: AnnDispatch, mode: AnnSend): void {
  const a = ann.get();
  if (!a) return;
  const { repoId, rest = [] } = a;
  const up = core().queue.uploads;
  const buf = up.ensureUploadBuf(repoId);
  if (mode === "run") buf.submit = true;
  if (mode === "queue") buf.queue = true;
  up.queueUpload(buf, cur.blob, cur.name, cur.note, cur.size);
  for (const s of rest) {
    // `s.url` is a blob:/data: URL this page minted, so there is no host to
    // route to, no auth to carry, and nothing that can hang.
    // eslint-disable-next-line no-restricted-globals -- an object URL, not the API
    const blob: Blob | Promise<Blob> = s instanceof File ? s : fetch(s.url).then((r) => r.blob());
    up.queueUpload(buf, blob, s.name);
  }
  buf.closed = true;
  ann.set(null); goTo(null);
  up.settleUploads(buf);
}
/** The annotator's own close. Session flow: whatever was already dispatched
 *  still uploads and lands in compose. */
export function closeAnnotator(): void {
  const back = annReturnOverlay(flow.ret, core().nav.sendSeeded());
  const up = core().queue.uploads;
  const b = up.current();
  if (flow.ret === "session" && b) { b.closed = true; up.settleUploads(b); }
  flow.ret = "session"; flow.backlogEdit = null;
  ann.set(null); goTo(back);
}

/** Where a finished single upload goes: the backlog item being re-marked, the
 *  Send sheet's draft, the pad's, or the compose box. */
export async function afterUpload(relPath: string, note?: string): Promise<void> {
  const ref = markedRef(relPath, note);
  const say = core().say;
  if (flow.ret === "backlog-item" && flow.backlogEdit) {
    const { id, oldPath, text } = flow.backlogEdit;
    flow.backlogEdit = null;
    flow.ret = "session";
    const next = swapImageRef(text, oldPath, ref);
    ann.set(null); core().nav.open("backlog");
    // `backlog.update` is not a durable op (no ackId, nothing on the queue can
    // carry it), so the receipt is `liveSend`'s: said only when the frame left
    // on an open socket. A bare `send` offline sat in ws.ts's RAM buffer — lost
    // to a reload — under a toast claiming the row had changed. The picture
    // itself is parked and uploads regardless; only the row's words wait.
    if (next !== text) {
      core().conn.liveSend({ t: "backlog.update", id, text: next }, `updated image: ${relPath}`,
        `no connection — the marked image will still upload (${relPath}), but the backlog row lives on the desktop and still names the old one`);
    } else say.toast(`updated image: ${relPath}`);
    return;
  }
  if (flow.ret === "send") { appendSendDraft(ref); return; }
  if (flow.ret === "pad") { appendPadDraft(ref); return; }
  // Insert into the compose box only when a session is open; always copy.
  if (core().world.active) core().compose.insert(ref);
  await copyText(ref);
  // Mid-batch → advance to the next image; otherwise close.
  const a = ann.get();
  if (a?.rest && a.rest.length) { advanceBatch(); say.toast(`Sent ${a.index}/${a.total} · next…`); return; }
  goTo(null); ann.set(null);
  say.toast(`Sent · path copied: ${relPath}`);
}

/**
 * The annotator's "text only": the words the desktop read off the picture, as
 * edited, go where the picture's path would have gone — and the picture goes
 * nowhere (nothing is uploaded to the inbox, so no agent can open it). Appended,
 * never seeded over a draft.
 */
export function afterText(text: string): void {
  const block = ocrBlock(text);
  const c = core();
  if (flow.ret === "backlog-item" && flow.backlogEdit) {
    const { id, oldPath, text: row } = flow.backlogEdit;
    flow.backlogEdit = null;
    flow.ret = "session";
    ann.set(null); c.nav.open("backlog");
    c.conn.liveSend({ t: "backlog.update", id, text: swapImageRef(row, oldPath, block) }, "the image is now its text",
      "no connection — the backlog row lives on the desktop and still names the image");
    return;
  }
  if (flow.ret === "send") c.compose.appendSheetDraft(SEND_DRAFT, block);
  else if (flow.ret === "pad") {
    c.compose.appendSheetDraft("pad.editor", block);
    if (!c.compose.loadSheetDraft("pad.editor.id")) c.compose.seedSheetDraft("pad.editor.id", "new");
  } else if (c.world.active) c.compose.insert(block);
  else void copyText(block);
  const a = ann.get();
  if (a?.rest && a.rest.length) { advanceBatch(); c.say.toast(`Text added ${a.index}/${a.total} · next…`); return; }
  c.say.toast(flow.ret === "session" && !c.world.active ? "text copied — no session open to put it in" : "text added — the photo was not sent");
  closeAnnotator();
}

/** Open a picture at a URL in the annotator. */
export function annotateUrl(url: string, name: string, repoId: string): void {
  openAnnotator({ source: { url, name }, repoId });
}
/** The gallery's and the viewer's `mark`: the session flow, on a URL. */
export function annotateUrlForSession(url: string, name: string, repoId: string): void {
  flow.ret = "session";
  annotateUrl(url, name, repoId);
}
/** Pop a new agent-produced image straight into the annotator (mark & iterate). */
function annotateNewImage(im: NewImg): void {
  annotateUrlForSession(api.artifactUrl(im.repoId, im.relPath), im.name, im.repoId);
}

/** Whether the annotator holds a picture being marked — which exists only as
 *  canvas state until it is sent, so the watchdog's hard reload must wait.
 *  App's reload guard ORs this with the upload buffer's own. */
export function annotatorBusy(): boolean {
  return core().nav.overlay === "image" && ann.get() != null;
}

// ── Send sheet and pad: the annotator's round trip ───────────────────

/**
 * Park the images a start-sheet prompt refers to. They go in the SAME lane as
 * the `session.create` op (`create:<cwd>`), so the queue uploads them first and
 * the prompt naming the paths is typed into a session whose inbox already has
 * the files. Shrunk exactly like a live upload — the wire cost is the same
 * whenever it happens to go out.
 */
export async function attachForInbox(repo: RepoTarget, files: File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    let blob: Blob = f, name = f.name;
    try {
      const { width } = effectiveMaxWidth();
      const shrunk = await scaleForUpload(f, f.name, width);
      blob = shrunk.blob; name = shrunk.name;
    } catch { /* un-shrinkable (odd type, decode failed) — send the original */ }
    const parked = await core().queue.queueImageUpload(repo.id, blob, name, `create:${repo.worktreePath}`, repo.worktreePath);
    if (parked) out.push(parked.relPath);
    else core().say.toast("this browser can't hold files offline — reconnect and attach again");
  }
  return out;
}

/**
 * Images picked in the Send sheet (or the pad) go through the ANNOTATOR,
 * exactly like a compose attach. Pointing at the part that is wrong is usually
 * the whole reason a screenshot is sent from a phone, and this is the entry
 * point where the picture is most often the entire brief.
 *
 * The round trip is via the sheet's own DRAFT rather than component state,
 * because the annotator REPLACES the sheet (one overlay at a time) and the
 * sheet re-reads its draft when it comes back. That is also what makes the
 * path survive a reload taken inside the annotator.
 */
export function annotate(repo: RepoTarget, files: File[], returnTo: "send" | "pad"): void {
  if (!files.length) return;
  flow.ret = returnTo;
  if (returnTo === "send") flow.sendRepo = repo; else flow.padRepo = repo;
  if (files.length === 1) { openAnnotator({ source: files[0], repoId: repo.id }); return; }
  offerCollage(files, repo.id, (ordered) => annBatch(ordered, repo.id));
}

/** Put a marked image's path into the Start sheet's first prompt and go back
 *  to it (or on to the next image of a batch). The FIRST prompt is the one that
 *  rides inside `session.create`, and the upload was parked in that create's
 *  lane ahead of it — so the file is in `.claude/inbox` before the prompt
 *  naming it is typed. */
function appendSendDraft(ref: string): void {
  const c = core();
  c.compose.appendSheetDraft(SEND_DRAFT, ref);
  const a = ann.get();
  if (a?.rest && a.rest.length) { advanceBatch(); c.say.toast(`Attached ${a.index}/${a.total} · next…`); return; }
  flow.ret = "session";
  ann.set(null);
  // Straight to the overlay, deliberately NOT through `openSend`: that one
  // OVERWRITES the draft from its seed, which is exactly the path just
  // appended. The seed is still in state; only the words changed.
  const seeded = c.nav.sendSeeded();
  goTo(seeded ? "send" : null);
  void copyText(ref);
  c.say.toast(seeded ? "attached · the path is in the prompt" : `path copied: ${ref}`);
}
/** Put a marked image's path into the pad editor's FIRST step and go back to
 *  it (or on to the next image of a batch). \f separates the chain, exactly as
 *  in the Start sheet's draft. */
function appendPadDraft(ref: string): void {
  const c = core();
  c.compose.appendSheetDraft("pad.editor", ref);
  // The editor reopens on the buffer, so it needs an id to reopen AS: a note
  // being written for the first time is "new".
  if (!c.compose.loadSheetDraft("pad.editor.id")) c.compose.seedSheetDraft("pad.editor.id", "new");
  const a = ann.get();
  if (a?.rest && a.rest.length) { advanceBatch(); c.say.toast(`Attached ${a.index}/${a.total} · next…`); return; }
  flow.ret = "session";
  ann.set(null);
  c.nav.open("pad");
  void copyText(ref);
  c.say.toast("attached · the path is in the note");
}

/** Open an image referenced by a backlog item in the annotator; the marked copy
 *  swaps the path in the item. */
export function backlogEditImage(it: BacklogItem, relPath: string): void {
  const id = core().world.repos.find((r) => r.worktreePath === it.repoDir)?.id;
  if (!id) { core().say.toast("unknown repo"); return; }
  flow.ret = "backlog-item";
  flow.backlogEdit = { id, oldPath: relPath, text: it.text };
  annotateUrl(api.artifactUrl(id, relPath), relPath.split("/").pop() || "image", id);
}

// ── The viewer ───────────────────────────────────────────────────────

/** Open an agent-produced image FULL-SCREEN (notification tap, cold-tap route,
 *  service-worker message). Viewing is what a "new screenshot" tap means; the
 *  viewer's `mark` button opens the annotator (and its send puts the marked copy
 *  back in `.claude/inbox`), so the previous straight-to-annotator jump only
 *  ever cost a step. When the file is part of a session's new-image batch, the
 *  whole batch is swipeable from it. */
export function viewImage(im: { repoId: string; relPath: string }, sessionId?: string): void {
  const hit = findInStrips(newImages.get(), im, sessionId);
  ann.set(null);
  setSwipe(hit ?? { items: [swipeRow(im.repoId, im.relPath)], repoId: im.repoId, i: 0 });
  core().nav.open("swipe");
}
/** Tap on a row's new-image COUNT: the same full-screen batch, from the first
 *  one. The launcher row has no thumbs to aim at — the badge is the only thing
 *  there that says the pictures exist, so it has to be the way into them. */
export function openNewImages(sessionId: string): void {
  core().say.track("action:newimg.open");
  setSwipe({ sessionId, i: 0 });
  core().nav.open("swipe");
}
/** Tap on a strip thumb: open the session's new images full-screen, starting at
 *  this one, so the batch can be swiped through instead of open-close-open. */
export function browseNewImages(sessionId: string, im: NewImg): void {
  core().say.track("action:newimg.open");
  const items = newImages.get().get(sessionId) ?? [];
  setSwipe({ sessionId, i: Math.max(0, items.findIndex((x) => x.relPath === im.relPath)) });
  core().nav.open("swipe");
}
/** Tap on an `.claude/inbox` / `.claude/outbox` path mentioned in the reader
 *  view, or on a file a queued prompt names. Images (and videos) open in the
 *  full-screen viewer; everything else opens in the GALLERY's document viewer
 *  (`openArtifact`'s surface) — markdown rendered, text shown, and a download
 *  one tap away inside it for what has no preview. It used to download
 *  straight away, so tapping `.claude/outbox/plan.md` in a reply saved a file
 *  instead of showing it; before that it opened a tab, which in the Android
 *  shell opens nothing at all. `back` is the screen to return to when the
 *  viewer closes: the reader is not an overlay and passes none, a sheet passes
 *  its own, or the tap would close the sheet the file was tapped in. */
export function openFileRef(repoId: string, relPath: string, back?: Overlay): void {
  core().say.track("action:read.fileref");
  if (isViewable(relPath)) {
    setSwipe({ items: [swipeRow(repoId, relPath)], repoId, i: 0, back });
    core().nav.open("swipe");
    return;
  }
  // Not `openArtifact`: that counts a notification tap when handed no return.
  galleryCtx.set(galleryCtxForFile({ repoId, relPath }, back));
  core().nav.open("gallery");
}

/**
 * A file a queued prompt names, opened from wherever that prompt is shown
 * (`AttachStrip` → `requestAttachOpen`).
 *
 * Two copies can answer and they are not interchangeable. On the host it is the
 * ordinary viewer — screen-sized, full-res behind a tap, annotatable. Off it,
 * the only bytes that exist are this phone's own (a queued upload, or one kept
 * after the upload died), and those are precisely the pictures with no other
 * route to them: not in the gallery, not at any URL, gone the moment the ledger
 * drops them. So they open too, from a blob this state owns.
 */
function onAttachOpen(d: AttachOpenDetail): void {
  const back = core().nav.overlay;
  if (d.state === "host" && d.repoId) { openFileRef(d.repoId, d.relPath, back); return; }
  void localPreview(d.relPath, d.state, [...core().queue.entries]).then((url) => {
    if (!url) { core().say.toast("no copy of this file on this phone"); return; }
    core().say.track("action:attach.openlocal");
    setSwipe({
      items: [{ name: d.relPath.split("/").pop() || d.relPath, relPath: d.relPath, url, repoId: d.repoId ?? undefined }],
      repoId: d.repoId ?? undefined, i: 0, back, revoke: url,
    });
    core().nav.open("swipe");
  });
}

/** The viewer's close: back to the screen it was opened from. */
export function closeSwipe(): void {
  const back = swipe.get()?.back ?? null;
  goTo(back);
  setSwipe(null);
}
/** The viewer's `mark`. A session strip's picture annotates the original from
 *  its strip row; an ad-hoc one its full-res URL. */
export function markFromSwipe(row: SwipeItem, strip: readonly NewImg[]): void {
  const im = strip.find((x) => x.relPath === row.relPath);
  // Where the viewer came from, read BEFORE the viewer is cleared — the
  // fallback below goes back there (`closeSwipe` reads it off the store, which
  // is already null by then).
  const back = swipe.get()?.back ?? null;
  setSwipe(null);
  // Ad-hoc list (a tapped file mention): annotate the original bytes directly.
  if (im) annotateNewImage(im);
  else if (row.repoId) annotateUrlForSession(row.fullUrl ?? row.url, row.name, row.repoId);
  else goTo(back);
}
/** The viewer's `ref`: the path into the compose box, and on the clipboard. */
export function refFromSwipe(row: SwipeItem, strip: readonly NewImg[]): void {
  const im = strip.find((x) => x.relPath === row.relPath);
  if (im) referenceNewImage(im);
  else insertPath(row.relPath);
  closeSwipe();
}

/** A path into the compose box + the clipboard, said. */
function insertPath(p: string): void {
  core().compose.insert(p); void copyText(p); core().say.toast(`path copied: ${p}`);
}

// ── The "new N" strip ────────────────────────────────────────────────

/** `session.images`: the files this turn produced join the session's strip,
 *  which unfolds if it was minimized — they are news. */
export function onSessionImages(sessionId: string, repoId: string, images: readonly NewImage[]): void {
  newImages.set((prev) => mergeNewImages(prev, sessionId, repoId, images));
  restoreNewImages(sessionId);
  core().say.toast(`${images.length} new image${images.length > 1 ? "s" : ""}`);
}
/** Reference a new image by path in the compose box without annotating. */
export function referenceNewImage(im: NewImg): void {
  core().say.track("action:newimg.ref");
  insertPath(im.relPath);
}
export function dismissNewImages(sessionId: string): void {
  newImages.set((prev) => dropStrip(prev, sessionId));
  restoreNewImages(sessionId);
}
/** Fold the strip down to its "new N" pill without losing the images —
 *  unlike `dismissNewImages`, which deletes them. */
export function minimizeNewImages(sessionId: string): void {
  minimizedNewImg.set((prev) => (prev.has(sessionId) ? prev : new Set(prev).add(sessionId)));
}
export function restoreNewImages(sessionId: string): void {
  minimizedNewImg.set((prev) => { if (!prev.has(sessionId)) return prev; const n = new Set(prev); n.delete(sessionId); return n; });
}

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
export function downloadArtifact(f: { repoId: string; relPath: string; name: string; size?: number; mtime?: number }): void {
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
/** From the gallery viewer: pull an image into a coding session as context.
 *  Reuses a live session in that repo, else opens one resumed (--continue), and
 *  puts the image path in the compose box so the work can continue. */
export function continueImageInSession(relPath: string, repoId: string): void {
  const c = core();
  const repo = c.world.repos.find((r) => r.id === repoId);
  if (!repo) { c.say.toast("unknown repo"); return; }
  galleryCtx.set(null);
  goTo(null);
  const existing = c.world.sessions.find((s) => s.cwd === repo.worktreePath && s.running);
  // Seeded into the draft of the screen being OPENED (`compose.seedDraft`),
  // never `insert` — that types into the box being left, and the incoming
  // screen's own draft then replaced it: the path was lost while the toast
  // named it. An APPEND either way (`local/no-draft-clobber`).
  if (existing) {
    c.nav.attach(existing);
    c.compose.seedDraft(existing.id, relPath);
    void copyText(relPath);
    c.say.toast(`opened session · ${relPath}`);
  } else {
    void copyText(relPath);
    const sid = c.launch.openCwd(repo.worktreePath, repoBranchLabel(repo), true);
    // null: the tap waits on the launch question, and no screen was opened
    // yet — the box on screen is still the one to add to.
    if (sid) c.compose.seedDraft(sid, relPath); else c.compose.insert(relPath);
    c.say.toast(`new session · ${relPath}`);
  }
}

/**
 * Remarks on a file (`FileReview.tsx`) into the chat of the repo the file is
 * in: the session on screen if it is that repo's, else a live one there, else
 * a new one picking up its last conversation — `continueImageInSession`'s
 * ladder, except that the session already on screen comes first. Seeded into
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

/** The file tree for a repo named on the launcher. */
export function openBrowseFor(repoId: string): void {
  browseRepoId.set(repoId);
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

// ── Boot ─────────────────────────────────────────────────────────────

/** The pickers, the attach-open listener and the strip's write-through. */
export function bootImages(): () => void {
  const unmount = mountPickers();
  const on = (e: Event) => {
    const d = (e as CustomEvent<AttachOpenDetail>).detail;
    if (d) onAttachOpen(d);
  };
  window.addEventListener(ATTACH_OPEN_EVENT, on);
  // Write-through on every change so the strip survives reloads.
  const off = newImages.subscribe(() => lsSetJson(LS.newImages, trimNewImages(newImages.get())));
  return () => {
    unmount(); off();
    window.removeEventListener(ATTACH_OPEN_EVENT, on);
    // The viewer's blob dies with it, on unmount too.
    const u = swipe.get()?.revoke;
    if (u) URL.revokeObjectURL(u);
  };
}

