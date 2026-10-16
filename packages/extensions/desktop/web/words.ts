/**
 * Every sentence the live desktop says about itself being unable to do something — pure, so
 * `words.test.mjs` pins the wording and no screen invents its own.
 */
import { BRAND } from "@waterplane/shared";
import { CONTROL_SETTING_PATH, CONTROL_SWITCH, type ControlNeed, type DesktopMethods, type DesktopSource, type DesktopStatus } from "../shared/wire.mts";

export type ProbeResult = DesktopMethods["probe"]["result"];

/** What the last `probe` said. `unknown` until one answered (and while offline). */
export type ProbeState =
  | { k: "unknown" }
  | { k: "ok"; r: ProbeResult; at: number }
  | { k: "failed"; error: string; at: number };

export const NOT_SERVING = "The desktop isn't serving a live view — update the host";
export const GRANT_SCREEN = "Grant Screen Recording to wp-desktop in System Settings → Privacy & Security on the desktop";
export const GRANT_ACCESS = "Clicks and keys need Accessibility for wp-desktop in System Settings → Privacy & Security on the desktop";

/** `true`, or the sentence why the Desktop view cannot open. Unknown ⇒ available: the view itself
 *  says what the host answers once it does. */
export function availability(p: ProbeState): true | string {
  if (p.k === "unknown") return true;
  if (p.k === "failed") return NOT_SERVING;
  const r = p.r;
  if (!r.available) return r.reason?.trim() || "Live desktop needs a Mac, or a Windows desktop with the host in WSL, for now";
  if (r.screenRecording === false) return GRANT_SCREEN;
  return true;
}

/**
 * What a tap on the header segment or the ☰ line does: `true` opens the view, a sentence
 * is shown instead. A missing Screen Recording grant OPENS the view, because the view carries the
 * button that asks macOS for it — a sentence alone left the person to find the pane by hand.
 */
export function entryAvailability(p: ProbeState): true | string {
  const a = availability(p);
  return a === GRANT_SCREEN ? true : a;
}

/** No WebCodecs (or no H.264 in it): the view streams stills and says why. */
export function noVideoSentence(secure: boolean): string {
  return secure
    ? "This phone's browser can't decode H.264 video — showing stills."
    : `This connection can't decode video (not a secure context) — showing stills. Open ${BRAND.displayName} over https to get video.`;
}

/** Why a click or key goes nowhere right now, or null when it reaches the desktop. */
export function controlBlock(mode: "touch" | "trackpad" | "view", status: DesktopStatus | null): string | null {
  if (mode === "view") return "View only — nothing you do here reaches the desktop. Pick Touch or Trackpad to control it.";
  if (status && !status.control.on) {
    // The host's sentence, verbatim: it already opens "Control is off:" (knobs.mts CONTROL_OFF) or names
    // what is missing ("Accessibility is not granted…"). The phone adds only what the phone does.
    const why = status.control.reason?.trim() || `Control is off: turn on "${CONTROL_SWITCH}" in ${CONTROL_SETTING_PATH}.`;
    return `${why} Zoom and pan still work; nothing is sent.`;
  }
  return null;
}

/** One gate between a tap and the desktop, in words, with the label of the button that fixes it. */
export interface ControlStep { need: ControlNeed; text: string; button: string }

/** The labels on the view's fix buttons. Named here so the steps say them as drawn. */
export const TURN_ON = "turn on control";
export const ASK_ACCESS = "ask macOS for Accessibility";

/**
 * The gates the host says are closed, each its own sentence and button — so a view missing both
 * says "two things" and the person can see which one a dialog on the Mac did not fix. Empty when
 * control is on, in View only, or when the host did not name them (an older host: `controlBlock`'s
 * sentence still says it).
 */
export function controlSteps(mode: "touch" | "trackpad" | "view", status: DesktopStatus | null): ControlStep[] {
  if (mode === "view" || !status || status.control.on) return [];
  const needs = status.control.needs ?? [];
  const out: ControlStep[] = [];
  if (needs.includes("setting")) {
    out.push({ need: "setting", button: TURN_ON, text: `Control is switched off here ("${CONTROL_SWITCH}"). Tap ${TURN_ON} — clicks and keys from this phone then reach every app on the desktop.` });
  }
  if (needs.includes("accessibility")) {
    out.push({ need: "accessibility", button: ASK_ACCESS, text:
      "macOS has not given wp-desktop Accessibility, so it drops every click and key. On the Mac, System Settings → Privacy & Security → Accessibility: turn on wp-desktop. " +
      "macOS's dialog only opens that pane — its \"Open System Settings\" grants nothing until the switch is on. " +
      "This phone cannot flip it: until it is on, nothing from here clicks, so this step needs the Mac itself (or another remote-control app)." });
  }
  return out;
}

