import { useMemo, useState } from "react";
import { List, RotateCw, Search } from "lucide-react";
import type { ArchivedConversation } from "@waterplane/shared";
import { api } from "./api";
import { TranscriptView } from "./TranscriptView";
import type { TranscriptSource } from "./transcript/tvTypes";
import { readerToolsMode } from "./transcriptUtil";
import { archiveRowLines } from "./core/sessions/bookmarkFacts";
import { Button, Hint, SheetHead } from "./kit";

const ICON = 16;

/**
 * One ARCHIVED conversation in the reader (R-conversations-007), read-only.
 *
 * The same `TranscriptView` a live session reads in, fed by the archive's own
 * route (`source`) instead of a session id: the conversation's log, parsed on
 * the desktop. Nothing is spawned, nothing is spent, and there is no terminal —
 * so the view has no status strip, no answer card and no "open the CLI". What
 * the person can DO with it is the one verb in the strip under the head:
 * resume (or jump to it, when it is already open).
 *
 * The reader's own verbs (outline, find, refresh) are toolbar actions in a live
 * session; here there is no toolbar, so the head carries them.
 */
export function ArchiveReader({ repoId, row, live, onBack, onResume, onToast }: {
  repoId: string;
  row: ArchivedConversation;
  /** Already open as a live session: the verb jumps there instead. */
  live: boolean;
  onBack: () => void;
  onResume: () => void;
  onToast: (msg: string) => void;
}) {
  const [cmd, setCmd] = useState<{ kind: "outline" | "find" | "refresh"; key: number } | undefined>();
  const fire = (kind: "outline" | "find" | "refresh") => setCmd((c) => ({ kind, key: (c?.key ?? 0) + 1 }));
  const [toolsMode] = useState(readerToolsMode);
  const source = useMemo<TranscriptSource>(() => ({
    transcript: (since, detail) => api.archivedTranscript(repoId, row.id, since, detail),
    tools: (turnId) => api.archivedToolDetails(repoId, row.id, turnId),
  }), [repoId, row.id]);
  const { title } = archiveRowLines(row);
  return (
    <div className="sheet">
      <SheetHead title={title || "conversation"} onClose={onBack}>
        <span className="head-acts tight">
          <Button title="outline — one row per turn" onClick={() => fire("outline")}><List size={ICON} /></Button>
          <Button title="find in this conversation" onClick={() => fire("find")}><Search size={ICON} /></Button>
          <Button title="re-read the conversation" onClick={() => fire("refresh")}><RotateCw size={ICON} /></Button>
        </span>
      </SheetHead>
      <Hint>
        Read-only — this is the conversation's log on the desktop. Nothing is running and reading it spends nothing.
        {" "}<Button variant="primary" onClick={onResume}>{live ? "open it" : "resume"}</Button>
      </Hint>
      <div className="arch-reader">
        <TranscriptView sessionId={row.id} source={source} refreshKey={0} toolsMode={toolsMode} cmd={cmd} onToast={onToast} />
      </div>
    </div>
  );
}
