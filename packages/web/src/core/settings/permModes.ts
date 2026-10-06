/**
 * The no-approval permission modes, and what arming one says first. Read by
 * the Settings `permission` row (which confirms before arming one) and the
 * launcher's warning chip — one list, so the two cannot disagree about which
 * modes are risky.
 */
import type { PermissionMode } from "@waterplane/shared";

/**
 * Modes that remove the approval step entirely — every tool call runs unasked,
 * including `rm -rf`, a force-push, or anything the agent reads off the web. On
 * a phone you are often not watching the session, so picking one of these by
 * accident from a dropdown is the sharpest footgun in the app: it must be a
 * deliberate act, not a scroll — the Settings row asks first (`askConfirm`).
 */
export const RISKY_PERM_MODES = new Set<PermissionMode>(["dontAsk", "bypassPermissions"]);
/** One clause per line — `askConfirm` renders them as a list, which is what a
 *  list of consequences is. As one `\n\n`-joined blob (what `window.confirm`
 *  took) the middle sentence was the one people skipped. */
export const RISKY_PERM_WARNING = [
  "The agent will edit files, run shell commands, and push — with no approval prompt and no chance to say no.",
  "Use it only in a repo whose contents you could afford to lose.",
  "Sessions you start from any of your clients will use this until you change it back.",
];
