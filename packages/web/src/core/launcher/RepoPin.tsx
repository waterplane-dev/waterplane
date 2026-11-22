/**
 * "Pin…" — a repo's place at the top of Home, set from that repo's own "⋯" menu.
 *
 * Pinned repos lead the launcher list in the order the person placed them; the
 * repo sort (open sessions / name) orders only the rest (`model.ts` `pinAt`). The
 * control lives only here, never on the row, so a pin costs no room on Home.
 *
 * With no other pin, a tap pins at once. With others, it unfolds the places
 * BETWEEN them ("above X", "between X and Y", "below Z") — the choice is the
 * position, said by its neighbours' names. A pinned repo's line opens the same
 * places plus Unpin. Every change says itself in a toast and names the way back.
 *
 * Only pins on screen count (`shown`): a hidden or removed repo keeps its pin
 * (it comes back where it was) but names no place and is not in "n of m".
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { setPref, usePref } from "../prefs";
import { pinAtShown, unpin } from "./model";

const ICON = 16;

export function RepoPin({ repoName, shown, shownOf, onDone }: {
  repoName: string; shown: ReadonlySet<string>; shownOf: (name: string) => string; onDone: () => void;
}) {
  const pins = usePref("pinnedRepos");
  const [open, setOpen] = useState(false);
  const placesRef = useRef<HTMLDivElement>(null);
  // "Pin…" sits in the menu's last group: unfolded, its places would start below the screen's edge.
  useLayoutEffect(() => { if (open) placesRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [open]);
  const name = shownOf(repoName);
  const seen = pins.filter((n) => n === repoName || shown.has(n));
  const at = seen.indexOf(repoName);
  const others = seen.filter((n) => n !== repoName);

  function place(slot: number) {
    track(at < 0 ? "action:repo.pin" : "action:repo.pin.move");
    setPref("pinnedRepos", pinAtShown(pins, repoName, slot, shown));
    setOpen(false);
    onDone();
    showToast(at < 0 ? `${name} pinned — ⋯ → Pinned to move or unpin` : `${name} moved to pinned place ${slot + 1}`);
  }
  function drop() {
    track("action:repo.unpin");
    setPref("pinnedRepos", unpin(pins, repoName));
    setOpen(false);
    onDone();
    showToast(`${name} unpinned — ⋯ → Pin… to pin again`);
  }

  // Each place is named by its neighbours among the OTHER pins.
  const places = Array.from({ length: others.length + 1 }, (_, i) => {
    const above = others[i - 1], below = others[i];
    const words = !above ? `first, above ${shownOf(below!)}`
      : !below ? `last, below ${shownOf(above)}`
      : `between ${shownOf(above)} and ${shownOf(below)}`;
    return { slot: i, words, here: at === i };
  });

  return (
    <>
      <button className={`more-act${open ? " on" : ""}`} aria-expanded={open}
        title={at >= 0 ? `pinned, place ${at + 1} of ${seen.length} — move it or unpin it` : "keep this repo at the top of Home, at a place you choose"}
        onClick={() => {
          if (at < 0 && others.length === 0) { place(0); return; }
          track("action:repo.pin.open");
          setOpen((v) => !v);
        }}>
        <Pin size={ICON} />{at >= 0 ? <>Pinned · {at + 1} of {seen.length}</> : "Pin…"}
      </button>
      {open && (
        <div ref={placesRef} className="repo-pin-places" style={{ flex: "0 0 100%" }}>
          <span className="repo-pin-ask">{at >= 0 ? "Move it to:" : "Pin it:"}</span>
          {/* Where it sits now is a fact, not a button — same box as its neighbours, nothing to tap. */}
          {places.map((pl) => pl.here
            ? <span key={pl.slot} className="more-act on" aria-current="true">{pl.words} — here now</span>
            : <button key={pl.slot} className="more-act" onClick={() => place(pl.slot)}>{pl.words}</button>)}
          {at >= 0 && <button className="more-act" onClick={drop}><PinOff size={ICON} />Unpin</button>}
        </div>
      )}
    </>
  );
}
