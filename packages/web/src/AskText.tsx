/**
 * "Type a line" — the in-app replacement for `window.prompt`, for the reasons
 * `Confirm.tsx` gives for `window.confirm`: a native modal blocks the WebView's
 * event loop, cannot be styled, and in the Android shell is a system dialog
 * stamped with the asset server's origin. The session rename was the one
 * caller, and on the phone its answer went nowhere a person could see.
 *
 * Promised like the native one (`const t = await askText(…)`, `null` when
 * dismissed) and mounted once in `main.tsx` beside `ConfirmHost`, because
 * `App` returns early per overlay.
 */
import { useCallback, useEffect, useState } from "react";
import { useDialogStep } from "./backStep";
import { Button } from "./kit/Button";

interface Ask {
  title: string;
  initial: string;
  placeholder: string;
  okLabel: string;
  /** A line under the field — what happens to what is typed. */
  note?: string;
  resolve: (text: string | null) => void;
}

let pending: Ask | null = null;
const listeners = new Set<(a: Ask | null) => void>();
function emit(): void { for (const fn of listeners) fn(pending); }

/** Ask for one line. Resolves the trimmed text, or `null` when dismissed or
 *  left empty. A second ask answers the first `null` rather than stacking. */
export function askText(opts: { title: string; initial?: string; placeholder?: string; okLabel?: string; note?: string }): Promise<string | null> {
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = {
      title: opts.title, initial: opts.initial ?? "", placeholder: opts.placeholder ?? "",
      okLabel: opts.okLabel ?? "Save", note: opts.note, resolve,
    };
    emit();
  });
}

/** Mounted once in `main.tsx`. Renders nothing when nothing is being asked. */
export function AskTextHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  // What was typed, and into WHICH ask: a new one shows its own start at once, so a Back in its first frame
  // does not read the empty box as words somebody typed.
  const [typed, setTyped] = useState<{ ask: Ask; text: string } | null>(null);
  const text = ask ? (typed?.ask === ask ? typed.text : ask.initial) : "";
  useEffect(() => {
    listeners.add(setAsk);
    setAsk(pending);
    return () => { listeners.delete(setAsk); };
  }, []);
  // Back (or a tap outside) was refused because it would have dropped typed words.
  const [kept, setKept] = useState(false);
  useEffect(() => { setKept(false); }, [ask]);
  const answer = useCallback((value: string | null) => {
    const a = pending;
    pending = null;
    emit();
    a?.resolve(value && value.trim() ? value.trim() : null);
  }, []);
  // Back and the backdrop are "never mind", but not for words somebody typed: those go only by a button.
  const dismiss = () => (ask && text.trim() !== ask.initial.trim() ? setKept(true) : answer(null));
  useDialogStep(ask !== null, dismiss);
  if (!ask) return null;
  return (
    <div className="bl-modal-backdrop confirm-backdrop" onClick={dismiss}>
      <form className="bl-modal confirm-modal" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); answer(text); }}>
        <div className="bl-modal-title">{ask.title}</div>
        <input className="ask-text-input" autoFocus value={text} placeholder={ask.placeholder}
          enterKeyHint="done" onChange={(e) => { setTyped({ ask, text: e.target.value }); setKept(false); }}
          onFocus={(e) => e.currentTarget.select()} />
        {kept
          ? <div className="ask-text-note" role="status">Not closed, so what you typed is not lost. {ask.okLabel} uses it, Cancel drops it.</div>
          : ask.note && <div className="ask-text-note">{ask.note}</div>}
        <div className="bl-modal-actions">
          <button type="submit" className="send">{ask.okLabel}</button>
          <Button type="button" onClick={() => answer(null)}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}
