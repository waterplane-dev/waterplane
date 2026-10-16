import { useState } from "react";
import { track } from "../usage";
import { isImage } from "../docKind";
import { togglePick } from "./galleryPick";
import type { GalleryProps, Row } from "./galleryTypes";

/**
 * Picking pictures to combine. A MODE, not a long-press: a tap on a tile normally OPENS it, and a
 * hidden gesture that does something else is one nobody finds. `picked` null = not picking; the
 * list is in tap order (① first). One repo only — the combined picture uploads into one inbox.
 */
export function useGalleryPick(o: { onCombine: GalleryProps["onCombine"]; singleRepo: boolean; files: Row[];
  repoOf: (f: Row) => string; urlFor: (f: Row) => string }) {
  const [picked, setPicked] = useState<Row[] | null>(null);
  const key = (f: Row) => `${o.repoOf(f)}:${f.relPath}`;
  const pickIndex = (f: Row) => (picked ? picked.findIndex((p) => key(p) === key(f)) : -1);
  const canPick = !!o.onCombine && o.singleRepo && o.files.filter((f) => isImage(f.relPath)).length >= 2;
  const startPick = () => { track("action:gallery.pick"); setPicked([]); };
  const cancelPick = () => setPicked(null);
  const togglePicked = (f: Row) => { if (isImage(f.relPath)) setPicked((p) => togglePick(p ?? [], f, key)); };
  const combinePicked = () => {
    if (!picked || picked.length < 2 || !o.onCombine) return;
    track("action:gallery.combine");
    const items = picked.map((f) => ({ url: o.urlFor(f), name: f.name, repoId: o.repoOf(f) }));
    setPicked(null);
    o.onCombine(items);
  };
  return { picked, pickIndex, canPick, startPick, cancelPick, togglePicked, combinePicked };
}
