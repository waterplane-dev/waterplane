/**
 * The `toolbar` sheet: customize the burger's menu — order (by hand or by
 * use), show/hide, and which items are pinned into the session header.
 */
import { useState, type PointerEvent } from "react";
import { ArrowDown, ArrowUp, BarChart3, Eye, EyeOff, GripVertical, Pin, Slash } from "lucide-react";
import { useCore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { orderedToolbarItems } from "../../toolbar";
import { usageCount } from "../../usage";
import { dragToolbarItem, moveToolbarItem, setToolbarSort, toggleToolbarItem, toggleToolbarPin } from "./actions";
import { useHeaderCmds, useToolbarCfg, useUsedOrder } from "./store";
import { Button, Row, RowTitle, Hint } from "../../kit";
import { SetNote } from "../../SettingsKit";

/** App's header-button size. */
const ICON = 16;

export function ToolbarSheet() {
  const core = useCore();
  const toolbarCfg = useToolbarCfg();
  const headerCmds = useHeaderCmds();
  const usedOrder = useUsedOrder();
  const [dragId, setDragId] = useState<string | null>(null); // toolbar item being dragged
  /** Touch-friendly — elementFromPoint instead of HTML5 DnD (which barely
   *  works on mobile). */
  const dragOverItem = (e: PointerEvent) => {
    if (!dragId) return;
    const row = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-tbid]");
    dragToolbarItem(dragId, row?.getAttribute("data-tbid"));
  };
  return (
    <div className="sheet">
      <SheetHead title={"Customize toolbar"} onClose={() => core.nav.close("toolbar")} />
      <div className="form">
        {/* No "icons only" switch any more: the toolbar is a vertical menu,
            and a column of bare glyphs is a column of riddles. The labels
            are what a menu IS. The header PINS are still icon-only — they
            share one line with the session title (`renderToolbarItem`'s
            `compact`). */}
        {/* The other configurable row. Someone looking for "where do I put my
            own buttons" lands here first, and the header chips are a separate
            list — say so instead of letting them look for it. */}
        <Button onClick={() => { core.say.track("action:hdrcmd.manage"); core.nav.open("hdrcmd"); }}>
          <Slash size={ICON} /> header commands ({headerCmds.length}) &amp; pins ({(toolbarCfg.pinned ?? []).length})
        </Button>
        <SetNote>Header commands are the one-tap chips next to the session title — they stay reachable when the header is collapsed and in reader view.</SetNote>
        <Row style={{ gap: 6 }}>
          <Button
            className={(toolbarCfg.sort ?? "manual") === "manual" ? "active" : ""}
            title="keep the order you set"
            onClick={() => setToolbarSort("manual")}
          ><GripVertical size={ICON} /> manual order</Button>
          <Button
            className={toolbarCfg.sort === "used" ? "active" : ""}
            title="auto-order by how often you use each action"
            onClick={() => setToolbarSort("used")}
          ><BarChart3 size={ICON} /> most used</Button>
        </Row>
        <Hint>
          {toolbarCfg.sort === "used"
            ? <>Auto-sorted by your usage (counts below). The live toolbar re-ranks on session switch and about once a minute — never mid-tap. Switch back to manual to drag or move items with the arrows.</>
            : <>Drag the <GripVertical size={12} /> handle to reorder (or use the arrows). Tap the eye to show/hide an action in the terminal toolbar, and the <Pin size={12} /> to also put it in the session header (where it survives a collapse).</>}
        </Hint>
      </div>
      <div
        className="list"
        style={{ touchAction: dragId ? "none" : undefined }}
        onPointerMove={dragOverItem}
        onPointerUp={() => setDragId(null)}
        onPointerCancel={() => setDragId(null)}
      >
        {orderedToolbarItems(toolbarCfg, usedOrder).map((t, i, arr) => {
          const shown = !toolbarCfg.hidden.includes(t.id);
          const manual = (toolbarCfg.sort ?? "manual") === "manual";
          const n = usageCount(`toolbar:${t.id}`);
          return (
            <div key={t.id} data-tbid={t.id} className={`row ${dragId === t.id ? "dragging" : ""}`}>
              {manual && <Button
                className="drag-handle"
                title="drag to reorder"
                style={{ touchAction: "none", cursor: "grab" }}
                onPointerDown={(e) => { e.preventDefault(); setDragId(t.id); }}
              ><GripVertical size={ICON} /></Button>}
              <RowTitle><t.Icon size={ICON} /> {t.name}</RowTitle>
              <span className="muted" title={`used ${n}×  on this device`} style={{ fontSize: 12 }}>{n || "–"}</span>
              {/* Never a greyed arrow (`Unavailable.tsx`): with the order
                  following usage there are no arrows at all and the hint above
                  says why; at either END the arrow that cannot move is an
                  invisible, untappable slot, so the columns still line up. */}
              {manual && (i > 0
                ? <Button title="move up" onClick={() => moveToolbarItem(t.id, -1)}><ArrowUp size={ICON} /></Button>
                : <span className="key" aria-hidden style={{ visibility: "hidden" }}><ArrowUp size={ICON} /></span>)}
              {manual && (i < arr.length - 1
                ? <Button title="move down" onClick={() => moveToolbarItem(t.id, 1)}><ArrowDown size={ICON} /></Button>
                : <span className="key" aria-hidden style={{ visibility: "hidden" }}><ArrowDown size={ICON} /></span>)}
              <Button className={(toolbarCfg.pinned ?? []).includes(t.id) ? "active" : ""}
                title={(toolbarCfg.pinned ?? []).includes(t.id) ? "unpin from the session header" : "pin into the session header — stays reachable when the header is collapsed and in reader view"}
                onClick={() => toggleToolbarPin(t.id)}><Pin size={ICON} /></Button>
              <Button title={shown ? "hide" : "show"} onClick={() => toggleToolbarItem(t.id)}>
                {shown ? <Eye size={ICON} /> : <EyeOff size={ICON} className="muted" />}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
