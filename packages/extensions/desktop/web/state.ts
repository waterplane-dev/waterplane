/**
 * The live desktop's long-lived state, outside any one view: what the last `probe` said (which the
 * header segment and the ☰ line read on every render, so it must be a cheap read), the
 * remembered Quality choice (per host, `extStorage`), and the sheet id. One writer each: the
 * functions here.
 *
 * The probe is re-asked when the view is opened and on every reconnect (`welcome`). While it has
 * never answered, the view counts as available — the view itself then says what the desktop says.
 */
import { core, createStore, desktopScreenshot, extStorage, featureSheetId, pluginClient } from "@waterplane/sdk";
import { PLUGIN_ID, type DesktopMethods } from "../shared/wire.mts";
import { cleanDraft } from "./keys.ts";
import { cleanChoice, type QualityChoice } from "./quality.ts";
import { SHOT_BUSY, SHOT_NO_REPO, SHOT_OFFLINE, entryAvailability, shotReceipt, type ProbeState } from "./words.ts";

export const DESKTOP_SHEET = featureSheetId("desktop", "view");
/** `DesktopMethods` is an interface (no implicit index signature); its mapped copy satisfies `PluginMethods`. */
type Methods = { [K in keyof DesktopMethods]: DesktopMethods[K] };
export const client = pluginClient<Methods>(PLUGIN_ID);
const store = extStorage(PLUGIN_ID);

export const probe = createStore<ProbeState>({ k: "unknown" });
let inflight: Promise<void> | null = null;

/** Ask the desktop what it can show. Offline it keeps what it knew: a dead link is not a refusal. */
export function refreshProbe(): Promise<void> {
  if (core().conn.status !== "open") return Promise.resolve();
  inflight ??= client.read("probe", {}).then((res) => {
    probe.set(res.ok ? { k: "ok", r: res.result, at: Date.now() } : { k: "failed", error: res.error, at: Date.now() });
  }).finally(() => { inflight = null; });
  return inflight;
}

/** For `available()`: the cached answer, never a call. */
export const desktopAvailability = (): true | string => entryAvailability(probe.get());

/** What the last grant tap said (`grant`), shown under the view's sentence until the next probe. */
export const grantNote = createStore<string | null>(null);

/** Ask macOS for Screen Recording or Accessibility on the desktop: a person's tap, never repeated by a reconnect. */
export async function askGrant(kind: "screen" | "accessibility"): Promise<void> {
  grantNote.set("Asking the desktop…");
  const res = await client.call("grant", { kind });
  grantNote.set(res.ok ? res.result.note : `The desktop could not ask: ${res.error}`);
}

/**
 * The view's "turn on control": the same write as the switch in Settings (`plugin.set`, the
 * person's tap behind a confirm), so the host still decides — a refusal lands where the Settings
 * row shows it, and the view's status says whether control is on. Live only: a switch flipped an
 * hour later from a queue is a decision about a desktop nobody is watching.
 */
export function turnOnControl(): void {
  core().conn.liveSend({ t: "plugin.set", id: PLUGIN_ID, values: { control: true } }, "Control switched on",
    "no connection — control is switched on the desktop");
}

export const choice = createStore<QualityChoice>(cleanChoice(store.read("quality", null)));

export function setChoice(patch: Partial<QualityChoice>): void {
  const next = cleanChoice({ ...choice.get(), ...patch });
  choice.set(next);
  store.write("quality", next);
}

export function openDesktop(): void {
  void refreshProbe();
  core().nav.open(DESKTOP_SHEET);
}

export function closeDesktop(): void {
  clearSecret();
  core().nav.close(DESKTOP_SHEET);
}

/**
 * Protected typing: a masked field in place of the typing box, for a password. MEMORY ONLY — never
 * `extStorage`, never the draft (the draft is untouched underneath). `seq` names one protected ask: it
 * moves on whenever the field is switched off, emptied by a send or the view closed, so a filler's
 * value that lands later than that (`fillSecret`) is refused, never put into a field nobody asked from.
 * `reopen`: a filler's value landed while another sheet (the one picking the login) had replaced this
 * view, so the view comes back with the typing panel open (`takeReopen`).
 */
export interface SecretState { on: boolean; value: string; seq: number; reopen: boolean }
export const secret = createStore<SecretState>({ on: false, value: "", seq: 0, reopen: false });

