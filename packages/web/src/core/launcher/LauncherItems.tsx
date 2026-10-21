/**
 * The lines extensions add to the launcher's ☰ menu (`LauncherItemDef` — Desktop, Links, Vault).
 * Icon + one word, in the menu's own `.more-act` grammar; they were a row of their own under the
 * header once, a whole row of home screen for three buttons. Nothing is drawn when no extension
 * contributes one, so the menu is what it always was. An unavailable item is drawn like the others
 * and its tap SAYS why (a toast with the extension's sentence) — never a greyed button.
 *
 * An item with something waiting (`useCount`, the vault's asks) carries the bell's counted badge on
 * its menu line, and `LauncherItemKeys` lifts it out of the hidden menu into the header row beside
 * the bell while the count is above zero — a fingerprint ask must not wait behind a ☰ nobody opened.
 * While counted, a tap goes to `openCount` (exactly what the badge counts — a count is a filter), and
 * every badge reads the number through ONE function (`countedN`; the ☰ sum is `menuBadgeTotal`).
 */
import type { ReactNode } from "react";
import { badgeText } from "../../features/notifications";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { ExtBoundary } from "../ExtBoundary";
import { launcherItems } from "../extensionPoints";
import { countedN, menuBadgeTotal, type ContributedEntry } from "../featureRun";
import { Button } from "../../kit/Button";

const noCount = () => null;

/** A counted item's tap lands on exactly what the badge counts (`openCount`) — a count is a filter. */
function tap(it: ContributedEntry, where: string, n: number, onOpen?: () => void) {
  track(`action:launcher.${where}${it.key}`);
  onOpen?.();
  if (it.unavailable) showToast(it.unavailable);
  else if (n > 0 && it.openCount) it.openCount();
  else it.open();
}

function LauncherItem({ it, size, onOpen }: { it: ContributedEntry; size: number; onOpen: () => void }) {
  // A hook, called unconditionally: `useCount` is fixed per entry for the life of the bundle.
  const c = (it.useCount ?? noCount)();
  const n = countedN(c);
  const Icon = it.icon;
  return (
    <button className={`more-act${n ? " notif-btn" : ""}`} title={it.unavailable ?? (n ? c!.title : `open ${it.label}`)}
      onClick={() => tap(it, "", n, onOpen)}>
      <Icon size={size} />{it.label}
      {n > 0 && <span className="notif-badge">{badgeText(n)}</span>}
    </button>
  );
}

export function LauncherItems({ size, onOpen }: { size: number; onOpen: () => void }): ReactNode {
  const items = launcherItems();
  if (!items.length) return null;
  return (
    <>
      {items.map((it) => (
        <ExtBoundary key={it.key} feature={it.feature} what={`its ${it.label} menu line`}>
          <LauncherItem it={it} size={size} onOpen={onOpen} />
        </ExtBoundary>
      ))}
    </>
  );
}

function LauncherItemKey({ it, size }: { it: ContributedEntry; size: number }) {
  const c = it.useCount!();
  const n = countedN(c);
  if (!n) return null;
  const Icon = it.icon;
  return (
    <Button className="notif-btn" aria-label={c!.title} title={c!.title} onClick={() => tap(it, "key.", n)}>
      <Icon size={size} /><span className="notif-badge">{badgeText(n)}</span>
    </Button>
  );
}

/** The counted items, as header keys beside the bell — drawn only while their count is above zero. */
export function LauncherItemKeys({ size }: { size: number }): ReactNode {
  const items = launcherItems().filter((it) => it.useCount);
  if (!items.length) return null;
  return (
    <>
      {items.map((it) => (
        <ExtBoundary key={it.key} feature={it.feature} what={`its ${it.label} header key`}>
          <LauncherItemKey it={it} size={size} />
        </ExtBoundary>
      ))}
    </>
  );
}

function MenuCount({ items, base }: { items: ContributedEntry[]; base: number }) {
  // One hook per counted entry, in a fixed order: the entry list is fixed per bundle.
  const n = menuBadgeTotal(base, items.map((it) => it.useCount!()));
  return n > 0 ? <span className="mic-badge">{badgeText(n)}</span> : null;
}

/**
 * The ☰ button's badge: everything inside the menu that is waiting, summed — the core's own counts
 * (`base`: activity, apps ready) plus every counted extension item. A badge that exists only while
 * the menu is open is a badge nobody sees.
 */
export function LauncherMenuBadge({ base }: { base: number }): ReactNode {
  const items = launcherItems().filter((it) => it.useCount);
  if (!items.length) return base > 0 ? <span className="mic-badge">{badgeText(base)}</span> : null;
  return (
    <ExtBoundary feature={items.map((it) => it.feature).join(", ")} what="the menu badge">
      <MenuCount items={items} base={base} />
    </ExtBoundary>
  );
}
