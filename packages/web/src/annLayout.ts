/**
 * The annotator's toolbar, as the person arranged it: which controls show, in
 * what order, and where the bar sits (`waterplane.annTools`, synced).
 *
 * Pure so the rules are node-tested (`annLayout.test.mjs`). A stored layout is
 * READ leniently: an unknown id (an older or newer build's) is dropped, a
 * control this build has that the stored order lacks is appended where its
 * default neighbour would put it — a new tool is never hidden by a layout
 * written before it existed.
 *
 * Hiding is reversible from the same sheet, and the config button lives in the
 * sheet header rather than in the bar, so no arrangement can hide the way back.
 */

export type AnnControl =
  | "undo" | "circle" | "rect" | "arrow" | "line" | "text" | "marker" | "blur" | "crop" | "move"
  | "style" | "clear";

/** `auto`: a vertical rail on the left on a phone-sized screen, a row on top otherwise. */
export type AnnPlace = "auto" | "left" | "top";

export interface AnnLayout {
  order: AnnControl[];
  hidden: AnnControl[];
  place: AnnPlace;
}

export const ANN_CONTROLS: { id: AnnControl; label: string }[] = [
  { id: "undo", label: "undo" },
  { id: "circle", label: "circle" },
  { id: "rect", label: "rectangle" },
  { id: "arrow", label: "arrow" },
  { id: "line", label: "line" },
  { id: "text", label: "text label" },
  { id: "marker", label: "highlight text" },
  { id: "blur", label: "blur / redact" },
  { id: "crop", label: "crop" },
  { id: "move", label: "move a mark" },
  { id: "style", label: "colour & stroke" },
  { id: "clear", label: "clear all marks" },
];

const IDS = ANN_CONTROLS.map((c) => c.id);
const PLACES: AnnPlace[] = ["auto", "left", "top"];

export const DEFAULT_LAYOUT: AnnLayout = { order: IDS.slice(), hidden: [], place: "auto" };

const isId = (v: unknown): v is AnnControl => typeof v === "string" && (IDS as string[]).includes(v);

/** Whatever was stored, as a layout this build can draw. Never throws. */
export function readLayout(raw: unknown): AnnLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT, order: IDS.slice() };
  const r = raw as Record<string, unknown>;
  const seen = new Set<AnnControl>();
  const order: AnnControl[] = [];
  for (const v of Array.isArray(r.order) ? r.order : []) {
    if (isId(v) && !seen.has(v)) { seen.add(v); order.push(v); }
  }
  // A control the stored order lacks goes in after its nearest default predecessor.
  IDS.forEach((id, i) => {
    if (seen.has(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(IDS[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    order.splice(at, 0, id);
    seen.add(id);
  });
  const hidden = (Array.isArray(r.hidden) ? r.hidden : []).filter(isId)
    .filter((v, i, a) => a.indexOf(v) === i);
  const place = PLACES.includes(r.place as AnnPlace) ? (r.place as AnnPlace) : "auto";
  return { order, hidden, place };
}

/** The controls the bar draws, in order. */
export function shownControls(l: AnnLayout): AnnControl[] {
  return l.order.filter((id) => !l.hidden.includes(id));
}

export function toggleHidden(l: AnnLayout, id: AnnControl): AnnLayout {
  const hidden = l.hidden.includes(id) ? l.hidden.filter((h) => h !== id) : [...l.hidden, id];
  return { ...l, hidden };
}

/** Swap `id` with its neighbour; at either end it is the same layout. */
export function moveControl(l: AnnLayout, id: AnnControl, dir: -1 | 1): AnnLayout {
  const i = l.order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= l.order.length) return l;
  const order = l.order.slice();
  [order[i], order[j]] = [order[j], order[i]];
  return { ...l, order };
}

export function isDefaultLayout(l: AnnLayout): boolean {
  return l.place === "auto" && !l.hidden.length && l.order.every((id, i) => id === IDS[i]);
}
