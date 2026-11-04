import { NOTIFICATIONS_SHELL_VIEW, isHostId, notifFromShell, type NotificationItem } from "@waterplane/shared";

/**
 * What the Android shell's `shellOpen(string)` asked for: a session id, a plugin's screen, or a
 * whole alert (`notif:<json>`, for one with neither — `openNotif` decides where it lands).
 *
 * The shell hands one string. A plugin's alert (a vault fingerprint ask) has no session, so
 * `ShellLinkService` sends `"plugin:<id>"` instead. Session ids are minted by the host as
 * `randomUUID().slice(0, 8)` (hex) and a plugin id is a folder name, so neither can contain ':' and
 * the prefix cannot collide with a session. (The `pending:<createAck>` ids are phone-side only and
 * never reach a notification.) An old bundle just finds no session by that string - harmless.
 */
export type ShellOpenTarget = { plugin: string } | { notif: NotificationItem } | { view: "notifications" } | { sessionId: string };

/** The notification list as a target: where a multi-item summary of another desktop lands (the
 *  ':' keeps it from ever being a session id). */
export const NOTIFICATIONS_VIEW = NOTIFICATIONS_SHELL_VIEW;

export function shellOpenTarget(s: string): ShellOpenTarget {
  const notif = notifFromShell(s);
  if (notif) return { notif };
  if (s === NOTIFICATIONS_VIEW) return { view: "notifications" };
  if (s.startsWith("plugin:") && s.length > "plugin:".length) return { plugin: s.slice("plugin:".length) };
  return { sessionId: s };
}

/**
 * An alert the background link posted for ONE of several desktops: `host:<hostId>|<rest>`, where
 * `rest` is one of the strings above — or empty, for a summary with no single item to land on
 * (the tap then only switches). The link watches every saved desktop, so the tap must say whose
 * alert it was: a session id or `plugin:vault` means nothing on the wrong desktop.
 *
 * Null for anything else, so the caller reads the string as {@link shellOpenTarget} does. Never
 * nested (`rest` naming a host again is not a target), and the id must be a host id.
 */
export interface ShellHostOpen { hostId: string; rest: string }

export function shellHostOpen(s: string): ShellHostOpen | null {
  if (!s.startsWith("host:")) return null;
  const bar = s.indexOf("|");
  if (bar < 0) return null;
  const hostId = s.slice("host:".length, bar);
  const rest = s.slice(bar + 1);
  if (!isHostId(hostId) || rest.startsWith("host:")) return null;
  return { hostId, rest };
}
