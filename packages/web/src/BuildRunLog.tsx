/**
 * An open build run's log pane and the two verbs over it: copy the log, and
 * hand it to a new session in this repo (`buildLogPrompt.ts` — a Send-sheet
 * seed, nothing sent by the tap). Split out of `BuildSheet.tsx` at its cap.
 */
import type { RefObject } from "react";
import { Copy, SquareTerminal } from "lucide-react";
import type { BuildRun } from "@waterplane/shared";
import { copyText } from "./api";
import { showToast } from "./toast";
import { track } from "./usage";
import { durSpan } from "./format";
import { BUILD_LOG_COPIED, BUILD_LOG_COPY_FAILED, BUILD_LOG_COPY_LABEL, BUILD_LOG_SEND_LABEL } from "./buildLogPrompt";

interface Props {
  r: BuildRun;
  /** The run's output, ANSI already stripped. */
  text: string;
  logRef: RefObject<HTMLPreElement>;
  /** Absent ⇒ the send button is absent. */
  onSendLog?: (r: BuildRun, log: string, took: string) => void;
}

export function BuildRunLog({ r, text, logRef, onSendLog }: Props) {
  return (
    <>
      {/* ABOVE the log: the log is 45vh of its own scroll. Absent with nothing
          kept — copying an empty pane is no verb. */}
      {text.trim() && (
        <div className="sheet-actions build-log-acts">
          <button className="key" onClick={async () => {
            track("action:build.copyLog");
            showToast(await copyText(text) ? BUILD_LOG_COPIED : BUILD_LOG_COPY_FAILED);
          }} title="copy this run's output to the clipboard">
            <Copy size={16} /> {BUILD_LOG_COPY_LABEL}
          </button>
          {onSendLog && (
            <button className="key" onClick={() => {
              track("action:build.sendLog");
              onSendLog(r, text, durSpan(r.startedAt, r.finishedAt));
            }} title="open the Send sheet with this log, the command and its exit, aimed at a new session in this repo — nothing is sent yet">
              <SquareTerminal size={16} /> {BUILD_LOG_SEND_LABEL}
            </button>
          )}
        </div>
      )}
      <pre className="build-log" ref={logRef}>{text || logEmptyText(r)}</pre>
    </>
  );
}

/**
 * What an open run's log pane says when there is no output to show — three
 * different facts. The host keeps a run's output in memory only, so after a
 * daemon restart a finished run has none, and "(no output yet)" under a run
 * that ended yesterday promised something that was never coming.
 */
function logEmptyText(r: BuildRun): string {
  if (r.status === "running") return "(no output yet)";
  return "(no output kept — the desktop holds a run's output in memory, so a restart since it ran clears it; or the command printed nothing)";
}
