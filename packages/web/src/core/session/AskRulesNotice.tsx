import { useState, type ReactNode } from "react";
import { ShieldQuestion } from "lucide-react";
import type { BackendInfo, SessionInfo } from "@waterplane/shared";
import { isShellBackend } from "../../backendCaps";
import { useAskRules } from "../../AskRulesHere";
import { Hint } from "../../kit/Hint";
import { showToast } from "../../toast";
import { askRulesDue, askRulesGoneText, askRulesNone, askRulesText, markAskRulesSeen, toldSeen } from "./toldWords";

/**
 * The once-per-backend notice for a session whose ask-before rules nothing enforces
 * (`SessionInfo.askRulesVia === "none"`), shaped exactly like `ToldNotice`: the sentence and
 * *got it*, then one small icon beside the title that reads it again. `native` and `gate`
 * sessions, and hosts that do not say, draw nothing.
 */
export function AskRulesNotice({ active, backends }: { active: SessionInfo; backends: BackendInfo[] | null }): ReactNode {
  const kind = isShellBackend(backends, active.backend) ? "shell" as const : undefined;
  // The rules are only read (one cached GET) for a session that could draw the notice.
  return askRulesNone(active.askRulesVia, kind) ? <AskRulesNoticeBody active={active} backends={backends} /> : null;
}

function AskRulesNoticeBody({ active, backends }: { active: SessionInfo; backends: BackendInfo[] | null }): ReactNode {
  const { rules } = useAskRules();
  const id = active.backend ?? "claude";
  const kind = isShellBackend(backends, active.backend) ? "shell" as const : undefined;
  const [open, setOpen] = useState(() => askRulesDue(active.askRulesVia, id, toldSeen(), kind));
  // A notice about rules the person does not have is a notice about nothing; until the list has
  // loaded (or when it is empty) nothing is drawn.
  if (rules.length === 0) return null;
  const label = backends?.find((b) => b.id === id)?.label ?? id;
  if (!open) {
    // Raw, not the kit `Button`: a 12px glyph inside the title line, the `link-btn` shape.
    return (
      <button className="link-btn told-mark" title={askRulesText(label)} aria-label={`Ask-before rules are not enforced in ${label} — read why`}
        onClick={() => setOpen(true)}>
        <ShieldQuestion size={12} aria-hidden="true" />
      </button>
    );
  }
  return (
    <Hint className="told-note" role="note">
      {askRulesText(label)}{" "}
      <button className="link-btn" onClick={() => {
        markAskRulesSeen(id);
        setOpen(false);
        showToast(askRulesGoneText(label));
      }}>got it</button>
    </Hint>
  );
}
