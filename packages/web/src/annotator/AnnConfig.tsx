/**
 * The toolbar's config panel: show or hide each control, move it up or down,
 * and put the bar on the left or on top (`annLayout.ts`).
 *
 * It opens from the sheet header, never from the bar it edits, so hiding every
 * control still leaves the way back. Laid over the picture rather than a sheet
 * of its own: the arrangement is judged against the bar beside it, live.
 *
 * A region: it draws the model and owns no hook (a child's effects run before its parent's).
 */

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { ANN_CONTROLS, DEFAULT_LAYOUT, isDefaultLayout, moveControl, toggleHidden, type AnnPlace } from "../annLayout";
import type { AnnModel } from "./useAnnotator";

const PLACES: { v: AnnPlace; label: string }[] = [
  { v: "auto", label: "auto" },
  { v: "left", label: "left" },
  { v: "top", label: "top" },
];

export function AnnConfig({ m }: { m: AnnModel }) {
  const { layout, setLayout, setConfigOpen } = m;
  const labelOf = (id: string) => ANN_CONTROLS.find((c) => c.id === id)?.label ?? id;
  const last = layout.order.length - 1;
  return (
    <div className="annot-config" role="dialog" aria-label="customize the toolbar">
      <div className="annot-config-head">
        <span>Toolbar</span>
        <button className="key" onClick={() => setConfigOpen(false)} aria-label="close the toolbar settings"><X size={16} /> done</button>
      </div>
      <div className="annot-config-row">
        <span className="annot-config-label">position</span>
        {PLACES.map((p) => (
          <button key={p.v} className={`key ${layout.place === p.v ? "active" : ""}`} aria-pressed={layout.place === p.v}
            onClick={() => setLayout({ ...layout, place: p.v })}>{p.label}</button>
        ))}
      </div>
      <div className="annot-config-hint">
        {layout.place === "auto" ? "auto: a rail on the left on a phone, a row on top on a wider screen" : `always on the ${layout.place}`}
      </div>
      <div className="annot-config-list">
        {layout.order.map((id, i) => {
          const shown = !layout.hidden.includes(id);
          return (
            <div key={id} className={`annot-config-row ${shown ? "" : "off"}`}>
              <button className={`key annot-config-toggle ${shown ? "active" : ""}`} aria-pressed={shown}
                onClick={() => setLayout(toggleHidden(layout, id))}>{shown ? "shown" : "hidden"}</button>
              <span className="annot-config-label">{labelOf(id)}</span>
              {/* At either end the arrow is absent, not dimmed: there is nowhere to go. */}
              {i > 0 ? (
                <button className="key" onClick={() => setLayout(moveControl(layout, id, -1))} aria-label={`move ${labelOf(id)} up`}><ChevronUp size={16} /></button>
              ) : <span className="annot-config-gap" />}
              {i < last ? (
                <button className="key" onClick={() => setLayout(moveControl(layout, id, 1))} aria-label={`move ${labelOf(id)} down`}><ChevronDown size={16} /></button>
              ) : <span className="annot-config-gap" />}
            </div>
          );
        })}
      </div>
      {!isDefaultLayout(layout) && (
        <div className="annot-config-row">
          <button className="key" onClick={() => setLayout({ ...DEFAULT_LAYOUT, order: DEFAULT_LAYOUT.order.slice() })}>reset to default</button>
        </div>
      )}
    </div>
  );
}
