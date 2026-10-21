import { AlertTriangle, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { TranscriptToolDetail, TranscriptTurn } from "@waterplane/shared";
import { hl } from "../Markdown";
import { blockText, matches } from "../transcriptUtil";
import type { ToolBlock } from "./tvRows";
import type { TvModel } from "./useTranscriptView";
import { Button } from "../kit/Button";
import { Tag } from "../kit/Tag";

/** Collapsible assistant thinking / tool call. Force-opened while its content
 *  matches the current find, so a hit is never hidden behind a closed section. */
export function Collapse({ open, onToggle, head, children }: {
  open: boolean; onToggle: () => void; head: JSX.Element; children: JSX.Element | JSX.Element[];
}) {
  return (
    <div className={`tr-collapse${open ? " open" : ""}`}>
      <button className="tr-collapse-head" onClick={onToggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{head}
      </button>
      {open && <div className="tr-collapse-body">{children}</div>}
    </div>
  );
}

/**
 * One tool call's row. Identical in every mode; what differs is where its two
 * strings come from — inline in a `full` document, from `loadDetails` in a
 * lite one. Opening a withheld row is what triggers that fetch, so nothing is
 * downloaded for a tool call nobody looked at.
 */
export function ToolRow({ m, t, b, k }: { m: TvModel; t: TranscriptTurn; b: ToolBlock; k: string }) {
  const { openBlocks, q, details, loadDetails, toggleBlock } = m;
  const key = k;
  const open = openBlocks.has(key) || matches(blockText(b), q);
  const d = b.omitted ? details.get(t.id) : undefined;
  const det: TranscriptToolDetail | undefined = b.omitted
    ? (d?.state === "ok" ? d.tools[b.id] : undefined)
    : { input: b.input, result: b.result, ok: b.ok, resultTruncated: b.resultTruncated };
  // `ok` is set the moment a tool_result was matched back — the one piece of
  // "did this finish" a lite block still carries, so "still running" never
  // reads the same as "the text stayed on the host".
  const finished = b.ok !== undefined;
  return (
    <Collapse key={key} open={open}
      onToggle={() => { if (!open && b.omitted) void loadDetails(t); toggleBlock(key); }}
      head={
        <span className="tr-tool-head">
          <Wrench size={12} /> <b>{b.name}</b>
          <span className="tr-tool-label">{hl(b.label, q)}</span>
          {b.ok === false && <Tag tone="danger">error</Tag>}
        </span>
      }>
      <>
        {d?.state === "loading" && <div className="tr-pending">loading tool details…</div>}
        {d?.state === "error" && (
          <div className="tr-pending">
            <AlertTriangle size={12} /> {d.msg}{" "}
            <Button onClick={() => void loadDetails(t, true)}>retry</Button>
          </div>
        )}
        {det?.input && <pre className="tr-pre tr-in">{hl(det.input, q)}</pre>}
        {det?.result !== undefined && (
          <pre className="tr-pre">{hl(det.result, q)}{det.resultTruncated ? "\n… (truncated)" : ""}</pre>
        )}
        {det && det.result === undefined && (
          <div className="tr-pending">{finished ? "empty result" : "no result recorded"}</div>
        )}
      </>
    </Collapse>
  );
}
