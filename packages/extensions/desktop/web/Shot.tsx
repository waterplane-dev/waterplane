/**
 * The screenshot button and its receipt. The button is drawn twice — in the toolbar row, and on the
 * picture in fullscreen, where the toolbar is hidden — and both run `takeDesktopShot` (state.ts).
 * The receipt is a line in the picture's column, not a toast: in fullscreen the column sits above
 * the app's toast layer, so a toast would be said where nobody can see it.
 */
import type { CSSProperties } from "react";
import { Camera, ImageIcon, Loader2, X } from "lucide-react";
import { useStore } from "@waterplane/sdk";
import { dropShotLine, openShot, shot, takeDesktopShot } from "./state.ts";
import { SHOT, SHOT_TITLE } from "./words.ts";
import { Button, Hint } from "@waterplane/kit";

/** `worded`: the fullscreen float says "screenshot"; the toolbar's is the glyph alone (its row is full). */
export function ShotButton({ worded, style }: { worded?: boolean; style?: CSSProperties }) {
  const s = useStore(shot);
  const Icon = s.busy ? Loader2 : Camera;
  return (
    <Button style={style} title={SHOT_TITLE} aria-label={SHOT} aria-busy={s.busy}
      onClick={() => void takeDesktopShot()}>
      <Icon size={15} className={s.busy ? "spin" : undefined} />{worded ? ` ${SHOT}` : null}
    </Button>
  );
}

const LINE = {
  display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 12px",
  background: "var(--panel)", borderTop: "1px solid var(--line)", color: "var(--fg)",
} as const;
const BTN = { minHeight: 36, padding: "4px 10px", flex: "0 0 auto" } as const;

export function ShotLine() {
  const s = useStore(shot);
  if (!s.line) return null;
  return (
    <Hint style={LINE} role="status">
      <div style={{ flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{s.line}</div>
      {s.file && <Button style={BTN} title="open the screenshot — closing it comes back here" onClick={openShot}><ImageIcon size={15} /> open</Button>}
      {!s.busy && <Button style={BTN} title="dismiss" aria-label="dismiss" onClick={dropShotLine}><X size={15} /></Button>}
    </Hint>
  );
}
