/**
 * The terminal toolbar's items and the burger's MENU they make up.
 *
 * Lifted out of App's session screen unchanged. What a tap on a generic item
 * DOES is still App's (`runToolbar`, the command switch, handed in): it reads
 * the reader, the search sheet and the socket, and a feature's own command
 * falls through it to `runFeatureCommand`. What is here is how an item is
 * DRAWN — the stateful ones (untracked, star), a feature's own
 * (`featureToolbarItem` — `plugins` is one), and the generic labelled button.
 */
import { Fragment, type ReactNode } from "react";
import { FileDiff, RotateCw, Settings, Smartphone, Star, type LucideIcon } from "lucide-react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import type { Overlay } from "../../routing";
import type { PendingStars } from "../../localState";
import { HINTS } from "../../hints";
import { shortModel } from "../../sessionFacts";
import { isShellBackend, type BackendList } from "../../backendCaps";
import { orderedToolbarItems, type ToolbarCfg } from "../../toolbar";
import { Unavailable } from "../../Unavailable";
import { featureToolbarItem } from "../toolbarItems";
import { tallyTitle, turnTally } from "../sessions/tags";
import { closeToolbarMenu } from "../../features/toolbarCfg";
import type { Connection } from "../conn/useConnection";

const ICON = 16;

/** What drawing one item needs from the screen around it. */
export interface ToolbarCtx {
  active: SessionInfo;
  pending: boolean;
  status: Connection["status"];
  activeRepo: RepoTarget | null;
  toolbarCfg: ToolbarCfg;
  pendingStars: PendingStars;
  toggleStar(id: string, starred: boolean): void;
  setOverlay(o: Overlay): void;
  /** App's command switch (`runToolbar`). */
  runToolbar(id: string): void;
  /** The host's backends: a shell is a backend of kind `shell`, whatever its id. */
  backends: BackendList;
}

/**
 * Render one terminal-toolbar item, honoring hide + icons-only config. The
 * leading dynamic chips (inbox/untracked/plugins) render conditionally
 * with their own click behavior; everything else is a generic runToolbar button.
 * Returns null when the item is hidden or not applicable right now.
 */
