/**
 * Typing for the desktop, in THE prompt box (`PromptComposer`, lent by the kit — never a second
 * textarea). The words are this phone's until a send went out in full: the draft lives in a store
 * outside this panel and in `extStorage` (`setDraft`), so closing it, the view or the app (a
 * reload) keeps them, and only a send that went out in full
 * clears the box. Text goes as `text` events, a line break as Return (`keys.ts`). The receipt says
 * "sent", never "typed": a password field's secure input swallows keys with no sign (`sentReceipt`).
 */
import { core, useStore } from "@waterplane/sdk";
import { PromptComposer } from "@waterplane/kit";
import { CornerDownLeft, Type, X } from "lucide-react";
import { draft, setDraft } from "./state.ts";
import { sentReceipt } from "./words.ts";
import type { DesktopController } from "./controller.ts";

const PANEL = { flex: "0 0 auto", maxHeight: "40%", overflowY: "auto", touchAction: "pan-y", background: "var(--panel)", borderTop: "1px solid var(--line)", padding: "8px 8px 0" } as const;

export function TypePanel({ ctl, onClose }: { ctl: DesktopController; onClose(): void }) {
  const prompts = useStore(draft);
  const send = (ret: boolean) => {
    const text = prompts[0] ?? "";
    if (!text && !ret) { core().say.toast("Nothing to type yet — write it in the box first."); return; }
    if (!ctl.typeText(text, ret)) return; // the controller said why
    setDraft(""); // the words went out in full: the one place the box is emptied
    core().say.toast(sentReceipt(ret));
  };
  return (
    <div style={PANEL}>
      <PromptComposer inline rows={2} autoFocus prompts={prompts} onChange={(next) => setDraft(next[0] ?? "")}
        placeholder="Words for the desktop — typed where its cursor is" />
      <div className="queue-row-acts">
        <button className="key" title="type these words on the desktop" onClick={() => send(false)}><Type size={16} /> type</button>
        <button className="key" title="type these words, then press Return" onClick={() => send(true)}><CornerDownLeft size={16} /> type + Return</button>
        <span className="spacer" />
        <button className="key" title="close — what you wrote stays for next time" onClick={onClose}><X size={16} /></button>
      </div>
    </div>
  );
}
