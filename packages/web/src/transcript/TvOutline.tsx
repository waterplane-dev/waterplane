import { OutlineRows } from "../OutlineSheet";
import type { TvModel } from "./useTranscriptView";
import { Hint } from "../kit/Hint";
import { LS } from "../storage";
import { useDragCap } from "../core/session/useDragCap";

/** Its usual share of the reader (`.tr-outline`'s max-height in 07-reader.css). */
const REST_SHARE = 0.45;
/** About one card: the list never shrinks to nothing while it is switched on. */
const FLOOR_PX = 48;
/** What the conversation under it keeps (`.tr-outline ~ .tr-body`'s min-height). */
const BODY_MIN_PX = 64;

export function TvOutline({ m }: { m: TvModel }) {
  return m.outline ? <OutlineDrawer m={m} /> : null;
}

/** The outline over the conversation, with a grip under it that moves the line
 *  between the two: up for more conversation, down for more outline (the owner's
 *  ask, 2026-11-25). Its count line is in the frame above (`TvTop.tsx`). */
function OutlineDrawer({ m }: { m: TvModel }) {
  const { outlineTurns, doc, seenMark, goTurn, bodyRef } = m;
  const { frame, cap, capped, grip } = useDragCap({
    key: LS.outlineH, floorPx: FLOOR_PX,
    drawer: () => ({
      restPx: (frame.current?.parentElement?.clientHeight ?? 0) * REST_SHARE,
      ceilPx: (frame.current?.clientHeight ?? 0) + (bodyRef.current?.clientHeight ?? 0) - BODY_MIN_PX,
    }),
    showAllEvent: "action:outline.usualHeight", capEvent: "action:outline.height",
  });
  const note = [
    doc?.source === "history" && "approximate (no conversation log for this session — showing captured terminal text)",
    doc?.truncated && "older turns trimmed",
  ].filter(Boolean).join(" · ");
  const words = capped
    ? "outline resized — tap for its usual height, or drag"
    : "drag to make the outline taller or shorter";
  return (
    <>
      <div ref={frame} className="tr-outline" style={capped ? { maxHeight: `${cap}px` } : undefined}>
        {/* `"history"` is the ONLY approximate source, and the test is
            written as an equality against it rather than as "not jsonl" for
            exactly that reason: `"opencode"` is the backend's own dated
            record read out of its store — as exact as the CLI's log — and a
            `!== "jsonl"` here would have libelled it as reconstructed
            terminal text. It also means an older phone meeting a source it
            has never heard of reads it as exact, which is correct: the
            approximate one is the one this app builds itself. Here and not in
            the count line, which a person may have dragged away. */}
        {note && <Hint>{note}</Hint>}
        <OutlineRows turns={outlineTurns} seenMark={seenMark} onJump={goTurn} />
      </div>
      <div className="sess-chrome-grip tr-outline-grip"
        role="separator" aria-orientation="horizontal" tabIndex={0}
        aria-label={words} title={words} {...grip} />
    </>
  );
}
