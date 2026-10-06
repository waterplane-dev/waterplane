import { transcriptText } from "@waterplane/shared";
import { core } from "../../sdk";
import { getTranscript } from "../../offlineCache";
import { openExternal } from "../../openExternal";
import { emptyDumpText, quoteBlock } from "./logic";
import { clipSeed, decide, dump } from "./store";

/**
 * Open the Terminal-text sheet.
 *
 * The grid is read BEFORE the sheet opens, for the same reason App's
 * `openScrollback` does: rendering the sheet unmounts `TerminalView`.
 *
 * The grid is also the WRONG source in reader view, where the xterm is already
 * unmounted and `getText()` returns "" — the sheet opened empty and looked
 * broken. That is what you hit with the link down too, since offline is
 * precisely when you are reading the cached transcript instead of a live grid.
 * So fall back to the reader's own document, which is served from the
 * IndexedDB offline cache and needs no host.
 */
export async function openTextDump(): Promise<void> {
  const c = core();
  const grid = c.compose.gridText();
  if (grid.trim()) { dump.set({ text: grid, source: "grid" }); c.nav.open("text"); return; }
  dump.set({ text: "", source: "transcript" });
  c.nav.open("text");
  const active = c.world.active;
  const doc = active ? await getTranscript(active.id) : null;
  const text = doc ? transcriptText(doc) : "";
  dump.set({ text: text || emptyDumpText(!!active), source: "transcript" });
}

/** Open the "to host clip" sheet, staged with whatever the compose bar holds.
 *  The three sources of text a phone actually has — the compose draft, the
 *  phone's own clipboard, and something typed on the spot — are all one edit
 *  box there. Reading compose ALONE dead-ended on an empty draft, which is the
 *  case where you most want to paste. Non-destructive: the compose draft is
 *  left intact (distinct from "send"). */
export function openClipSheet(): void {
  const c = core();
  c.say.track("action:clip.open");
  clipSeed.set(c.compose.draft);
  c.nav.open("clip");
}

/**
 * Hand a link the CLI printed to the phone's browser — the sign-in bar's
 * primary action, and the Terminal-text sheet's link rows.
 *
 * `openExternal` is the shell-aware half (the APK cannot use `window.open`).
 * The toast is the other half: a tap that produces nothing visible is
 * indistinguishable from a dead button, and a blocked popup is exactly that.
 */
export function openLink(url: string): void {
  const c = core();
  c.say.track("action:link.open");
  if (openExternal(url)) c.say.toast("opening in your browser…");
  else c.say.toast("your browser blocked that — copy the link and paste it into a tab");
}

/** Copy a link out. The fallback when the browser hand-off does not happen,
 *  and the only path that works with no browser hand-off at all. */
export async function copyLink(url: string): Promise<void> {
  const c = core();
  c.say.track("action:link.copy");
  try { await navigator.clipboard.writeText(url); c.say.toast("link copied"); }
  catch { c.say.toast("clipboard unavailable (needs https) — show the url and select it"); }
}

/** Copy a one-time / device code the shell printed. Resolves false when the
 *  clipboard refused (it needs a secure context) — the toast says why and
 *  carries the code, and the caller shows it large to type by hand. */
export async function copyCode(code: string): Promise<boolean> {
  const c = core();
  c.say.track("action:link.code");
  try { await navigator.clipboard.writeText(code); c.say.toast(`code ${code} copied`); return true; }
  catch { c.say.toast(`clipboard needs https — type the code by hand: ${code}`); return false; }
}

/** How much of a cached conversation the decisions sheet reads when no grid is
 *  mounted — the end of it, roughly a screen or two: the questions being
 *  answered are the newest ones. */
const TRANSCRIPT_TAIL = 80;

/**
 * Open the decisions sheet on `picked` rows, else on the live screen, else on
 * the tail of the cached conversation (reader view, or the link down). The
 * grid is read BEFORE the sheet opens, which unmounts the terminal.
 */
export async function openDecisions(picked?: readonly string[]): Promise<void> {
  const c = core();
  c.say.track("action:decide.open");
  if (picked?.length) { decide.set({ lines: [...picked], from: "picked" }); c.nav.open("answers"); return; }
  const grid = c.compose.gridText();
  if (grid.trim()) { decide.set({ lines: grid.split("\n"), from: "screen" }); c.nav.open("answers"); return; }
  decide.set({ lines: [], from: "transcript" });
  c.nav.open("answers");
  const active = c.world.active;
  const doc = active ? await getTranscript(active.id) : null;
  decide.set({ lines: doc ? transcriptText(doc).split("\n").slice(-TRANSCRIPT_TAIL) : [], from: "transcript" });
}

/** "quote" off the terminal's picked rows — the Terminal-text sheet's quote,
 *  INSERTED into the draft, never over it. */
export function quoteIntoCompose(text: string): boolean {
  const block = quoteBlock(text);
  if (!block) return false;
  core().compose.insert(block);
  return true;
}
