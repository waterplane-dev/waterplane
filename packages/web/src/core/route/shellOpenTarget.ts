import { notifFromShell, type NotificationItem } from "@waterplane/shared";

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
export type ShellOpenTarget = { plugin: string } | { notif: NotificationItem } | { sessionId: string };

export function shellOpenTarget(s: string): ShellOpenTarget {
  const notif = notifFromShell(s);
  if (notif) return { notif };
  if (s.startsWith("plugin:") && s.length > "plugin:".length) return { plugin: s.slice("plugin:".length) };
  return { sessionId: s };
}
