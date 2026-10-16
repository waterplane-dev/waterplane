/**
 * "Are you sure?", once — and never through `window.confirm`.
 *
 * There were two idioms for one interaction. Three sheets (`ArchiveSheet`,
 * `SentLogSheet`, `SnippetSheet`) hand-rolled an ARMED TAP: a `useState`
 * boolean, a `danger` class, and a label that changes to "sure?" — different
 * state names, different labels, no disarm. Four other sites called
 * `window.confirm` instead, which is a NATIVE MODAL: it blocks the WebView's
 * whole event loop while it is up, it cannot be styled or read by the browser
 * automation this repo drives itself with, and in the Android shell it renders
 * as a system dialog stamped with the local asset server's origin — a security
 * prompt shape, for "delete this log entry?".
 *
 * So: one affordance, two shapes, because the interaction genuinely has two.
 *
 *   `ConfirmButton` — the destructive act is known when the button renders.
 *      Two taps on the same control: the first arms it and says what the second
 *      will do, the second does it. No layer, no focus trap, nothing to dismiss
 *      — which is what makes it the right default on a phone.
 *
 *   `askConfirm()` — the question arises MID-FLIGHT and cannot be a label: a
 *      host frame answering "this session has uncommitted work", a branch
 *      delete that came back "not fully merged" and needs force. There is no
 *      button to arm by then, so this is a real in-app dialog, promised like
 *      `window.confirm` was (`if (await askConfirm(…))`) and mounted once in
 *      `main.tsx` beside the toast and the hint layer — `App` returns early
 *      once per overlay, so a dialog rendered inside it would be missing from
 *      every sheet that asked for one.
 *
 * Both are DESTRUCTIVE-ONLY by construction: the armed state is `danger`-red
 * and the dialog's primary is too. An action that does not destroy anything
 * should not be behind either of them — a confirm on a harmless button is what
 * teaches people to tap through the ones that matter.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";

/**
 * How long an armed button stays armed.
 *
 * It has to disarm on its own. The hand-rolled versions never did, so a row
 * armed and then scrolled away from sat waiting indefinitely, and the next
 * accidental brush of that row DELETED a conversation — the exact failure the
 * two-tap rule exists to prevent, reintroduced by the half of it nobody wrote.
 * Six seconds is longer than a deliberate second tap and shorter than any
 * plausible "I came back to this screen".
 */
const ARM_MS = 6000;

// ── One armed button at a time, app-wide ────────────────────────────────
//
// `ArchiveSheet` got this right by accident: its arming state was the row ID,
// so arming row B disarmed row A. Per-instance state loses that, and a list
// with four rows each showing "delete for good?" is a list where the word has
// stopped meaning anything. Module-level, for the same reason the toast is.
let armedId: string | null = null;
let armTimer: ReturnType<typeof setTimeout> | undefined;
const armListeners = new Set<() => void>();

function setArmed(id: string | null): void {
  armedId = id;
  if (armTimer) clearTimeout(armTimer);
  armTimer = undefined;
  if (id) armTimer = setTimeout(() => { armedId = null; armTimer = undefined; for (const fn of armListeners) fn(); }, ARM_MS);
  for (const fn of armListeners) fn();
}

export interface ConfirmButtonProps {
  /** Resting label. */
  children: ReactNode;
  /** Armed label — what the NEXT tap will do, in its own words. Defaults to
   *  the bare "sure?" the hand-rolled versions used; a row that can say
   *  "delete for good?" instead should. */
  confirm?: ReactNode;
  /** Class on the button, minus the `danger` this adds when armed. */
  className?: string;
  title?: string;
  /** Title while armed. Falls back to `title`. */
  confirmTitle?: string;
  "aria-label"?: string;
  disabled?: boolean;
  /** The destructive act. Runs on the SECOND tap only. */
  onConfirm: () => void;
}

/**
 * A destructive button that needs two taps.
 *
 * `onConfirm` is deliberately named `on…` so `local/no-silent-send` still sees
 * through it: a socket write in here must still end in a toast or a queue
 * entry, exactly as it must in an `onClick`. Wrapping the handler in a
 * component is not a way out of that rule.
 */
export function ConfirmButton({ children, confirm = "sure?", className = "key", title, confirmTitle, disabled, onConfirm, ...rest }: ConfirmButtonProps) {
  const id = useId();
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    armListeners.add(fn);
    return () => { armListeners.delete(fn); if (armedId === id) setArmed(null); };
  }, [id]);
  const armed = armedId === id;
  return (
    <button
      className={armed ? `${className} danger` : className}
      title={armed ? (confirmTitle ?? title) : title}
      aria-label={rest["aria-label"]}
      disabled={disabled}
      onClick={() => {
        if (!armed) { setArmed(id); return; }
        setArmed(null);
        onConfirm();
      }}
    >
      {armed ? confirm : children}
    </button>
  );
}

// ── The dialog, for a question that arrives too late to be a label ──────

