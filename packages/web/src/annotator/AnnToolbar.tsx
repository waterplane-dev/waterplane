/**
 * The tool bar and the style (colour + stroke) panel.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 *
 * Which controls it draws, and in what order, is the person's (`annLayout.ts`, set in `AnnConfig`).
 * Whether it is a row on top or a rail down the left is CSS on the wrapper (`.annot-body.place-*`):
 * on a phone held upright a row of a dozen 44 px keys scrolls sideways and eats a strip the picture
 * needs, while a rail takes a thumb-width the picture's aspect leaves empty anyway.
 *
 * A region: it draws the model and owns no hook (a child's effects run before its parent's).
 */

import type { ReactNode } from "react";
import { ArrowUpRight, Circle, Crop, Eraser, EyeOff, Highlighter, Minus, Move, Square, Trash2, Type, Undo2 } from "lucide-react";
import { shownControls, type AnnControl } from "../annLayout";
import { COLORS, THICKS, type Tool } from "./annTypes";
import type { AnnModel } from "./useAnnotator";
import { Button } from "../kit/Button";

const TOOL_ICONS: Partial<Record<AnnControl, { tool: Tool; icon: ReactNode; label: string }>> = {
  circle: { tool: "circle", icon: <Circle size={16} />, label: "circle" },
  rect: { tool: "rect", icon: <Square size={16} />, label: "rectangle" },
  arrow: { tool: "arrow", icon: <ArrowUpRight size={16} />, label: "arrow" },
  line: { tool: "line", icon: <Minus size={16} />, label: "line" },
  text: { tool: "text", icon: <Type size={16} />, label: "text" },
  marker: { tool: "marker", icon: <Highlighter size={16} />, label: "highlight text" },
  blur: { tool: "blur", icon: <EyeOff size={16} />, label: "blur or redact" },
};

export function AnnToolbar({ m }: { m: AnnModel }) {
  const { tool, color, setColor, factor, setFactor, shapes, setShapes, moveMode, selected, setSelected, setTarget, setMoveNote, knobs, cropMode, paletteOpen, setPaletteOpen, moveRef, toggleCrop, pickTool, undoShape, toggleMove, toggleKnobs, deleteSelected, layout } = m;
  const thick = THICKS.find((t) => t.factor === factor)?.label ?? "M";

  const control = (id: AnnControl): ReactNode => {
    const t = TOOL_ICONS[id];
    if (t) {
      return (
        <Button key={id} className={tool === t.tool ? "active" : ""} onClick={() => pickTool(t.tool)}
          title={t.label} aria-label={t.label} aria-pressed={tool === t.tool}>{t.icon}</Button>
      );
    }
    switch (id) {
      // Undo is first by default: reached for mid-mark, and at the far end of a scrolling bar it was a scroll away from a slip.
      case "undo":
        return <Button key={id} onClick={undoShape} disabled={!shapes.length} title="undo" aria-label="undo the last mark"><Undo2 size={16} /></Button>;
      case "crop":
        return <Button key={id} className={cropMode ? "active" : ""} onClick={toggleCrop} title="crop" aria-label="crop" aria-pressed={cropMode}><Crop size={16} /></Button>;
      case "move":
        return [
          <Button key={id} className={moveMode ? "active" : ""} onClick={toggleMove} disabled={!shapes.length} title="move/reshape a mark" aria-label="move a mark" aria-pressed={moveMode}><Move size={16} /></Button>,
          moveMode && (
            <Button key="del" onClick={deleteSelected} disabled={selected == null} title="delete the selected mark" aria-label="delete the selected mark"><Trash2 size={16} /></Button>
          ),
          moveMode && (
            <Button key="knobs" className={knobs ? "active" : ""} onClick={toggleKnobs} aria-pressed={knobs}
              title="knobs: move, size and turn a mark (or drag an arrow's ends) by knobs on strings, instead of dragging from anywhere"
              aria-label="knobs on the selected mark">knobs</Button>
          ),
        ];
      // One dot of the current colour, carrying the stroke letter: colour and
      // stroke are one decision about how the next mark looks, and five swatches
      // plus three stroke keys cost a phone's bar eight slots to say it.
      case "style":
        return (
          <button key={id} className={`swatch dot annot-style ${paletteOpen ? "on" : ""}`} style={{ background: color }}
            onClick={() => setPaletteOpen((v) => !v)}
            title="mark colour and stroke" aria-label={`mark colour ${color}, stroke ${thick} — tap to change`} aria-expanded={paletteOpen}>{thick}</button>
        );
      case "clear":
        return (
          <Button key={id} onClick={() => { moveRef.current = null; setSelected(null); setTarget(null); setMoveNote(null); setShapes([]); }}
            disabled={!shapes.length} title="clear all marks" aria-label="clear all marks"><Eraser size={16} /></Button>
        );
    }
    return null;
  };

  return (
    <>
      <div className="annot-tools annot-bar">
        {shownControls(layout).map(control)}
      </div>

      {/* A panel of its own, not a popover: the bar scrolls and an anchored
          layer over it drifts off its own dot. */}
      {paletteOpen && (
        <div className="annot-tools annot-palette">
          {COLORS.map((c) => (
            <button key={c} className={`swatch ${color === c ? "on" : ""}`} style={{ background: c }}
              onClick={() => { setColor(c); setPaletteOpen(false); }}
              title={`colour ${c}`} aria-label={`colour ${c}`} aria-pressed={color === c} />
          ))}
          {THICKS.map((t) => (
            <Button key={t.label} className={factor === t.factor ? "active" : ""} onClick={() => { setFactor(t.factor); setPaletteOpen(false); }}
              title={`stroke ${t.label}`} aria-label={`stroke ${t.label}`} aria-pressed={factor === t.factor}>{t.label}</Button>
          ))}
        </div>
      )}
    </>
  );
}
