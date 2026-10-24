/**
 * Every writer of the images feature: the pickers, the annotator's state
 * machine and where its result goes, the viewer, the gallery / file tree /
 * sweep entries and the "new N" strip. The upload BUFFER is not here — the
 * bytes are the send path, so it is the queue's (`core().queue.uploads`).
 */
import type { BacklogItem, RepoTarget } from "@waterplane/shared";
import type { AnnDispatch, AnnSend, AnnSource } from "../../ImageAnnotator";
import type { AttachOpenDetail } from "../../attachments";
import { ATTACH_OPEN_EVENT } from "../../attachments";
import { api, copyText } from "../../api";
import { isAnnotatable } from "../../media";
import { effectiveMaxWidth, scaleForUpload } from "../../uploadScale";
import { LS, lsSetJson } from "../../storage";
import { SEND_DRAFT } from "../../sendIntent";
import type { SwipeItem } from "../../ImageSwiper";
import { core } from "../../sdk";
import {
  ann, boxReturn, collage, flow, newImages, swipe,
} from "./store";
import {
  annReturnOverlay, markedRef, ocrBlock, pasteRepeatsHeld,
  parkLane, swapImageRef, trimNewImages, type NewImg,
} from "./logic";
import { goTo, insertPath } from "./navActions";
import { setSwipe, closeSwipe, referenceNewImage, onAttachOpen } from "./viewerActions";



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
export function routeFiles(files: File[], repoId: string, opts?: { annotate?: boolean }): void {
  flow.ret = "session";
  // Not marking up: everything goes straight up, paths into the box — a share
  // of 25 photos is not 25 annotator screens.
  if (opts?.annotate === false) { void uploadMany(files, repoId); return; }
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
export function annBatch(files: AnnSource[], repoId: string): void {
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
export function offerCollage(files: File[], repoId: string, separate: (files: File[]) => void): void {
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

/** A close back onto the compose box, taken once. Stale after a few seconds or
 *  under a sheet (the backlog-item return opens one), so a later remount never
 *  steals the caret. */
export function takeBoxReturn(): boolean {
  const at = boxReturn.get();
  if (!at) return false;
  boxReturn.set(0);
  return Date.now() - at < BOX_RETURN_MS && core().nav.overlay == null;
}
const BOX_RETURN_MS = 3000;

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
/** Whether `files` are all pictures the annotator already holds (the one on
 *  screen or later in its batch) — `pasteRepeatsHeld` over the bytes. Sizes
 *  first, so a different picture never reads its bytes. */
export async function alreadyMarking(files: File[]): Promise<boolean> {
  const a = ann.get();
  if (!a || !files.length) return false;
  const held = [a.source, ...(a.rest ?? [])].filter((s): s is File => s instanceof File);
  const sizes = new Set(held.map((f) => f.size));
  if (!files.every((f) => sizes.has(f.size))) return false;
  const bytes = (f: File) => f.arrayBuffer().then((b) => new Uint8Array(b));
  try {
    const [p, h] = await Promise.all([Promise.all(files.map(bytes)), Promise.all(held.filter((f) => files.some((x) => x.size === f.size)).map(bytes))]);
    return pasteRepeatsHeld(p, h);
  } catch { return false; }
}
/** A paste or drop while marking, answered yes: pictures join the batch after the current one, the rest upload. */
export function appendToBatch(files: File[]): void {
  const a = ann.get();
  if (!a) return;
  const images = files.filter(isAnnotatable);
  if (files.length > images.length) void uploadMany(files.filter((f) => !isAnnotatable(f)), a.repoId);
  if (images.length) ann.set({ ...a, rest: [...(a.rest ?? []), ...images], total: (a.total ?? 1) + images.length, index: a.index ?? 1 });
}

// ── Send sheet and pad: the annotator's round trip ───────────────────

/**
 * Park the images a start-sheet prompt refers to. They go in the SAME lane as
 * the `session.create` op (`create:<cwd>`), so the queue uploads them first and
 * the prompt naming the paths is typed into a session whose inbox already has
 * the files. Shrunk exactly like a live upload — the wire cost is the same
 * whenever it happens to go out.
 */
export async function attachForInbox(repo: RepoTarget, files: File[], lane = `create:${repo.worktreePath}`): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    let blob: Blob = f, name = f.name;
    try {
      const { width } = effectiveMaxWidth();
      const shrunk = await scaleForUpload(f, f.name, width);
      blob = shrunk.blob; name = shrunk.name;
    } catch { /* un-shrinkable (odd type, decode failed) — send the original */ }
    const parked = await core().queue.queueImageUpload(repo.id, blob, name, lane, repo.worktreePath);
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

// The viewer and the strip live in viewerActions.ts.
export {
  seedFromRoute, setSwipe, viewImage, openNewImages, browseNewImages, openFileRef, closeSwipe, onSessionImages, referenceNewImage, dismissNewImages, minimizeNewImages, restoreNewImages,
} from "./viewerActions";
// The gallery / file tree / sweep writers live in galleryActions.ts; this file stays the one import point.
export {
  openGalleryFor, openOutboxFor, openGalleryForSend, openArtifact, downloadArtifact, closeGallery, insertFromGallery, liveSessionsIn, continueImageInSession, remarksToChat, openSweep, sweepFromGallery, setSweepScope, closeSweep, afterSweep, openBrowseFor, openBrowseAt, openGalleryHere, inActiveRepo, openBrowseHere, closeBrowse,
} from "./galleryActions";

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
  // The flow is read when the annotator OPENS: every close resets `flow.ret`
  // to "session" before it clears `ann`, a Send-sheet round trip included.
  let toBox = false;
  const offAnn = ann.subscribe(() => {
    const open = ann.get() != null;
    if (open) { toBox = flow.ret === "session"; return; }
    if (toBox) boxReturn.set(Date.now());
    toBox = false;
  });
  return () => {
    unmount(); off(); offAnn();
    window.removeEventListener(ATTACH_OPEN_EVENT, on);
    // The viewer's blob dies with it, on unmount too.
    const u = swipe.get()?.revoke;
    if (u) URL.revokeObjectURL(u);
  };
}
