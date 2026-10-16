import { Lightbulb, SendHorizontal, X } from "lucide-react";
import { isShellSuggestion, SHELL_SUGGESTION_WHY } from "./cliSuggest";
import { track } from "./usage";

/**
 * The CLI's own proposal for the next prompt (`SessionInfo.cliSuggestion`),
 * as a tap — the dim words claude draws in an empty composer, which Tab takes
 * at the desk. Drawn where a person decides what to send next: under the
 * terminal, and on a Questions card. A shell proposal is shown but never a
 * button (`cliSuggest.ts`).
 *
 * `onSend` must be the durable compose path (queued, echo-checked, Return
 * proven host-side) — the proposal is ordinary prose to the CLI.
 */
export function CliSuggestion({ text, onSend, onDismiss, ev }: {
  text: string;
  onSend: (text: string) => void;
  /** Absent where the card is the place to dismiss from (Questions). */
  onDismiss?: () => void;
  /** Usage-event suffix: where the tap happened. */
  ev: string;
}) {
  const shell = isShellSuggestion(text);
  return (
    <div className="cli-sug">
      <div className="cli-sug-head">
        <Lightbulb size={13} />
        <span>Claude proposes{shell ? "" : " — Tab at the desk"}</span>
        {onDismiss && (
          <button className="cli-sug-x" aria-label="hide this proposal" onClick={() => { track(`action:${ev}.cliSuggest.hide`); onDismiss(); }}>
            <X size={14} />
          </button>
        )}
      </div>
      {shell ? (
        <>
          <div className="cli-sug-text">{text}</div>
          <div className="approve-hint">{SHELL_SUGGESTION_WHY}</div>
        </>
      ) : (
        <button className="cli-sug-send" onClick={() => { track(`action:${ev}.cliSuggest.send`); onSend(text); }}>
          <span className="cli-sug-text">{text}</span>
          <SendHorizontal size={15} />
        </button>
      )}
    </div>
  );
}
