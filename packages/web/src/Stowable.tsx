import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, type LucideIcon } from "lucide-react";
import { Button } from "./kit/Button";
import { coveringKey, sharesFact, stow, stowVersion, subscribeStow, trayAdd, trayEntries, unstow } from "./stow";
import { track } from "./usage";

/**
 * A strip that can be folded away and brought back — one wrapper for every card
 * that stands above the prompt bar (`stow.ts` says why it is a fold, never a
 * close).
 *
 * The strip draws `<StowButton />` at the end of its head — the SAME control,
 * same words, same look on every strip (the owner's ask, 2026-11-01: some
 * strips had a ×, some "fold", in two different faces). Folded, the strip is
 * not rendered at all and is listed behind `<StowCorner />`, ONE button in the
 * terminal's floating corner group that is there only while something is
 * folded — so every folded strip comes back from one place, and that place is
 * on screen in typing room and full screen too (the status line it used to
 * ride is not).
 *
 * Folding exists only where that corner does: the session screen marks itself
 * with `<StowHome>`. Anywhere else (the download strip on the launcher) a
 * `Stowable` draws its strip unfolded and `StowButton` is absent — a fold with
 * no way back on that screen would be a close.
 *
 * `stowKey` is the strip's CONTENT: what it shows that a person would want to
 * read again if it changed, one fact per line. Folding holds while no fact is
 * new, so new content comes back up unasked — and stays up: the fold it broke
 * is dropped, never re-applied when the old content returns.
 */
const FoldCtx = createContext<(() => void) | null>(null);
const HomeCtx = createContext(false);

/** The screen that carries `StowCorner` — strips inside it may fold. */
export function StowHome({ children }: { children: ReactNode }) {
  return <HomeCtx.Provider value>{children}</HomeCtx.Provider>;
}

export function Stowable({ slot, stowKey, label, detail, icon, children }: {
  slot: string;
  stowKey: string;
  /** The chip's words — the strip's own title, as drawn. */
  label: string;
  detail?: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  useSyncExternalStore(subscribeStow, stowVersion);
  const home = useContext(HomeCtx);
  const foldedAs = home ? coveringKey(slot, stowKey) : null;
  const folded = foldedAs != null;
  const fold = useCallback(() => { track(`action:stow.${slot}`); stow(slot, stowKey); }, [slot, stowKey]);
  const heldBy = useRef<string | null>(null);
  useEffect(() => {
    if (foldedAs != null) { heldBy.current = foldedAs; return; }
    // Dropped only when the news grew out of what was folded (a fact shared):
    // another session's strip at the same spot is not that fold's business.
    const held = heldBy.current;
    heldBy.current = null;
    if (held != null && sharesFact(held, stowKey)) unstow(slot, held);
  }, [slot, foldedAs, stowKey]);
  useEffect(() => {
    if (foldedAs == null) return;
    return trayAdd({ slot, label, detail, icon, unfold: () => { track(`action:unstow.${slot}`); unstow(slot, foldedAs); } });
  }, [foldedAs, slot, label, detail, icon]);
  if (folded) return null;
  if (!home) return <>{children}</>;
  return <FoldCtx.Provider value={fold}>{children}</FoldCtx.Provider>;
}

/** The fold control — one face on every strip; no variants on purpose.
 *  Renders nothing outside a `Stowable` on a `StowHome` screen. */
export function StowButton() {
  const fold = useContext(FoldCtx);
  if (!fold) return null;
  return (
    // raw: `onPointerDown` keeps the compose box focused (kit Button would too, but its
    // `.key` face is the header's 44px fingertip, too tall for a strip's head)
    <button className="stow-btn" onPointerDown={(e) => e.preventDefault()} onClick={fold}
      title="fold this away — it waits behind the folded-strips button in the terminal's corner"
      aria-label="fold away">
      <ArrowDownToLine size={12} /> fold
    </button>
  );
}

/**
 * Where every folded strip comes back from: one button in the terminal's corner
 * group, carrying the count, present only while something is folded. A tap
 * lists exactly those strips (a count is a filter); a row unfolds its strip.
 */
export function StowCorner({ iconSize }: { iconSize: number }) {
  const rows = useSyncExternalStore(subscribeStow, trayEntries);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!rows.length) setOpen(false); }, [rows.length]);
  if (!rows.length) return null;
  const n = rows.length;
  const label = `${n} folded strip${n > 1 ? "s" : ""} — tap to bring ${n > 1 ? "them" : "it"} back`;
  return (
    <span className="stow-corner">
      <Button className={open ? "active" : undefined} data-hint="term.folded"
        onPointerDown={(e) => e.preventDefault()}
        aria-label={label} aria-expanded={open} title={label}
        onClick={() => { track("action:stow.corner"); setOpen((o) => !o); }}>
        <ArrowUpFromLine size={iconSize} /><span className="term-zoom-count">{n}</span>
      </Button>
      {open && (
        <div className="stow-pop" role="menu">
          <div className="stow-pop-head">folded away</div>
          {rows.map((r) => {
            const Icon = r.icon;
            return (
              // raw: a menu row that is itself the tap target
              <button key={r.slot} role="menuitem" className="stow-row"
                onPointerDown={(e) => e.preventDefault()} onClick={r.unfold}
                title={`open ${r.label} again`}>
                <Icon size={14} /> <span className="stow-row-label">{r.label}</span>
                {r.detail ? <span className="mono stow-row-detail">{r.detail}</span> : null}
                <span className="stow-row-go">show</span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
