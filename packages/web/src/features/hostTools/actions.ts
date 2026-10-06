/**
 * The host tools: a peek at the desktop's load, a desktop screenshot into the
 * annotator, the sign-in code paste, and the two switches for how this phone
 * gets alerts (Web Push, the APK's background link).
 */
import { useEffect } from "react";
import { openSettingsAt } from "../../settingsFocus";
import { api } from "../../api";
import { disablePush, enablePush, pushStatus } from "../../push";
import { disableShellLink, enableShellLink, shellLinkStatus, shellLinkSupported } from "../../shellLink";
import { core } from "../../sdk";
import { push, shellLink } from "./store";
import { hostStatText, loginCodeProblem } from "./logic";

/** Peek at the desktop host's CPU/memory load — surfaced as a toast. */
export async function showHostStat(): Promise<void> {
  try {
    core().say.toast(hostStatText(await api.hostStat()));
  } catch {
    core().say.toast("host stat failed");
  }
}

/** Grab a screenshot of the desktop and open it in the annotator. */
export async function takeShot(repoId: string): Promise<void> {
  const say = core().say;
  say.toast("capturing screen…");
  try {
    const r = await api.screenshot(repoId);
    if (!r.file) { say.toast(`screenshot failed: ${r.error ?? "?"}`); return; }
    core().files.annotateUrl(api.artifactUrl(repoId, r.file.relPath), r.file.name, repoId);
  } catch {
    say.toast("screenshot failed");
  }
}

/**
 * Put the code the sign-in page handed back into the CLI's own input.
 *
 * Deliberately the RAW, undurable path — not the compose bar's verified one.
 * `deliverPrompt` proves a delivery by watching for a turn to start, and this
 * text starts no turn: it goes into the CLI's login field, not the composer, so
 * the verified path would conclude the Return was swallowed and press it up to
 * five more times into whatever the flow moved on to. A login code is also
 * short-lived, which makes queueing it for a later flush meaningless — if the
 * link is down there is nothing worth saving.
 *
 * Text and Return are two writes with a gap, per the raw-input rule: sent as
 * one chunk the TUI reads them as a paste and the Return becomes a literal.
 */
export async function pasteLoginCode(id: string): Promise<void> {
  const c = core();
  c.say.track("action:login.code");
  if (!window.isSecureContext || !navigator.clipboard?.readText) {
    c.say.toast("clipboard read needs https — type the code into the compose bar instead");
    return;
  }
  let code = "";
  try { code = (await navigator.clipboard.readText()).trim(); }
  catch { c.say.toast("phone clipboard unavailable — type the code into the compose bar instead"); return; }
  const problem = loginCodeProblem(code);
  if (problem) { c.say.toast(problem); return; }
  if (!c.conn.liveSend({ t: "session.input", id, data: code }, `typed ${code.length} chars into the sign-in input`)) return;
  // eslint-disable-next-line local/no-silent-send -- the Return half of the code liveSend just receipted
  window.setTimeout(() => core().conn.send({ t: "session.input", id, data: "\r" }), 120);
}

/** Web Push on or off — or, where this document cannot have it, where to look. */
export async function togglePush(): Promise<void> {
  const c = core();
  const p = push.get();
  if (p === "native") { openSettingsAt("notif-shell-link"); c.say.toast("This app gets alerts through the background link"); return; }
  if (p === "insecure") { openSettingsAt("notif-push"); c.say.toast("OS notifications need HTTPS"); return; }
  if (p === "unsupported") { c.say.toast("This browser has no Web Push support"); return; }
  if (p === "on") { await disablePush(); push.set("off"); c.say.toast("Notifications off"); }
  else { const ok = await enablePush(); push.set(ok ? "on" : "denied"); c.say.toast(ok ? "Notifications on" : "Permission denied"); }
}

/** Re-read the background link's status (after the battery-exemption ask, say). */
export async function refreshShellLink(): Promise<void> {
  shellLink.set(await shellLinkStatus());
}

/**
 * Switch the APK's background link on or off.
 *
 * A refused notification permission is deliberately NOT a failure: the service
 * still runs, the process still stays out of Android's cached-app freezer and
 * the send queue still drains — there is simply nowhere for the alerts to
 * appear. Say that, rather than refusing to enable the link over it.
 * `enableShellLink` returns the status the service reports immediately after
 * being asked to start, so `running` is normally still catching up; the poll
 * (`useShellLinkPoll`) is what settles the label.
 */
export async function toggleShellLink(): Promise<void> {
  const say = core().say;
  if (shellLink.get()?.enabled) {
    await disableShellLink();
    shellLink.set(await shellLinkStatus());
    say.toast("Background link off — the app only holds the connection while it is open");
    return;
  }
  const st = await enableShellLink();
  shellLink.set(st ?? await shellLinkStatus());
  if (!st) { say.toast("No paired host yet — set one under Paired host first"); return; }
  say.toast(st.notifications
    ? "Background link on"
    : "Background link on — notifications are blocked, so it will drain the queue silently");
}

/**
 * What the background link is doing. Polled rather than pushed because
 * `enableShellLink` resolves the moment the service is asked to start, and "is
 * it connected?" is answered a second or two later — so the switch would
 * otherwise report `starting` for ever. Read once whenever `on` changes, and
 * polled every 3 s only while it is true. Called by `HostNotifySettings` with
 * `true`, so it runs exactly while the Settings rows are mounted: nothing else
 * in the app shows this, and a timer crossing the Capacitor bridge every few
 * seconds on the terminal screen is pure cost.
 */
export function useShellLinkPoll(on: boolean): void {
  useEffect(() => {
    if (!shellLinkSupported()) return;
    let alive = true;
    const read = async () => { const s = await shellLinkStatus(); if (alive) shellLink.set(s); };
    void read();
    if (!on) return () => { alive = false; };
    const t = window.setInterval(read, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [on]);
}

/** The first reading, once: whether this document has Web Push. (The link's
 *  first reading is `useShellLinkPoll`'s, when the Settings rows mount — the
 *  only place it is drawn or toggled.) */
export function bootHostTools(): () => void {
  let alive = true;
  void pushStatus().then((p) => { if (alive) push.set(p); });
  return () => { alive = false; };
}
