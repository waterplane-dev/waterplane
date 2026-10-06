/** The footer: attach buttons, cancel and the one primary button. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { CalendarClock, SendHorizontal, TriangleAlert, X } from "lucide-react";
import { AttachButtons } from "../PromptComposer";
import { track } from "../usage";
import { offlineLabel, EMPTY_PROMPT_BLOCKER } from "../sendIntent";
import type { SendSheetModel } from "./useSendSheet";

export function SendActions({ m }: { m: SendSheetModel }) {
  const {
    seed, online, onBrowseRepoFiles, onClose, retime, promptsRef, focusStep, blocker, label, attachRepo, ready, when, busy, updatePrompts, pick, go,
  } = m;
  return (
    <div className="sheet-actions">
      {!retime && <AttachButtons prompts={promptsRef} onPrompts={updatePrompts} focusRef={focusStep} busy={busy} disabled={!attachRepo}
        disabledTitle="pick where it goes first — a file needs a repo's inbox to land in"
        onFiles={(f) => void pick(f)}
        onBrowse={onBrowseRepoFiles && attachRepo ? () => { track("action:send.browse"); onBrowseRepoFiles(attachRepo); } : undefined}
        trackImage="action:send.attach" trackFile="action:send.attachfile" />}
      <button className="key" onClick={onClose}><X size={16} /> cancel</button>
      <span className="spacer" />
      {blocker && blocker !== EMPTY_PROMPT_BLOCKER && <span className="approve-hint sched-blocked">{blocker}</span>}
      <button className="send" disabled={!!blocker || busy} title={blocker ?? undefined} onClick={go}>
        {when.kind === "at" ? <CalendarClock size={16} /> : seed.repair && !ready ? <TriangleAlert size={16} /> : <SendHorizontal size={16} />}
        {" "}{online || when.kind === "at" ? label : offlineLabel(label)}
      </button>
    </div>
  );
}
