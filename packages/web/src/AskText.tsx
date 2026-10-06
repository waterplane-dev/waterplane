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
  const [text, setText] = useState("");
  useEffect(() => {
    listeners.add(setAsk);
    setAsk(pending);
    return () => { listeners.delete(setAsk); };
  }, []);
  useEffect(() => { setText(ask?.initial ?? ""); }, [ask]);
  const answer = useCallback((value: string | null) => {
    const a = pending;
    pending = null;
    emit();
    a?.resolve(value && value.trim() ? value.trim() : null);
  }, []);
  if (!ask) return null;
  return (
    <div className="bl-modal-backdrop confirm-backdrop" onClick={() => answer(null)}>
      <form className="bl-modal confirm-modal" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); answer(text); }}>
        <div className="bl-modal-title">{ask.title}</div>
        <input className="ask-text-input" autoFocus value={text} placeholder={ask.placeholder}
          enterKeyHint="done" onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.currentTarget.select()} />
        {ask.note && <div className="ask-text-note">{ask.note}</div>}
        <div className="bl-modal-actions">
          <button type="submit" className="send">{ask.okLabel}</button>
          <button type="button" className="key" onClick={() => answer(null)}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
