/**
 * Typing for the desktop, in THE prompt box (`PromptComposer`, lent by the kit — never a second
 * textarea), `plain`: words for a machine get no capital the keyboard adds by itself. The words are
 * this phone's until a send went out in full: the draft lives in a store outside this panel and in
 * `extStorage` (`setDraft`), so closing it, the view or the app (a reload) keeps them, and only a send
 * that went out in full clears the box. Text goes as `text` events, a line break as Return
 * (`keys.ts`). The receipt says "sent", never "typed": a password field's secure input swallows keys
 * with no sign (`sentReceipt`).
 *
 * **protected** swaps the box for a masked field, like the compose bar's for a shell's `Password:`:
 * its words live in memory only (`secret` in `state.ts`), never the draft (which waits underneath),
 * never `extStorage`. Beside it the contributed fillers (`secretFillers`, e.g. a stored login): they
 * fill the masked field and never type — the person still taps type.
 */
import { useState } from "react";
import { core, secretFillers, useStore, type SecretFillContext } from "@waterplane/sdk";
import { PromptComposer, Button } from "@waterplane/kit";
import { CornerDownLeft, Eye, EyeOff, KeyRound, LockKeyhole, Type, X } from "lucide-react";
import { SECRET_ASK, clearSecret, draft, fillSecret, secret, setDraft, setSecretOn, setSecretValue } from "./state.ts";
import { sentReceipt } from "./words.ts";
import type { DesktopController } from "./controller.ts";

const PANEL = { flex: "0 0 auto", maxHeight: "40%", overflowY: "auto", touchAction: "pan-y", background: "var(--panel)", borderTop: "1px solid var(--line)", padding: "8px 8px 0" } as const;

export function TypePanel({ ctl, onClose }: { ctl: DesktopController; onClose(): void }) {
  const prompts = useStore(draft);
  const sec = useStore(secret);
  const [shown, setShown] = useState(false);
  const send = (ret: boolean) => {
    if (sec.on) {
      if (!sec.value) { core().say.toast("Type the password first — or fill it from a stored login."); return; }
      if (!ctl.typeText(sec.value, ret)) return; // the controller said why; the value stays for another try
      clearSecret();
      setShown(false);
      core().say.toast(sentReceipt(ret));
      return;
    }
    const text = prompts[0] ?? "";
    if (!text && !ret) { core().say.toast("Nothing to type yet — write it in the box first."); return; }
    if (!ctl.typeText(text, ret)) return; // the controller said why
    setDraft(""); // the words went out in full: the one place the box is emptied
    core().say.toast(sentReceipt(ret));
  };
  // The ask a filler answers: read when its button is drawn, checked again when the value lands.
  const fillCtx: SecretFillContext = { sessionId: null, askLine: SECRET_ASK, fill: (v) => fillSecret(sec.seq, v) };
  const fillers = sec.on ? secretFillers(fillCtx) : [];
  return (
    <div style={PANEL}>
      {sec.on ? (
        <>
          <div className="secret-ask"><KeyRound size={12} />protected — typed straight in, never kept as a draft; the box's words wait underneath</div>
          <div className="secret-row">
            {/* Raw on purpose: the masked field is an `<input type=password>` (the keyboard learns nothing), which the kit has no piece for. */}
            <input type={shown ? "text" : "password"} value={sec.value} autoFocus
              onChange={(e) => setSecretValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); send(false); } }}
              placeholder="password" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="send" />
            <Button aria-pressed={shown} title={shown ? "hide what is typed" : "show what is typed"} onClick={() => setShown((v) => !v)}>
              {shown ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
          </div>
        </>
      ) : (
        <PromptComposer inline plain rows={2} autoFocus prompts={prompts} onChange={(next) => setDraft(next[0] ?? "")}
          placeholder="Words for the desktop — typed where its cursor is" />
      )}
      <div className="queue-row-acts">
        <Button title="type these words on the desktop" onClick={() => send(false)}><Type size={16} /> type</Button>
        <Button title="type these words, then press Return" onClick={() => send(true)}><CornerDownLeft size={16} /> type + Return</Button>
        <Button aria-pressed={sec.on} className={sec.on ? "active" : undefined}
          title={sec.on ? "back to the typing box — the masked words are dropped" : "protected: a masked field for a password, kept nowhere"}
          onClick={() => { setSecretOn(!sec.on); setShown(false); }}><LockKeyhole size={16} /> protected</Button>
        {fillers.map((f) => (
          <Button key={f.key} title={f.unavailable ?? f.label}
            onClick={() => { if (f.unavailable) { core().say.toast(f.unavailable); return; } f.open(); }}>
            <f.icon size={16} /> {f.label}
          </Button>
        ))}
        <span className="spacer" />
        <Button title={sec.on ? "close — the masked words stay until the view closes" : "close — what you wrote stays for next time"} onClick={onClose}><X size={16} /></Button>
      </div>
    </div>
  );
}
