/** Kept out of `hooks.ts`: `hosts.ts` is the core's; a feature or extension reaches it only through this read. */
import { activeHost } from "../hosts.ts";

/**
 * The name this phone gave the desktop it is driving now (`SavedHost.name`, as the launcher shows it), or null
 * when none is saved (a browser on the desktop itself, a blank name). A live read, not a subscription: switching
 * desktops reloads the screens that name it. Null ⇒ say "the desktop", never a guessed name.
 */
export function activeHostName(): string | null {
  const name = activeHost()?.name?.trim();
  return name ? name : null;
}
