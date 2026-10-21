import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { api } from "./api";
import { track } from "./usage";
import { sideWords } from "./GitMediaDiff";
import { splitDiff, type SplitCell } from "./diffSplit";
import { Button } from "./kit/Button";

/**
 * A changed text file, four ways: the unified diff, the same diff side by
 * side, and each whole side — "before" and "after" — as a file to read.
 *
 * Side by side is the desktop's view: it is the default only where two columns
 * of code fit (`WIDE`), and offered everywhere — on a phone it wraps each line
 * inside its half rather than scrolling two columns sideways at once.
 */
type Mode = "diff" | "split" | "old" | "new";
const MODES: { id: Mode; label: string }[] = [
  { id: "diff", label: "changes" },
  { id: "split", label: "side by side" },
  { id: "old", label: "before" },
  { id: "new", label: "after" },
];
const WIDE = "(min-width: 900px)";

function initialMode(): Mode {
  try { return window.matchMedia(WIDE).matches ? "split" : "diff"; } catch { return "diff"; }
}

/** Color a unified-diff line. */
function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "d-meta";
  if (line.startsWith("@@")) return "d-hunk";
  if (line.startsWith("+")) return "d-add";
  if (line.startsWith("-")) return "d-del";
  return "";
}

type Whole =
  | { state: "loading" }
  | { state: "absent" }
  | { state: "error"; reason: string }
  | { state: "ok"; body: string; truncated: boolean };

/** One whole side of the file, fetched when it is first asked for. */
function WholeSide({ repoId, path, side, staged, zoomFont }: { repoId: string; path: string; side: "old" | "new"; staged: boolean; zoomFont: CSSProperties }) {
  const [got, setGot] = useState<Whole>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setGot({ state: "loading" });
    api.gitText(repoId, path, side, staged).then(
      (t) => { if (live) setGot(t ? { state: "ok", ...t } : { state: "absent" }); },
      (e: unknown) => { if (live) setGot({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  }, [repoId, path, side, staged]);

  let body;
  if (got.state === "loading") body = <div className="gm-note">loading…</div>;
  else if (got.state === "absent") body = <div className="gm-note">{side === "old" ? "no file here — it is new" : "no file here — it was deleted"}</div>;
  else if (got.state === "error") body = <div className="gm-note">could not load this side: {got.reason}</div>;
  else {
    const lines = got.body.endsWith("\n") ? got.body.slice(0, -1).split("\n") : got.body.split("\n");
    body = (
      <div className="dw-lines">
        {lines.map((l, i) => (
          <Fragment key={i}><span className="dw-n">{i + 1}</span><span className="dw-t">{l || " "}</span></Fragment>
        ))}
        {got.truncated && <span className="dw-t gm-note">… cut here: the file is longer than the phone is sent</span>}
      </div>
    );
  }
  return (
    <div className="diff dw" style={zoomFont}>
      <div className="dw-cap">{sideWords(side, staged)}</div>
      {body}
    </div>
  );
}

function Cell({ c }: { c: SplitCell }) {
  if (!c) return <><span className="ds-n" /><span className="ds-t ds-empty" /></>;
  const cls = c.kind === "add" ? "d-add" : c.kind === "del" ? "d-del" : "";
  return <><span className={`ds-n ${cls}`}>{c.n}</span><span className={`ds-t ${cls}`}>{c.text || " "}</span></>;
}

export function GitTextDiff({ repoId, path, staged, diff, zoomFont }: { repoId: string; path: string; staged: boolean; diff: string; zoomFont: CSSProperties }) {
  const [mode, setMode] = useState<Mode>(initialMode);

  let body;
  if (mode === "old" || mode === "new") {
    body = <WholeSide repoId={repoId} path={path} side={mode} staged={staged} zoomFont={zoomFont} />;
  } else if (mode === "split") {
    body = (
      <div className="diff ds" style={zoomFont}>
        <div className="ds-grid">
          <span className="ds-cap">{sideWords("old", staged)}</span>
          <span className="ds-cap">{sideWords("new", staged)}</span>
          {splitDiff(diff).map((r, i) => r.kind === "line"
            ? <Fragment key={i}><Cell c={r.left} /><Cell c={r.right} /></Fragment>
            : <span key={i} className={`ds-wide ${r.kind === "hunk" ? "d-hunk" : "d-meta"}`}>{r.text}</span>)}
        </div>
      </div>
    );
  } else {
    body = (
      <pre className="diff" style={zoomFont}>
        {diff.split("\n").map((line, i) => (
          <div key={i} className={diffClass(line)}>{line || " "}</div>
        ))}
      </pre>
    );
  }

  return (
    <>
      <div className="ts-filter">
        {MODES.map((m) => (
          <Button key={m.id} className={mode === m.id ? "active" : ""}
            onClick={() => { track(`action:git.view.${m.id}`); setMode(m.id); }}>{m.label}</Button>
        ))}
      </div>
      {body}
    </>
  );
}
