/**
 * Drag-and-drop reordering: which row is held, whether a drag is allowed at
 * all (never while searching or filtered — `onReorder` sends the WHOLE order),
 * and the window-level pointer binding.
 */
import { useEffect, useRef, useState } from "react";
import type { BacklogItem } from "@waterplane/shared";
import type { BacklogProps } from "./backlogTypes";

export function useBacklogDrag(
  p: BacklogProps,
  { q, filtering, displayOrder, groupKeyOf }: { q: string; filtering: boolean; displayOrder: BacklogItem[]; groupKeyOf: (it: BacklogItem) => string },
) {
  // ── Drag-and-drop reordering ───────────────────────────────────────────
  // Only when not searching (visible == full repo list), so the order we send is
  // complete. Each crossover commits the new order; the host renumbers + echoes.
  const [dragId, setDragId] = useState<string | null>(null);
  // Also blocked while FILTERED, for the same reason it is blocked while
  // searching: `onReorder` sends the whole top-to-bottom order, and an order
  // computed from a subset would renumber the repo's list against rows that are
  // not on screen.
  const canDrag = !q && !filtering && p.online;
  // Drag uses WINDOW-level pointer listeners, not the container's — on touch the
  // grip's pointerdown implicitly captures the pointer, so the scroll container
  // never sees pointermove (drag looked dead on mobile). Window still receives it.
  // pointercancel (e.g. the browser deciding it's a scroll) also clears dragId so
  // it can't get stuck. Binds once per drag; the handlers read live values via a ref.
  // The handlers read the LATEST order / grouping / reorder verb through a ref,
  // so the effect binds once per drag (deps: `dragId`) and never closes over a
  // stale `displayOrder` — and its cleanup always removes what it added.
  const live = useRef({ displayOrder, groupKeyOf, verbs: p.cutVerbs });
  live.current = { displayOrder, groupKeyOf, verbs: p.cutVerbs };
  useEffect(() => {
    if (!dragId) return;
    const move = (e: PointerEvent) => {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-blid]") as HTMLElement | null;
      const overId = el?.getAttribute("data-blid");
      if (!overId || overId === dragId) return;
      // Reorder only within the same session group (drag doesn't reassign target).
      const { displayOrder, groupKeyOf } = live.current;
      const drag = displayOrder.find((v) => v.id === dragId);
      const over = displayOrder.find((v) => v.id === overId);
      if (!drag || !over || groupKeyOf(drag) !== groupKeyOf(over)) return;
      const ids = displayOrder.map((v) => v.id);
      const from = ids.indexOf(dragId), to = ids.indexOf(overId);
      if (from === -1 || to === -1) return;
      ids.splice(from, 1);
      ids.splice(to, 0, dragId);
      live.current.verbs.onReorder(ids);
    };
    const end = () => setDragId(null);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragId]);
  return {
    dragId,
    setDragId,
    canDrag,
  };
}
