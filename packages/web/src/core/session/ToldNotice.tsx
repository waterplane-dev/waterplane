import { useState, type ReactNode } from "react";
import { MessageSquareOff } from "lucide-react";
import type { BackendInfo, SessionInfo } from "@waterplane/shared";
import { isShellBackend } from "../../backendCaps";
import { Hint } from "../../kit/Hint";
import { showToast } from "../../toast";
import { markToldSeen, notTold, toldGoneText, toldNoticeDue, toldSeen, toldText } from "./toldWords";

/**
 * The once-per-backend notice for a session whose agent was not told about the outbox
 * (`toldWords.ts`). Owed ⇒ the sentence and *got it*; dismissed ⇒ one small icon beside the
 * title, whose tap reads the sentence again (the way back, said in the dismissal's toast).
 * A session that WAS told, or whose host does not say, draws nothing.
 */
export function ToldNotice({ active, backends }: { active: SessionInfo; backends: BackendInfo[] | null }): ReactNode {
  const id = active.backend ?? "claude";
  const kind = isShellBackend(backends, active.backend) ? "shell" as const : undefined;
  const [open, setOpen] = useState(() => toldNoticeDue(active.told, id, toldSeen(), kind));
  if (!notTold(active.told, kind)) return null;
  const label = backends?.find((b) => b.id === id)?.label ?? id;
  if (!open) {
    // Raw, not the kit `Button`: a 12px glyph inside the title line, the `link-btn` shape.
    return (
      <button className="link-btn told-mark" title={toldText(label)} aria-label={`${label} was not told about the outbox — read why`}
        onClick={() => setOpen(true)}>
        <MessageSquareOff size={12} aria-hidden="true" />
      </button>
    );
  }
  return (
    <Hint className="told-note" role="note">
      {toldText(label)}{" "}
      <button className="link-btn" onClick={() => {
        markToldSeen(id);
        setOpen(false);
        showToast(toldGoneText(label));
      }}>got it</button>
    </Hint>
  );
}
