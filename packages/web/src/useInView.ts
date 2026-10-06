/**
 * Has this element been on screen yet?
 *
 * Its own module because it has a second caller now. It was local to
 * `ActivitySheet.tsx` while only that list was long enough to need it; the
 * assessment sheet has the same shape — a list of rows, each of which may name
 * files, each strip one repo listing — and a second copy of six lines whose
 * whole value is the `rootMargin` and the stickiness is how the two drift.
 *
 * The stampede this exists to stop: an `AttachStrip` that finds a file mention
 * asks the desktop for a directory listing (`checkAttachments` → `api.inbox`),
 * and Activity reaches ~160 rows on one real phone — a triage screen full of
 * failed uploads is precisely the case where dozens of them name a file.
 * Mounting every strip at once would fire dozens of listings the instant the
 * sheet opens, over exactly the link whose failures put those rows there. A
 * phone shows about four rows, so waiting until a row is near the viewport
 * turns that into a handful.
 *
 * STICKY, deliberately: once a strip has been mounted it stays, so scrolling
 * back up does not re-ask for a listing it already has, and the row does not
 * change height under the thumb. `rootMargin` mounts it just before it is
 * visible, for the same reason `loading="lazy"` on the images inside it does.
 *
 * No `IntersectionObserver` (an old WebView) ⇒ `true` from the start. The
 * fallback is the behaviour without this hook at all, which is correct and
 * merely expensive; a missing observer must never mean a missing picture.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

export function useInView(enabled: boolean): [boolean, RefObject<HTMLDivElement>] {
  const [seen, setSeen] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled || seen) return;
    const node = el.current;
    if (!node || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "300px" });
    io.observe(node);
    return () => io.disconnect();
  }, [enabled, seen]);
  return [seen, el];
}
