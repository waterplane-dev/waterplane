import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { api } from "./api";
import { isAudio, isImage, isVideo } from "./docKind";
import { fmtBytes } from "@waterplane/shared";
import { Button } from "./kit/Button";
import { clampMediaZoom } from "./mediaZoom";

/** A changed file the git view draws as before/after instead of a text diff. */
export function isMediaDiff(path: string): boolean {
  return isImage(path) || isVideo(path) || isAudio(path);
}

type Side = "old" | "new";

/** What each side IS, worded off the diff that was opened: unstaged compares the
 *  index with the working tree, staged compares the last commit with the index. */
export function sideWords(side: Side, staged: boolean): string {
  if (side === "old") return staged ? "before · last commit" : "before · last commit or staged";
  return staged ? "after · staged" : "after · working tree";
}

type Loaded =
  | { state: "loading"; got: number; total: number }
  | { state: "absent" }
  | { state: "error"; reason: string }
  | { state: "ok"; url: string; size: number };

/**
 * One side of the pair. Fetched through the transport and shown from a blob
 * URL — the route is not an `<img src>` route (origin.ts `OPAQUE_READ_ROUTES`)
 * and must not become one for this.
 */
function MediaSide({ repoId, path, side, staged }: { repoId: string; path: string; side: Side; staged: boolean }) {
  const [got, setGot] = useState<Loaded>({ state: "loading", got: 0, total: 0 });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let url: string | null = null;
    const ac = new AbortController();
    setGot({ state: "loading", got: 0, total: 0 });
    const onProgress = (n: number, total: number) => { if (!ac.signal.aborted) setGot({ state: "loading", got: n, total }); };
    api.gitBlob(repoId, path, side, staged, onProgress, ac.signal).then(
      (b) => {
        if (ac.signal.aborted) return;
        if (!b) return setGot({ state: "absent" });
        url = URL.createObjectURL(b);
        setGot({ state: "ok", url, size: b.size });
      },
      (e: unknown) => { if (!ac.signal.aborted) setGot({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { ac.abort(); if (url) URL.revokeObjectURL(url); };
  }, [repoId, path, side, staged, attempt]);

  let body;
  if (got.state === "loading") {
    body = <div className="gm-note">loading… {got.got > 0 && (got.total ? `${fmtBytes(got.got)} of ${fmtBytes(got.total)}` : fmtBytes(got.got))}</div>;
  }
  else if (got.state === "absent") body = <div className="gm-note">{side === "old" ? "no file here — it is new" : "no file here — it was deleted"}</div>;
  else if (got.state === "error") {
    body = (
      <div className="gm-note">
        could not load this side: {got.reason}{" "}
        <Button onClick={() => setAttempt((n) => n + 1)}><RotateCw size={14} /> Retry</Button>
      </div>
    );
  }
  else if (isVideo(path)) body = <video src={got.url} controls loop muted playsInline />;
  else if (isAudio(path)) body = <audio src={got.url} controls />;
  else body = <img src={got.url} alt={sideWords(side, staged)} />;

  return (
    <figure className="gm-side">
      <figcaption>{sideWords(side, staged)}{got.state === "ok" && <span className="gm-size"> · {fmtBytes(got.size)}</span>}</figcaption>
      {body}
    </figure>
  );
}

/**
 * "Binary files differ", drawn: the file before and after, one above the other.
 *
 * `zoom` is a multiple of the fit width (`mediaZoom.ts`); the header's pair steps
 * it and a two-finger pinch anywhere on the pair sets it. The page viewport is
 * not zoomable (index.html `maximum-scale=1`), so the pinch is ours to handle:
 * `touch-action: pan-x pan-y` keeps one-finger scrolling native and hands the
 * second finger to these pointer handlers. The point under the fingers stays put.
 */
export function GitMediaDiff({ repoId, path, staged, zoom, onZoom }: {
  repoId: string; path: string; staged: boolean; zoom: number; onZoom(v: number): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; z: number } | null>(null);
  const zoomRef = useRef(zoom);
  // Scroll to apply once the new width has laid out (anchors the pinch midpoint).
  const anchor = useRef<{ mx: number; my: number; ratio: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    if (el && a) {
      el.scrollLeft = (el.scrollLeft + a.mx) * a.ratio - a.mx;
      el.scrollTop = (el.scrollTop + a.my) * a.ratio - a.my;
    }
    anchor.current = null;
    zoomRef.current = zoom;
  }, [zoom]);

  const pair = () => {
    const p = [...ptrs.current.values()];
    return p.length >= 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1 : null;
  };
  function down(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = pair();
    if (d) pinch.current = { dist: d, z: zoomRef.current };
  }
  function move(e: React.PointerEvent) {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = pair();
    const el = box.current;
    if (!d || !pinch.current || !el) return;
    const next = clampMediaZoom(pinch.current.z * (d / pinch.current.dist));
    if (Math.abs(next - zoomRef.current) < 0.02) return;
    const p = [...ptrs.current.values()];
    const r = el.getBoundingClientRect();
    anchor.current = { mx: (p[0].x + p[1].x) / 2 - r.left, my: (p[0].y + p[1].y) / 2 - r.top, ratio: next / zoomRef.current };
    zoomRef.current = next;
    onZoom(next);
  }
  function up(e: React.PointerEvent) {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
  }

  return (
    <div className="gm-diff" ref={box} style={zoom > 1 ? { ["--gm-zoom" as string]: String(zoom) } : undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <MediaSide repoId={repoId} path={path} side="old" staged={staged} />
      <MediaSide repoId={repoId} path={path} side="new" staged={staged} />
    </div>
  );
}