interface Ask {
  title: string;
  /** The body, already split into lines by the caller — a list of what will be
   *  lost reads as a list, and `window.confirm`'s `\n\n` never did. */
  lines: string[];
  confirmLabel: string;
  /** The other button's word — "Cancel" unless the question is not a
   *  destructive one (a disclosure's "Skip"). */
  cancelLabel: string;
  /** `info` for an explanation before a permission, which is not a warning and
   *  must not wear the red triangle. */
  tone: "warn" | "info";
  /** A "don't ask again" box under the question, worded by the caller; absent = none. */
  rememberLabel?: string;
  /** A third answer, drawn under the other two (`askChoice` only); absent = none. */
  altLabel?: string;
  /** `dismissed` = no button was pressed (backdrop, a second ask); `alt` = the
   *  third button was. */
  resolve: (ok: boolean, remember: boolean, dismissed: boolean, alt?: boolean) => void;
}

let pending: Ask | null = null;
const askListeners = new Set<(a: Ask | null) => void>();

function emitAsk(): void { for (const fn of askListeners) fn(pending); }

/**
 * Ask, and resolve on the answer. `false` when dismissed — same contract
 * `window.confirm` had, so migrating a call site is a rename plus an `await`.
 *
 * A second ask while one is up answers the first `false` rather than stacking:
 * two destructive questions on screen at once is a state with no right answer,
 * and the one already asked is the one the user has not agreed to.
 */
export function askConfirm(opts: {
  title: string; lines?: string[]; confirmLabel?: string; cancelLabel?: string; tone?: "warn" | "info";
}): Promise<boolean> {
  pending?.resolve(false, false, true);
  return new Promise<boolean>((resolve) => {
    pending = {
      title: opts.title, lines: opts.lines ?? [], confirmLabel: opts.confirmLabel ?? "Yes",
      cancelLabel: opts.cancelLabel ?? "Cancel", tone: opts.tone ?? "warn", resolve,
    };
    emitAsk();
  });
}

/**
 * `askConfirm` with a "don't ask again" box: resolves the answer AND whether the
 * box was ticked. Dismissing (backdrop, a second ask) is never remembered — the
 * person did not answer, so there is nothing to keep.
 */
export function askConfirmRemember(opts: {
  title: string; lines?: string[]; confirmLabel?: string; cancelLabel?: string; tone?: "warn" | "info";
  rememberLabel?: string;
}): Promise<{ ok: boolean; remember: boolean }> {
  pending?.resolve(false, false, true);
  return new Promise((resolve) => {
    pending = {
      title: opts.title, lines: opts.lines ?? [], confirmLabel: opts.confirmLabel ?? "Yes",
      cancelLabel: opts.cancelLabel ?? "Cancel", tone: opts.tone ?? "info",
      rememberLabel: opts.rememberLabel ?? "don't ask again",
      resolve: (ok, remember) => resolve({ ok, remember }),
    };
    emitAsk();
  });
}

/**
 * A choice between two ANSWERS, neither of which is "cancel" — so a dismissal
 * (backdrop, a second ask) is its own result, `null`, and never read as the
 * second button. With a "don't ask again" box when `rememberLabel` is given,
 * and a third answer when `altLabel` is (`alt: true`, `ok: false`).
 */
export function askChoice(opts: {
  title: string; lines?: string[]; confirmLabel: string; cancelLabel: string; tone?: "warn" | "info";
  rememberLabel?: string; altLabel?: string;
}): Promise<{ ok: boolean; remember: boolean; alt?: boolean } | null> {
  pending?.resolve(false, false, true);
  return new Promise((resolve) => {
    pending = {
      title: opts.title, lines: opts.lines ?? [], confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel, tone: opts.tone ?? "info", rememberLabel: opts.rememberLabel, altLabel: opts.altLabel,
      resolve: (ok, remember, dismissed, alt) => resolve(dismissed ? null : { ok, remember, ...(alt ? { alt: true } : {}) }),
    };
    emitAsk();
  });
}

/** Mounted once in `main.tsx`. Renders nothing when nothing is being asked. */
export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    askListeners.add(setAsk);
    setAsk(pending);
    return () => { askListeners.delete(setAsk); };
  }, []);
  // Each question starts unticked: a tick carried over from the last one would
  // remember an answer to a question the person never saw the box on.
  useEffect(() => { setRemember(false); }, [ask]);
  const answer = useCallback((ok: boolean, keep: boolean, dismissed = false, alt = false) => {
    const a = pending;
    pending = null;
    emitAsk();
    a?.resolve(ok, keep, dismissed, alt);
  }, []);
  if (!ask) return null;
  return (
    // The backdrop answers `false`, which is what a tap outside a destructive
    // question means everywhere else in this app (and what the native dialog's
    // dismiss did).
    <div className="bl-modal-backdrop confirm-backdrop" onClick={() => answer(false, false, true)}>
      <div className="bl-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bl-modal-title">
          {ask.tone === "info"
            ? <Info size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            : <AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: 6, color: "var(--dead)" }} />}
          {ask.title}
        </div>
        {ask.lines.length > 0 && (
          <ul className="confirm-lines">{ask.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        )}
        {ask.rememberLabel && (
          <label className="confirm-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {ask.rememberLabel}
          </label>
        )}
        <div className="bl-modal-actions">
          <button className={`send confirm-go${ask.tone === "info" ? " info" : ""}`} onClick={() => answer(true, remember)}>{ask.confirmLabel}</button>
          <button className="key" onClick={() => answer(false, remember)}>{ask.cancelLabel}</button>
          {ask.altLabel && <button className="key" onClick={() => answer(false, remember, false, true)}>{ask.altLabel}</button>}
        </div>
      </div>
    </div>
  );
}
