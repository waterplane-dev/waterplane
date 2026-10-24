/** The footer: attach buttons, cancel and the one primary button. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { CalendarClock, SendHorizontal, TriangleAlert, X } from "lucide-react";
import { AttachButtons } from "../PromptComposer";
import { track } from "../usage";
import { offlineLabel, EMPTY_PROMPT_BLOCKER } from "../sendIntent";
import { CantInline } from "../Unavailable";
import type { SendSheetModel } from "./useSendSheet";
import { Button } from "../kit/Button";

export function SendActions({ m }: { m: SendSheetModel }) {
  const {
    seed, online, onBrowseRepoFiles, onClose, retime, promptsRef, focusStep, blocker, label, attachRepo, ready, when, busy, updatePrompts, pick, go,
  } = m;
  return (
    <div className="sheet-actions">
      {!retime && <AttachButtons prompts={promptsRef} onPrompts={updatePrompts} focusRef={focusStep} busy={busy} unavailable={attachRepo ? undefined : "pick where it goes first, a file needs a repo's inbox to land in"}
        onFiles={(f) => void pick(f)}
        onBrowse={onBrowseRepoFiles && attachRepo ? () => { track("action:send.browse"); onBrowseRepoFiles(attachRepo); } : undefined}
        trackImage="action:send.attach" trackFile="action:send.attachfile" />}
      <Button onClick={onClose}><X size={16} /> cancel</Button>
      <span className="spacer" />
      {/* A send that cannot go is a sentence, not a dimmed button. `busy` (a
          file being shrunk, ~a second) is the one case that stays a disabled
          button: it is in flight and the label says so. The empty box is the
          other: its placeholder already asks for the words in text, so a line
          here would say it twice (EMPTY_PROMPT_BLOCKER). */}
      {blocker && blocker !== EMPTY_PROMPT_BLOCKER ? <CantInline>{blocker}</CantInline> : (
        <button className="send" disabled={!!blocker || busy} onClick={go}>
          {when.kind === "at" ? <CalendarClock size={16} /> : seed.repair && !ready ? <TriangleAlert size={16} /> : <SendHorizontal size={16} />}
          {" "}{online || when.kind === "at" ? label : offlineLabel(label)}
        </button>
      )}
    </div>
  );
}
