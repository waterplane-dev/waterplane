/**
 * The session's message box, above the picture, while marking — on a phone,
 * where the annotator covers the session (a wide window draws the session
 * BESIDE it instead and this is not mounted: `useAnnBeside`).
 *
 * The SAME words as the session's box, never a copy: `prompt` reads and edits
 * that draft, so Send & run submits what is typed here. Folded it is one line
 * with the draft's start on it, so the person sees there is a prompt waiting
 * without giving the picture the room; open or folded is remembered per device.
 *
 * A region: it draws its props and owns one piece of view state.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquareText } from "lucide-react";
import { PromptComposer } from "../PromptComposer";
import { LS, lsBool, lsSet } from "../storage";

export function AnnPrompt({ prompt }: { prompt: { value: string; onChange: (next: string) => void } }) {
  const [open, setOpen] = useState(() => lsBool(LS.annPrompt, false));
  const toggle = () => setOpen((v) => { lsSet(LS.annPrompt, v ? "0" : "1"); return !v; });
  const first = prompt.value.trim().split("\n")[0];
  return (
    <div className="ann-prompt">
      <button className="ann-prompt-fold" onClick={toggle} aria-expanded={open}
        title={open ? "fold the message box away" : "show the session's message box — typed here, sent with the picture on Send & run"}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <MessageSquareText size={14} />
        <span className="ann-prompt-gist">{open ? "message for the session" : first || "message for the session — empty"}</span>
      </button>
      {open && (
        <PromptComposer inline rows={2} prompts={[prompt.value]} onChange={(next) => prompt.onChange(next[0] ?? "")}
          placeholder="Message for the session — Send & run sends it with the picture" />
      )}
    </div>
  );
}
