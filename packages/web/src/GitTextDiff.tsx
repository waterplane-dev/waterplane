import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { api, copyText } from "./api";
import { track } from "./usage";
import { sideWords } from "./GitMediaDiff";
import { splitDiff, type SplitCell } from "./diffSplit";
import { Button } from "./kit/Button";
import { Markdown, type FileRefCtx } from "./Markdown";
import { isMarkdown } from "./docKind";
import { sized } from "./media";

/**
 * A changed text file, with the diff, both whole sides, and a rendered view
 * for Markdown.
 *
 * Side by side is the desktop's view: it is the default only where two columns
 * of code fit (`WIDE`), and offered everywhere — on a phone it wraps each line
 * inside its half rather than scrolling two columns sideways at once.
 */
export type DiffMode = "diff" | "split" | "old" | "new" | "rendered";
const MODES: { id: DiffMode; label: string }[] = [
  { id: "diff", label: "changes" },
  { id: "split", label: "side by side" },
  { id: "old", label: "before" },
  { id: "new", label: "after" },
  { id: "rendered", label: "rendered" },
];
const WIDE = "(min-width: 900px)";

export function initialDiffMode(): DiffMode {
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
function WholeSide({ repoId, path, side, staged, zoomFont, rendered, onOpenPath }: {
  repoId: string;
  path: string;
  side: "old" | "new";
  staged: boolean;
  zoomFont: CSSProperties;
  rendered?: boolean;
  onOpenPath?: (relPath: string) => void;
}) {
  const [got, setGot] = useState<Whole>({ state: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    setGot({ state: "loading" });
    api.gitText(repoId, path, side, staged, ac.signal).then(
      (t) => { if (!ac.signal.aborted) setGot(t ? { state: "ok", ...t } : { state: "absent" }); },
      (e: unknown) => { if (!ac.signal.aborted) setGot({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
    return () => ac.abort();
  }, [repoId, path, side, staged]);

  let body;
  if (got.state === "loading") body = <div className="gm-note">loading…</div>;
  else if (got.state === "absent") body = <div className="gm-note">{side === "old" ? "no file here — it is new" : "no file here — it was deleted"}</div>;
  else if (got.state === "error") body = <div className="gm-note">could not load this side: {got.reason}</div>;
  else if (rendered) {
    const files: FileRefCtx | undefined = onOpenPath ? {
      repoId,
      url: (relPath, width, mtime) => {
        const url = api.artifactUrl(repoId, relPath);
        return width ? sized(url, width, mtime) : url;
      },
      open: onOpenPath,
      docPath: path,
    } : undefined;
    body = (
      <>
        <div className="viewer-doc-body">
          <Markdown src={got.body} q="" onCopy={(text) => void copyText(text)} files={files} />
        </div>
        {got.truncated && <div className="gm-note">… cut here: the file is longer than the phone is sent</div>}
      </>
    );
  }
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
    <div className={rendered ? "git-rendered" : "diff dw"} style={zoomFont}>
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

export function GitTextDiff({ repoId, path, staged, diff, zoomFont, mode, onMode, onOpenPath }: {
  repoId: string;
  path: string;
  staged: boolean;
  diff: string;
  zoomFont: CSSProperties;
  mode: DiffMode;
  onMode: (mode: DiffMode) => void;
  onOpenPath?: (relPath: string) => void;
}) {
  let body;
  if (mode === "old" || mode === "new" || mode === "rendered") {
    body = <WholeSide repoId={repoId} path={path} side={mode === "old" ? "old" : "new"} staged={staged}
      zoomFont={zoomFont} rendered={mode === "rendered"} onOpenPath={onOpenPath} />;
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
      <div className="ts-filter git-modes">
        {MODES.filter((m) => m.id !== "rendered" || isMarkdown(path)).map((m) => (
          <Button key={m.id} className={mode === m.id ? "active" : ""}
            onClick={() => { track(`action:git.view.${m.id}`); onMode(m.id); }}>{m.label}</Button>
        ))}
      </div>
      {body}
    </>
  );
}
