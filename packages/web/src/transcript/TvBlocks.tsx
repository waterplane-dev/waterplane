import { Fragment } from "react";
import { Brain, Terminal as TerminalIcon, Wrench } from "lucide-react";
import type { TranscriptTurn } from "@waterplane/shared";
import { Markdown } from "../Markdown";
import { blockText, matches } from "../transcriptUtil";
import { track } from "../usage";
import { rowsFor, toolTally } from "./tvRows";
import { Collapse, ToolRow } from "./tvParts";
import type { TvModel } from "./useTranscriptView";

/** One turn's blocks: prose, thinking, screen text, and the tool calls (folded in `fold` mode). */
export function TvBlocks({ m, t }: { m: TvModel; t: TranscriptTurn }) {
  const { toolsMode, openBlocks, q, toggleBlock, panelOpen, onShowCli, files, copy } = m;
  return (
    <>
      {rowsFor(t.blocks, toolsMode).map((row) => {
        const key = `${t.id}:${row.i}`;
        // A folded run of tool calls — one line where there were six.
        // Opening it reveals the same rows as before, still collapsed:
        // this row buys back screen space, it does not fetch anything.
        if (row.kind === "tools") {
          const open = openBlocks.has(key) || row.blocks.some((b) => matches(blockText(b), q));
          return (
            <Collapse key={key} open={open}
              onToggle={() => { if (!open) track("action:read.tools"); toggleBlock(key); }}
              head={
                <span className="tr-tools-head">
                  <Wrench size={12} /> <b>{row.blocks.length} tool calls</b>
                  <span className="tr-tool-label">{toolTally(row.blocks)}</span>
                  {row.blocks.some((b) => b.ok === false) && <span className="tag danger">error</span>}
                </span>
              }>
              <>{row.blocks.map((b, k) => <ToolRow key={`${key}:${k}`} m={m} t={t} b={b} k={`${key}:${k}`} />)}</>
            </Collapse>
          );
        }
        const b = row.block;
        // Screen text, verbatim: box drawing, hint rows and all. NOT
        // markdown — this is what the terminal printed, and a renderer
        // that eats a `*` or folds a table is telling a different story
        // than the one on the other screen.
        // `scrollable` is the CLI's own "↑/↓ to scroll" footer, kept as
        // evidence rather than stripped as furniture (host
        // `transcript.ts`). It is worded as what it is — the panel COULD
        // scroll — because the footer is printed whether or not anything
        // actually overflowed, and claiming lost text that was never
        // there is the wrong way to be wrong.
        if (b.kind === "screen") return (
          <Fragment key={key}>
            <pre className="tr-screen">{b.text}</pre>
            {b.scrollable && (
              <div className="tr-clipped">
                <span className="row-sub">
                  The CLI drew this in a panel it could scroll, and only the rows it painted
                  were recorded. Anything past them was never printed{panelOpen
                    ? " — the panel is still open in the CLI, so it can be scrolled there."
                    : ", and once that panel closes it is in no record at all."}
                </span>
                {panelOpen && (
                  <button className="key" onClick={() => { track("action:read.toCliScroll"); onShowCli(); }}>
                    <TerminalIcon size={13} /> scroll it in the CLI
                  </button>
                )}
              </div>
            )}
          </Fragment>
        );
        if (b.kind === "text") return <div className="tr-say" key={key}><Markdown src={b.text} q={q} onCopy={copy} files={files} /></div>;
        if (b.kind === "thinking") {
          const open = openBlocks.has(key) || matches(b.text, q);
          return (
            <Collapse key={key} open={open} onToggle={() => toggleBlock(key)}
              head={<span className="tr-think-head"><Brain size={12} /> thinking</span>}>
              <div className="tr-think"><Markdown src={b.text} q={q} onCopy={copy} files={files} /></div>
            </Collapse>
          );
        }
        return <ToolRow key={key} m={m} t={t} b={b} k={key} />;
      })}
    </>
  );
}