/** What the vault's card says the password is for (`SecretFillContext.askLine`). */
export const SECRET_ASK = "a password field on the live desktop";

export function setSecretOn(on: boolean): void {
  secret.set((s) => (on ? { ...s, on: true } : { on: false, value: "", seq: s.seq + 1, reopen: false }));
}
export function setSecretValue(value: string): void {
  secret.set((s) => ({ ...s, value }));
}
/** After a send went out in full, or the view closed: the value goes, the ask with it. */
export function clearSecret(): void {
  secret.set((s) => ({ ...s, value: "", seq: s.seq + 1, reopen: false }));
}

/** A filler's value for the ask `seq`: true if it landed in the masked field. Never types anything. */
export function fillSecret(seq: number, value: string): boolean {
  const s = secret.get();
  if (!value || !s.on || s.seq !== seq) return false;
  const away = core().nav.overlay !== DESKTOP_SHEET;
  secret.set({ ...s, value, reopen: away });
  if (away) openDesktop();
  return true;
}

/** Read once by a mounting view: open the typing panel because a fill brought it back. */
export function takeReopen(): boolean {
  const r = secret.get().reopen;
  if (r) secret.set((s) => ({ ...s, reopen: false }));
  return r;
}

/** What was typed for the desktop and not sent yet. Kept outside the panel so closing it (or the
 *  view) never throws away somebody's words, and in `extStorage` so a reload or an app kill does
 *  not either (per host, like the Quality choice); cleared only by a send that went out. */
export const draft = createStore<string[]>(cleanDraft(store.read("draft", null)));

/** The draft's one writer: the store and its stored copy move together. An empty box is removed. */
export function setDraft(text: string): void {
  draft.set([text]);
  if (text) store.write("draft", text);
  else store.remove("draft");
}

/**
 * The screenshot button's state: whether one is being taken, and the receipt line the view shows
 * (in the picture's column, so it is seen in fullscreen too, where the app's toast sits under the
 * desktop). `file` is what the receipt's open button opens.
 */
export interface ShotState {
  busy: boolean;
  line: string | null;
  file: { repoId: string; relPath: string; mtime: number } | null;
}
export const shot = createStore<ShotState>({ busy: false, line: null, file: null });
/** How long a receipt stays: long enough to read and tap open, then the line gives its room back. */
export const SHOT_LINE_MS = 15_000;
let shotTimer: ReturnType<typeof setTimeout> | null = null;

function shotLine(next: ShotState): void {
  if (shotTimer) { clearTimeout(shotTimer); shotTimer = null; }
  shot.set(next);
  if (!next.busy && next.line) shotTimer = setTimeout(() => { shotTimer = null; shot.set({ busy: false, line: null, file: null }); }, SHOT_LINE_MS);
}

/** Take the receipt down now (its ×). */
export function dropShotLine(): void { shotLine({ busy: false, line: null, file: null }); }

/**
 * A full-resolution screenshot of the whole desktop into the session repo's `.claude/outbox/`, through
 * the core's one capture route (the SDK's `desktopScreenshot`, `POST /api/host/screenshot`) — not the
 * picture on the canvas, which may be cropped, scaled and compressed. Watching is not control: the
 * control switch gates input, and this sends none. A second tap while one is running does nothing new
 * (the line already says it is taking one).
 */
export async function takeDesktopShot(): Promise<void> {
  if (shot.get().busy) return;
  const c = core();
  const repo = c.world.activeRepo;
  if (!repo) { shotLine({ busy: false, line: SHOT_NO_REPO, file: null }); return; }
  if (c.conn.status !== "open") { shotLine({ busy: false, line: SHOT_OFFLINE, file: null }); return; }
  c.say.track("action:desktop.shot");
  shotLine({ busy: true, line: SHOT_BUSY, file: null });
  const r = await desktopScreenshot(repo.id);
  shotLine({
    busy: false,
    line: shotReceipt(r, repo.repoName),
    file: "file" in r ? { repoId: repo.id, relPath: r.file.relPath, mtime: r.file.mtime } : null,
  });
}

/** The receipt's open: the viewer on that file, whose close comes back to the live view. */
export function openShot(): void {
  const f = shot.get().file;
  if (f) core().files.openFileFrom(f, DESKTOP_SHEET);
}
