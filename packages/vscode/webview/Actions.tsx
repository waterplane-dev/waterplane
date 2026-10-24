import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, SquareTerminal } from "lucide-react";
import type { PromptId, ToExtension, ToWebview } from "../src/protocol";
import { Absent } from "./Absent";
import { Button } from "@waterplane/kit";

let taps = 0;

/**
 * [Copy] and [Type into terminal] for one optimisation prompt. Nothing here applies anything: the
 * text goes to the clipboard, or into the active terminal as ONE line WITHOUT a newline. With no
 * terminal the second button is not drawn — a sentence says why.
 *
 * One receipt per tap, and it is the extension's: it posts what actually happened (copied, typed
 * into which terminal, or why not) after acting, tagged with this tap's id. Nothing is guessed here.
 */
export function PromptActions({ id, turn, terminal, post }: {
  id: PromptId;
  turn?: number;
  terminal: string | null;
  post: (m: ToExtension) => void;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const mine = useRef<number | null>(null);

  useEffect(() => {
    const on = (e: MessageEvent<ToWebview>) => {
      const m = e.data;
      if (m && typeof m === "object" && m.t === "receipt" && m.tap != null && m.tap === mine.current) setSaid(m.text);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  const send = (how: "copy" | "terminal") => {
    const tap = ++taps;
    mine.current = tap;
    setSaid(null);
    post({ t: "prompt", id, how, tap, ...(turn != null ? { turn } : {}) });
  };
  return (
    <div className="prompt-actions">
      <div className="btn-row">
        <Button type="button" onClick={() => send("copy")}>
          <ClipboardCopy size={14} aria-hidden /> Copy
        </Button>
        {terminal != null && (
          <Button type="button" onClick={() => send("terminal")}>
            <SquareTerminal size={14} aria-hidden /> Type into terminal
          </Button>
        )}
      </div>
      {terminal == null && <Absent>No terminal is open, so this can only be copied. Open one to type it there.</Absent>}
      <div className="said" role="status" aria-live="polite">{said}</div>
    </div>
  );
}
