/**
 * The code folder: reading what the host scans, checking and saving a folder, and asking once,
 * unprompted, when the folder was only guessed. The ask is a `welcome` handler: the phone is
 * connected exactly then, and a reconnect after a save is the same frame that ends the wait.
 */
import { rootNeedsAsking, type RootInfo, type RootPostReply } from "@waterplane/shared";
import { api } from "../../api";
import { isDemo } from "../../demoEntry";
import { core } from "../../sdk";
import { LS, lsJson, lsSetJson } from "../../storage";
import { afterSave, dismissKey, parseLater, samePath, shouldAskNow, withLater } from "./logic";
import { rootInfo, rootUi } from "./store";

/** How long a restarting sheet waits for the reconnect before it closes on its own. */
const RESTART_WAIT_MS = 6000;
let restartTimer: number | undefined;
/** The root whose welcome was already asked about this page load (`onWelcome`). */
let askedFor: string | null = null;

const said = (e: unknown) => String((e as Error)?.message || e);

/** Re-read `GET /api/host/root`. Returns the info, or null (and says why on the sheet) when the host did not answer. */
export async function loadRoot(): Promise<RootInfo | null> {
  try {
    const i = await api.rootInfo();
    rootInfo.set(i);
    const ui = rootUi.get();
    if (ui.phase === "idle" && ui.readError) rootUi.set({ phase: "idle", readError: null });
    return i;
  } catch (e) {
    const ui = rootUi.get();
    if (ui.phase === "idle") rootUi.set({ phase: "idle", readError: said(e) });
    return null;
  }
}

/** The one door: Settings' row and the first-start ask both open the sheet here. */
export function openCodeFolder(): void {
  const c = core();
  c.say.track("overlay:codefolder");
  if (rootUi.get().phase === "idle") rootUi.set({ phase: "idle", readError: null });
  c.nav.open("codefolder");
  void loadRoot();
}

/** The sheet stopped being on top (× , Back, Later, a finished save): this guess is not asked again unprompted. */
export function leaveCodeFolder(): void {
  window.clearTimeout(restartTimer);
  const i = rootInfo.get();
  if (i && rootNeedsAsking(i)) lsSetJson(LS.codeFolderLater, withLater(parseLater(lsJson<unknown>(LS.codeFolderLater, [])), dismissKey(i)));
  // A finished wait starts the next opening from a clean sheet.
  rootUi.set({ phase: "idle", readError: null });
}

/** Check only: how many repos a typed folder holds, or the host's sentence. */
export async function checkFolder(path: string): Promise<RootPostReply> {
  core().say.track("action:codefolder.check");
  try { return await api.checkRoot(path); }
  catch (e) { return { ok: false, error: `The desktop did not answer — ${said(e)}` }; }
}

/**
 * Save a folder (`save: true`). A refusal comes back to the sheet as its sentence; otherwise the
 * sheet moves to what the host said happens next. Never called by anything but a tap.
 */
export async function saveFolder(path: string): Promise<string | null> {
  const c = core();
  c.say.track("action:codefolder.save");
  let reply: RootPostReply;
  try { reply = await api.saveRoot(path); }
  catch (e) { return `The desktop did not answer — ${said(e)}`; }
  const after = afterSave(reply);
  if (after.kind === "refused") return after.text;
  if (after.kind === "closed") {
    await loadRoot();
    c.nav.close("codefolder");
    return null;
  }
  if (after.kind === "manual") {
    rootUi.set({ phase: "manual", text: after.text });
    void loadRoot();
    return null;
  }
  // "auto": the socket drops when the host restarts; the reconnect's welcome names the new root.
  const root = reply.ok ? reply.root : path;
  rootUi.set({ phase: "restarting", root, text: after.text });
  window.clearTimeout(restartTimer);
  restartTimer = window.setTimeout(() => finishRestart(), RESTART_WAIT_MS);
  return null;
}

function finishRestart(): void {
  if (rootUi.get().phase !== "restarting") return;
  window.clearTimeout(restartTimer);
  void loadRoot().finally(() => core().nav.close("codefolder"));
}

/**
 * Every `welcome`: end a restart wait that the new root answers, else ask once about a guessed
 * folder. The read is quiet and a failure is silence — this is a question nobody asked for, so it
 * never toasts.
 */
export function onWelcome(root: string): void {
  const ui = rootUi.get();
  if (ui.phase === "restarting" && samePath(ui.root, root)) { finishRestart(); return; }
  if (isDemo()) return;
  // Once per root per page load: the read scans the usual folders, and a phone on a flaky link
  // reconnects often. A new root (a hand restart after a save, another host) is asked about afresh.
  if (askedFor !== null && samePath(askedFor, root)) return;
  askedFor = root;
  void (async () => {
    const i = await loadRoot();
    if (!i) return;
    const later = parseLater(lsJson<unknown>(LS.codeFolderLater, []));
    if (shouldAskNow(i, later, { overlay: core().nav.overlay, demo: false })) openCodeFolder();
  })();
}