export function renderToolbarItem(c: ToolbarCtx, t: { id: string; name: string; Icon: LucideIcon }, compact = false): ReactNode {
  const { active, pending, status, activeRepo, toolbarCfg, pendingStars, toggleStar, setOverlay, runToolbar, backends } = c;
  // `compact` = rendered in the session header as a PIN: always icon-only (the
  // row shares one line with the title), and NOT subject to `hidden` — hiding
  // an action from the menu is a normal thing to do once it is pinned above.
  // Otherwise this is a line of the burger's menu, where the label is not
  // optional: a vertical list of bare glyphs is a column of riddles, and the
  // label is the entire reason a menu beats the strip this replaced.
  if (!compact && toolbarCfg.hidden.includes(t.id)) return null;
  const label = !compact;
  // A tap on a menu line is a choice, so it shuts the menu behind it — the
  // same thing the launcher's `.nav-more` does. `compact` pins are not in a
  // menu and close nothing.
  const dismiss = () => { if (!compact) closeToolbarMenu(t.id); };
  // A shell has no model to pick, and the logins sheet is for nothing else.
  // `isShellBackend` reads the host's `kind` and falls back to the id, so a
  // shell outliving a `backends` frame is still one.
  const isShell = isShellBackend(backends, active?.backend);
  if (t.id === "model" && isShell) return null;
  if (t.id === "logins" && !isShell) return null;
  switch (t.id) {
    case "untracked":
      if (!activeRepo || activeRepo.changedCount <= 0) return null;
      return <button key="untracked" className="key count" title={`${activeRepo.changedCount} changed file${activeRepo.changedCount > 1 ? "s" : ""} — open git`} onClick={() => { dismiss(); setOverlay("git"); }}><FileDiff size={ICON} /> {activeRepo.changedCount}</button>;
    // The star is stateful, so it is not the generic button: it says whether
    // this session IS starred (filled) and whether the desktop has agreed yet
    // (`star-pending`'s dotted underline). Absent on a queued open — there is
    // no session on the desktop to mark.
    case "star": {
      if (!active || pending) return null;
      const waiting = active.id in pendingStars;
      return (
        <button key="star" className={`key star-btn${active.starred ? " starred" : ""}${waiting ? " star-pending" : ""}`}
          data-hint="session.star"
          title={waiting
            ? (status === "open" ? "starred here — the desktop has not confirmed it yet" : "starred here — offline, so it is only on this phone until the link is back")
            : active.starred ? "unstar (prima interest)" : "star — mark as prima interest to come back to"}
          onClick={() => { dismiss(); toggleStar(active.id, !active.starred); }}>
          <Star size={ICON} fill={active.starred ? "currentColor" : "none"} />{label && <> {active.starred ? "starred" : "star"}</>}
        </button>
      );
    }
    default: {
      const own = featureToolbarItem(t.id, { label, dismiss, active });
      if (own !== undefined) return <Fragment key={t.id}>{own}</Fragment>;
      // The toolbar is the worst offender the hints exist for: icons-only by
      // default, and a `title` of "fork" / "ctx" / "teleport" explains
      // nothing even where a tooltip WOULD render. One lookup here covers
      // every generic item — long-press (or explain mode) gets the real
      // sentence from `HINTS`, and the tooltip gets it too on a desktop.
      const hint = HINTS[`toolbar:${t.id}`];
      // The outline is the one generic item that carries a NUMBER: how many
      // turns it is about to list. Same reader as the launcher row's outline
      // button, so the two can never say different things about one session.
      const tally = t.id === "outline" ? turnTally(active) : null;
      return (
        <button key={t.id} className="key" data-hint={`toolbar:${t.id}`}
          title={`${hint ? `${hint.title} — ${hint.what}` : t.name}${tallyTitle(tally)}`}
          onClick={() => { dismiss(); runToolbar(t.id); }}>
          <t.Icon size={ICON} />{label && <> {t.id === "model" ? (shortModel(active?.model) || "model") : t.name}</>}{tally == null ? null : <> {tally}</>}
        </button>
      );
    }
  }
}

/**
 * The burger's menu, drawn inside the header (the header gates it on the
 * burger being open and the header not collapsed).
 *
 * A queued open has no CLI to type into, so its menu is the sentence saying
 * which verbs wait for the session rather than a column of buttons that could
 * only answer with a toast.
 */
export function ToolbarMenu({ c, usedOrder, refreshTerminal }: {
  c: ToolbarCtx;
  usedOrder: string[];
  refreshTerminal(): void;
}): ReactNode {
  const { active, pending, toolbarCfg, setOverlay } = c;
  if (pending) return (
    <Unavailable className="toolbar-cants toolbar-cants-menu" cants={[
      { label: "terminal keys", reason: "there is no CLI to type into until the session opens" },
      { label: "slash commands", reason: "there is no CLI to type into until the session opens" },
      { label: "reader, context, /usage", reason: "the conversation starts when the session does" },
    ]} />
  );
  return (
    <div className="toolbar" role="menu" aria-label="toolbar">
      <button className="key" title="refresh terminal" onClick={() => { closeToolbarMenu(); refreshTerminal(); }}><RotateCw size={ICON} /> refresh</button>
      {active.remoteUrl && <button className="key" onClick={() => { closeToolbarMenu(); window.open(active.remoteUrl, "_blank"); }} title="open in app"><Smartphone size={ICON} /> open in app</button>}
      {orderedToolbarItems(toolbarCfg, usedOrder).map((t) => renderToolbarItem(c, t))}
      <button className="key" title="customize toolbar" onClick={() => { closeToolbarMenu(); setOverlay("toolbar"); }}><Settings size={ICON} /> customize</button>
    </div>
  );
}
