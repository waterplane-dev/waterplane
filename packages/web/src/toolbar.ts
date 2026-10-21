/**
 * The terminal toolbar — the burger's MENU in the session header — : what its
 * line items ARE, and the per-device config that orders, hides and pins them.
 *
 * Lifted out of `App.tsx` — not for tidiness, but because this is a genuinely
 * separable slice with a small surface (a static catalog, one persisted config
 * shape, four pure readers over it) that App only ever consumed. It also has an
 * update boundary of its own: adding a button is an edit here, and used to
 * rewrite the file every other feature in the app lives in.
 *
 * The `id`s are PERSISTED in every device's saved order/hidden/pinned arrays,
 * so they are a compatibility surface: rename one and that device silently
 * loses its customisation. `loadToolbarCfg` drops unknown ids for the same
 * reason in reverse — a stale pin from an older build must not render an empty
 * slot in the header.
 */
import { BookKey, Bookmark, Brain, Camera, CircleDollarSign, ClipboardPaste, Copy, Cpu, FileDiff, Flag, FolderTree, GalleryVerticalEnd, Gauge, GitBranch, GitFork, Hammer, History, Hourglass, Images, List, ListChecks, ListTodo, MessageSquare, MessageSquareReply, Monitor, Paperclip, Puzzle, Radio, RotateCw, ScrollText, Search, Slash, SquareTerminal, Star, Waypoints, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { usageCount } from "./usage";
import { LS, lsGet, lsSetJson } from "./storage";

/** Customizable terminal-toolbar actions (order = display order). */
// Leading dynamic chips (new-outbox/untracked counts, the installed plugins'
// session controls). They render conditionally and carry their own onClick, but
// participate in the same reorder/hide config as the rest — default to the TOP.
// `oracle` and `propose` were the in-core oracle's; a device's saved order
// may still hold them, which is harmless: only catalogued ids are ever drawn.
export const DYNAMIC_TOOLBAR_IDS = ["inbox", "untracked", "plugins"];
/**
 * The three the READER used to draw itself, in a slot of its own inside the
 * session header (`.hdr-read`). They were a bar this config had no say over:
 * not orderable, not hideable, and sitting to the right of the strip the user
 * DOES control, so the one row a phone has was split between a configurable
 * half and a fixed one. They are ordinary catalog actions now — pinned out of
 * the box so the reader still opens with them in reach, and unpinnable like
 * everything else. `runToolbar` reads them in read mode as the reader's own
 * verbs (inline outline, find-in-conversation, refetch) and in the terminal as
 * what they always meant there (the outline SHEET, session search).
 */
export const READER_TOOLBAR_IDS = ["outline", "find", "refresh"];
/**
 * Pinned out of the box for the same reason `files` is: it was reachable ONLY
 * from the offline terminal overlay, i.e. the one state where the live screen
 * is gone anyway. With the link up there was no button at all — so the local
 * history had exactly one entry point, the upward pan, which is the gesture
 * that was broken. An escape hatch behind the thing it is an escape from.
 */
export const SCROLLBACK_TOOLBAR_ID = "scrollback";
/**
 * The repo file TREE (`FilesSheet`), pinned out of the box because it was
 * effectively unreachable: unpinned, it sat in the overflow of a toolbar that
 * is itself collapsed behind a burger by default on a phone — a sheet inside a
 * menu inside a closed menu. The launcher's `⋯` now offers it too; this is the
 * half that works while you are looking at a session.
 */
export const BROWSE_TOOLBAR_ID = "browse";
/**
 * The star, which used to be a fixed button of the session header — and one
 * that the (since removed) header collapse hid. A star means "come back to this", so the
 * layout you read a long turn in is exactly where you decide to mark it, and
 * that layout was the one with no star at all; the only other button is the
 * launcher row, i.e. leave the session to mark the session. It is an ordinary
 * catalog action now: pinned out of the box so it stays where it was, unpinnable
 * like everything else, and it renders its own STATE (filled when starred,
 * dotted while this phone's star is unconfirmed) rather than the generic icon.
 */
export const STAR_TOOLBAR_ID = "star";
/**
 * The follow-up flag (R-sessions-041), beside the star and for the star's
 * reason: the layout you read a long turn in is where you decide "come back to
 * this", and where you mark it read. Pinned out of the box right after the
 * star, and it renders its own state (filled, in the colour of who set it).
 */
export const FOLLOWUP_TOOLBAR_ID = "followup";
/** One line of the catalog — a core line below, or one an extension contributed (`MenuItemDef`). */
export interface ToolbarItem { id: string; name: string; Icon: LucideIcon | ComponentType<{ size?: number | string }> }
export const TOOLBAR_ITEMS: ToolbarItem[] = [
  // id stays "inbox" — it is persisted in every device's toolbar order/hidden
  // config; only what it counts (the outbox) and how it reads changed.
  { id: "inbox", name: "new files", Icon: Images },
  // id stays "untracked" — persisted in every device's toolbar order/hidden
  // config; only what it counts (every uncommitted change, not just the new
  // files) and how it reads changed.
  { id: "untracked", name: "changed files", Icon: FileDiff },
  // Every active plugin's per-session switches and actions (features/plugins).
  { id: "plugins", name: "plugins", Icon: Puzzle },
  { id: "limit", name: "auto-continue", Icon: Hourglass },
  { id: "model", name: "model", Icon: Brain },
  // Shell sessions only (ToolbarMenu draws it for nothing else): the logins cheat sheet.
  { id: "logins", name: "logins", Icon: BookKey },
  { id: "cmd", name: "cmd", Icon: Slash },
  { id: "image", name: "image", Icon: Camera },
  { id: "file", name: "attach file", Icon: Paperclip },
  // "files" opens the artifact GALLERY and "browse" the repo TREE — two
  // different sheets, and while both wore `Images` the only thing telling them
  // apart in a row of icons was their position. The id stays "files" (it is
  // persisted in every device's order/hidden/pinned arrays); only the label and
  // the icon move.
  { id: "files", name: "gallery", Icon: GalleryVerticalEnd },
  { id: "browse", name: "browse files", Icon: FolderTree },
  { id: "diff", name: "diff", Icon: GitBranch },
  { id: "build", name: "build", Icon: Hammer },
  { id: "ctx", name: "ctx", Icon: Gauge },
  { id: "usage", name: "usage", Icon: CircleDollarSign },
  { id: "cpu", name: "cpu", Icon: Cpu },
  { id: "shot", name: "shot", Icon: Monitor },
  { id: "clip", name: "to host clip", Icon: ClipboardPaste },
  { id: "select", name: "select", Icon: Copy },
  { id: "decide", name: "answer list", Icon: MessageSquareReply },
  { id: "teleport", name: "teleport", Icon: Waypoints },
  { id: "remote", name: "remote", Icon: Radio },
  { id: "tasks", name: "tasks", Icon: ListChecks },
  { id: "backlog", name: "backlog", Icon: ListTodo },
  { id: "history", name: "history", Icon: History },
  { id: "outline", name: "outline", Icon: List },
  { id: "sent", name: "sent", Icon: MessageSquare },
  { id: "find", name: "find", Icon: Search },
  { id: "refresh", name: "refresh reader", Icon: RotateCw },
  { id: "scrollback", name: "scrollback", Icon: ScrollText },
  { id: "fork", name: "fork", Icon: GitFork },
  // A temporary shell in this session's folder, closed WITH the session (host
  // `companionOf`). Not drawn on a shell session, nor where the host has no shell.
  { id: "companion", name: "companion shell", Icon: SquareTerminal },
  { id: "star", name: "star", Icon: Star },
  { id: "followup", name: "flag for follow up", Icon: Flag },
  // A bookmark on the CONVERSATION (R-conversations-007): the way back to it in
  // the archive after it is closed. In the menu, not pinned out of the box —
  // the header is full; pinning it is the person's call. Drawn by
  // `core/sessions/bookmark.tsx` (its own state, its note).
  { id: "bookmark", name: "bookmark", Icon: Bookmark },
];

let contributed: () => readonly ToolbarItem[] = () => [];
/**
 * The extensions' ☰ lines (`MenuItemDef`), bound by `core/extensionPoints.ts`. A binding and not an
 * import: the registry's own features import this module, so importing the registry here is a cycle.
 * Their ids are `<manifest id>:<id>` — a colon no core id has, so the two can never collide.
 */
export function bindMenuCatalog(source: () => readonly ToolbarItem[]): void {
  contributed = source;
}
/** The whole catalog: the core lines, then every contributed one. */
export const toolbarItems = (): ToolbarItem[] => [...TOOLBAR_ITEMS, ...contributed()];
/** A contributed line's id: kept through `loadToolbarCfg` even when the binding is not made yet (the
 *  config store loads at import), and simply drawn as nothing if that extension is gone. */
const isContributedId = (id: string) => id.includes(":");

export interface ToolbarCfg {
  /**
   * @deprecated Dead since the toolbar became the burger's vertical MENU: a
   * column of bare glyphs is a column of riddles, so menu lines always carry
   * their label (`renderToolbarItem`). Kept on the type because it is in every
   * device's persisted config and this object is spread over the stored JSON —
   * dropping the field would not delete it from storage, only hide it from the
   * type that describes what is there. Nothing reads it.
   */
  iconsOnly?: boolean; hidden: string[]; order: string[]; sort?: "manual" | "used";
  /**
   * Toolbar actions ALSO pinned into the session header (order = this array).
   * The header is the only bar that survives reader view (and, once,
   * the header collapse), so a collapsed session used to lose every action — `files` above all, which
   * is how you get at what the agent just produced. A pin is independent of
   * `hidden`: pinning an action to the header is a fine reason to drop it from
   * the terminal toolbar, so a pinned item renders in the header even when it
   * is hidden below.
   */
  pinned?: string[];
  /**
   * Set once the reader's three controls have been folded into `pinned` (see
   * READER_TOOLBAR_IDS). It lives INSIDE the config rather than in a key of its
   * own because this config SYNCS: a marker that travelled separately would let
   * the migration re-run on a second device and re-pin what was unpinned here.
   */
  readerPins?: 1;
  /** Set once `scrollback` has been folded into `pinned` (see
   *  SCROLLBACK_TOOLBAR_ID). Inside the config for `readerPins`' reason: this
   *  config syncs, and a marker travelling separately would re-pin on a second
   *  device what was unpinned here. */
  scrollbackPin?: 1;
  /** Set once `browse` has been folded into `pinned` (see BROWSE_TOOLBAR_ID).
   *  Same placement argument as the two above. */
  browsePin?: 1;
  /** Set once `star` has been folded into `pinned` (see STAR_TOOLBAR_ID). Same
   *  placement argument again — and here the fold is what keeps the button a
   *  device already had, so it must not re-run and undo an unpin. */
  starPin?: 1;
  /** Set once `followup` has been folded into `pinned` (FOLLOWUP_TOOLBAR_ID) —
   *  `starPin`'s reason, so an unpin sticks. */
  followupPin?: 1;
}
/**
 * TOOLBAR_ITEMS in display order. "manual" = cfg.order (unlisted items keep
 * their default position at the end). "used" = `usedOrder`, the most-used-first
 * ranking the caller snapshots (see usedToolbarRank) — snapshotted rather than
 * live so buttons don't reshuffle under the finger mid-tap.
 */
export function orderedToolbarItems(cfg: ToolbarCfg, usedOrder?: string[]) {
  const keys = cfg.sort === "used" && usedOrder?.length ? usedOrder : cfg.order;
  const rank = (id: string) => { const i = keys.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  return toolbarItems().map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i).map((x) => x.t);
}
/** The toolbar actions pinned into the session header, in the pinned order. */
export function pinnedToolbarItems(cfg: ToolbarCfg) {
  const byId = new Map(toolbarItems().map((t) => [t.id, t]));
  return (cfg.pinned ?? []).map((id) => byId.get(id)).filter((t): t is ToolbarItem => !!t);
}
/** Toolbar ids, most-used first; never-used items fall back to the manual order. */
export function usedToolbarRank(cfg: ToolbarCfg): string[] {
  const manual = orderedToolbarItems({ ...cfg, sort: "manual" }).map((t) => t.id);
  return manual
    .map((id, i) => ({ id, i, n: usageCount(`toolbar:${id}`) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.id);
}
export function loadToolbarCfg(): ToolbarCfg {
  try {
    // `files` is pinned out of the box: a collapsed header is exactly when you
    // want at the artifacts the agent just produced, and it is the one action
    // there is no other way to reach from that layout.
    const cfg = { iconsOnly: false, hidden: [], order: [], sort: "manual", pinned: ["files", BROWSE_TOOLBAR_ID, ...READER_TOOLBAR_IDS, SCROLLBACK_TOOLBAR_ID, STAR_TOOLBAR_ID, FOLLOWUP_TOOLBAR_ID], ...JSON.parse(lsGet(LS.toolbar) || "{}") } as ToolbarCfg;
    // Drop ids from an older build that no longer exist, so a stale pin can't
    // render an empty slot in the header.
    const known = new Set(TOOLBAR_ITEMS.map((t) => t.id));
    cfg.pinned = (Array.isArray(cfg.pinned) ? cfg.pinned : []).filter((id) => known.has(id) || isContributedId(id));
    // Migrate older saved orders: the dynamic chips used to be pinned right.
    // Prepend any that aren't in the saved order so they default to the LEFT.
    if (cfg.order.length) {
      const missing = DYNAMIC_TOOLBAR_IDS.filter((id) => !cfg.order.includes(id));
      if (missing.length) cfg.order = [...missing, ...cfg.order];
    }
    // A device that saved a config before the reader's controls were catalog
    // actions has a `pinned` array of its own, so the default above never
    // reaches it — and the buttons would simply be gone. Fold them in ONCE, and
    // record that in the config itself so unpinning one sticks.
    if (cfg.readerPins !== 1) {
      const missing = READER_TOOLBAR_IDS.filter((id) => !cfg.pinned!.includes(id));
      cfg.pinned = [...cfg.pinned!, ...missing];
      cfg.readerPins = 1;
      lsSetJson(LS.toolbar, cfg);
    }
    // Same one-time fold, same reason: a device with a saved config never sees
    // the default below.
    if (cfg.scrollbackPin !== 1) {
      if (!cfg.pinned!.includes(SCROLLBACK_TOOLBAR_ID)) cfg.pinned = [...cfg.pinned!, SCROLLBACK_TOOLBAR_ID];
      cfg.scrollbackPin = 1;
      lsSetJson(LS.toolbar, cfg);
    }
    // And again for `browse`, which every existing device has a saved config
    // predating.
    if (cfg.browsePin !== 1) {
      if (!cfg.pinned!.includes(BROWSE_TOOLBAR_ID)) cfg.pinned = [...cfg.pinned!, BROWSE_TOOLBAR_ID];
      cfg.browsePin = 1;
      lsSetJson(LS.toolbar, cfg);
    }
    // And again for `star`, which every device has a saved config predating —
    // and unpinned it would simply be gone from the header it has always been in.
    if (cfg.starPin !== 1) {
      if (!cfg.pinned!.includes(STAR_TOOLBAR_ID)) cfg.pinned = [...cfg.pinned!, STAR_TOOLBAR_ID];
      cfg.starPin = 1;
      lsSetJson(LS.toolbar, cfg);
    }
    // And for the follow-up flag, placed right after the star wherever the
    // star is pinned (the two are one pair of marks).
    if (cfg.followupPin !== 1) {
      if (!cfg.pinned!.includes(FOLLOWUP_TOOLBAR_ID)) {
        const at = cfg.pinned!.indexOf(STAR_TOOLBAR_ID);
        cfg.pinned = at === -1 ? [...cfg.pinned!, FOLLOWUP_TOOLBAR_ID]
          : [...cfg.pinned!.slice(0, at + 1), FOLLOWUP_TOOLBAR_ID, ...cfg.pinned!.slice(at + 1)];
      }
      cfg.followupPin = 1;
      lsSetJson(LS.toolbar, cfg);
    }
    return cfg;
  } catch { return { iconsOnly: false, hidden: [], order: [], sort: "manual", pinned: ["files", BROWSE_TOOLBAR_ID, ...READER_TOOLBAR_IDS, SCROLLBACK_TOOLBAR_ID, STAR_TOOLBAR_ID, FOLLOWUP_TOOLBAR_ID], readerPins: 1, scrollbackPin: 1, browsePin: 1, starPin: 1, followupPin: 1 }; }
}