/** The headline over the steps: how many gates are closed, and that the picture is still live. */
export function stepsHead(n: number): string {
  return `${n === 1 ? "One thing stops" : `${n} things stop`} your taps reaching the desktop. Zoom and pan still work; nothing is sent.`;
}

/** The button that reopens a view another screen took (`replaced`). Named here so the line says it as drawn. */
export const TAKE_BACK = "take it back";
/** Another screen opened the live view, so this one ended. Never reopened by itself — two phones
 *  would take it from each other for ever — only by the person's tap. */
export const REPLACED_LINE = `Opened on another screen — tap ${TAKE_BACK} to show it here again (the other screen's view then ends).`;

/** The receipt for typed words. It claims what the phone KNOWS — the events left on the socket —
 *  never that the desktop typed them: macOS secure input (a password field) swallows keys, and
 *  nothing here can see that. */
export function sentReceipt(thenReturn: boolean): string {
  return thenReturn ? "Sent to the desktop, then Return." : "Sent to the desktop.";
}

/** A send the link cut short: how much of it went out (never "reached"), or that none did. */
export function partialSendLine(sent: number, total: number): string {
  return sent ? `Only part of it was sent to the desktop (${sent} of ${total}) — the link dropped.` : "Not sent — the link dropped.";
}

/** Whether the view may reopen by itself after ending this way (the page coming back into view):
 *  not after `replaced`, which only the person's tap on `TAKE_BACK` undoes — the line says so. */
export function reopensBySelf(cause: string | undefined): boolean {
  return cause !== "replaced";
}

/** The view's line while the stream is not showing pictures. */
export function streamLine(
  state: "opening" | "open" | "ended" | "refused" | "paused", reason: string | undefined, linkOpen: boolean, cause?: string,
): string | null {
  if (state === "opening") return linkOpen ? "Asking the desktop for its screen…" : "No connection — the view opens when the link is back.";
  if (state === "ended" && cause === "replaced") return REPLACED_LINE;
  if (state === "ended") return `The live view ended: ${reason || "the desktop stopped it"}.`;
  if (state === "refused") return `The desktop did not open a live view: ${reason || "no reason given"}.`;
  return null;
}

// ── the screenshot button ───────────────────────────────────────────────────

/** The camera button's word, as drawn in fullscreen (and its long-press title everywhere). */
export const SHOT = "screenshot";
export const SHOT_TITLE = "screenshot — the whole desktop at full resolution, saved into this session's repo's .claude/outbox/ (the gallery)";
/** A tap with no repo on screen: where it WOULD go, and how to give it one. */
export const SHOT_NO_REPO = "No screenshot: there is no repo to put it in — open the desktop from a session; it goes into that repo's .claude/outbox/.";
export const SHOT_OFFLINE = "No screenshot: no connection to the desktop.";
export const SHOT_BUSY = "Taking a screenshot of the desktop…";

/** The receipt: the file by its FULL path (repo, then `.claude/outbox/…`), or the desktop's reason. */
export function shotReceipt(r: { file: { relPath: string } } | { error: string }, repoName: string): string {
  if ("file" in r) return `Screenshot saved to ${repoName}/${r.file.relPath} — full resolution, in the gallery.`;
  const why = r.error.trim().replace(/\.$/, "") || "no reason given";
  return `No screenshot: ${why}.`;
}

/** The host's capture-error line. The helper's reason is already a sentence with its own full stop —
 *  adding one more printed "on the Mac..". */
export function captureStopped(reason: string | undefined): string {
  const r = (reason ?? "").trim().replace(/[.\s]+$/, "");
  return `The desktop's capture stopped: ${r || "no reason given"}.`;
}

export const USE_MAIN = "use the main display";

/**
 * The display the person picked is not among the desktop's displays any more — a sentence, else
 * null. macOS renumbers displays when a monitor is plugged back in or the Mac restarts, so a saved
 * pick goes stale and every retry asks for the gone one again. Null when the probe has not listed
 * displays: unknown is not "gone".
 */
export function goneDisplay(source: DesktopSource, p: ProbeState): string | null {
  if (source.kind !== "display" || source.id === undefined || p.k !== "ok") return null;
  const ds = p.r.displays;
  if (ds.length === 0 || ds.some((d) => d.id === source.id)) return null;
  return `The display picked earlier is not on the desktop any more — macOS renumbers displays when a monitor reconnects or the Mac restarts. It has ${ds.length === 1 ? "one display" : `${ds.length} displays`} now.`;
}
