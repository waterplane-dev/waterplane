/**
 * One row per background shell running under a session: what it is, what it
 * is doing (`shellWords`), and stop — CLAUDE.md's "closing the session stops
 * these too" said on the sheet, not only enforced at close time.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Repeat, Server, Square, SquareTerminal } from "lucide-react";
import type { SessionInfo, SessionShell } from "@waterplane/shared";
import { envName, shellBucket, shellWords, shellsChipText, shellsSummary } from "@waterplane/shared";
import { Sheet } from "../../Sheet";
import { Empty } from "../../Empty";
import { ConfirmButton } from "../../Confirm";
import { core } from "../../sdk";
import { api } from "../../api";
import { fmtSize } from "../../format";
import { agoText, useRemoteResource } from "../../useRemoteResource";
import { closeShells, killShell } from "./actions";

/** How often an OPEN row re-reads its output — a shell is live, and "what is
 *  it printing now" is the question that opened it. Only while open. */
const DETAIL_POLL_MS = 3000;

/**
 * The opened row: the whole command (the row's copy is capped at 240 chars
 * host-side) and the tail of what the shell printed, re-read while open.
 */
function ShellDetail({ subject, sh }: { subject: SessionInfo; sh: SessionShell }) {
  const res = useRemoteResource(`shell:${subject.id}:${sh.pid}`, () => api.shellDetail(subject.id, sh.pid));
  const { reload } = res;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) reload({ quiet: true }); }, DETAIL_POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  const d = res.data;
  const outRef = useRef<HTMLPreElement>(null);
  // Follow the tail like a terminal does — unless the reader has scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [d?.output]);
  return (
    <div className="shell-detail">
      <Empty res={res} empty={!d} thing="this shell" />
      {d && (
        <>
          <div className="row-sub">command</div>
          <pre className="shell-cmd">{d.command}</pre>
          <div className="row-sub">
            output
            {d.outputBytes !== undefined && <> · {fmtSize(d.outputBytes)}{d.truncated ? " (last 64 KB)" : ""}</>}
            {d.outputAt !== undefined && <> · written {agoText(Date.now() - d.outputAt)}</>}
          </div>
          {d.output === undefined
            ? <div className="row-sub">{d.outputWhy}</div>
            : d.output === ""
              ? <div className="row-sub">nothing printed — the command may send its output to a file of its own</div>
              : (
                <pre ref={outRef} className="shell-out"
                  onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
                  {d.output}
                </pre>
              )}
          {d.outputPath && <div className="row-sub mono shell-path">{d.outputPath}</div>}
        </>
      )}
    </div>
  );
}

/** description if present, else the command — the row's own label, same rule
 *  `shellCloseWords`' close sentence uses. */
const shellLabel = (sh: SessionShell) => sh.description || sh.command;

function ShellRow({ subject, sh, now }: { subject: SessionInfo; sh: SessionShell; now: number }) {
  const [open, setOpen] = useState(false);
  const bucket = shellBucket(sh, now);
  const Icon = sh.serverLike ? Server : sh.selfMatch ? Repeat : bucket === "quiet" ? AlertTriangle : SquareTerminal;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
    <div className="row-wrap">
      <button type="button" className="row grow" aria-expanded={open}
        onClick={() => { if (!open) core().say.track("action:shell.open"); setOpen(!open); }}>
        <span className="row-title"><Icon size={14} /> {shellLabel(sh)}</span>
        {!open && <span className="row-sub mono bl-text">{sh.command}</span>}
        <span className="row-sub">{shellWords(sh, now)}</span>
        <span className="row-sub"><Chevron size={12} /> {open ? "hide" : "full command and output"}</span>
      </button>
      {/* A `foreground` wrapper is not a background shell at all — it is the
          running turn's OWN command wearing the same `ps` shape (CLAUDE.md:
          never grey out a button to mean "not clickable" — this is the words
          on the row above saying why, and no button at all, never a disabled
          one). Otherwise: only offered once a `shellList` has actually
          arrived — the sheet renders nothing at all until then (capability
          by presence), so a row on screen is always one this build can act
          on. */}
      {!sh.foreground && (
        <ConfirmButton className="row-act" confirm="stop it?"
          title="stop this shell — its whole process group" confirmTitle="tap again to stop it"
          onConfirm={() => killShell(subject, sh)}>
          <Square size={16} />
        </ConfirmButton>
      )}
    </div>
    {open && <ShellDetail subject={subject} sh={sh} />}
    </>
  );
}

export function ShellsSheet({ subject }: { subject: SessionInfo }) {
  const list = subject.shellList;
  const now = Date.now();
  return (
    <Sheet title={`${subject.title} · shells`} icon={<SquareTerminal size={16} />} onClose={closeShells}>
      {!list && (
        <Empty>
          This build hasn't read this session's background shells yet — an older host, or the read is off
          (<code>{envName("SHELLS")}=0</code>). {subject.shells ? "The CLI's own record says shells ARE running here." : ""}
        </Empty>
      )}
      {list && list.length === 0 && <Empty>No background shells running right now.</Empty>}
      {list && list.length > 0 && (
        <>
          <div className="form-hint">{shellsChipText(shellsSummary(list, now))}</div>
          {list.map((sh) => <ShellRow key={sh.pid} subject={subject} sh={sh} now={now} />)}
          <div className="row-sub" style={{ padding: "8px 12px" }}>closing the session stops these too</div>
        </>
      )}
    </Sheet>
  );
}
