import { useEffect, useState } from "react";
import { api } from "./api";
import { isAudio, isImage, isVideo } from "./docKind";
import { fmtBytes } from "@waterplane/shared";

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
  | { state: "loading" }
  | { state: "absent" }
  | { state: "error"; reason: string }
  | { state: "ok"; url: string; size: number };

/**
 * One side of the pair. Fetched through the transport and shown from a blob
 * URL — the route is not an `<img src>` route (origin.ts `OPAQUE_READ_ROUTES`)
 * and must not become one for this.
 */
function MediaSide({ repoId, path, side, staged }: { repoId: string; path: string; side: Side; staged: boolean }) {
  const [got, setGot] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    setGot({ state: "loading" });
    api.gitBlob(repoId, path, side, staged).then(
      (b) => {
        if (!live) return;
        if (!b) return setGot({ state: "absent" });
        url = URL.createObjectURL(b);
        setGot({ state: "ok", url, size: b.size });
      },
      (e: unknown) => { if (live) setGot({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [repoId, path, side, staged]);

  let body;
  if (got.state === "loading") body = <div className="gm-note">loading…</div>;
  else if (got.state === "absent") body = <div className="gm-note">{side === "old" ? "no file here — it is new" : "no file here — it was deleted"}</div>;
  else if (got.state === "error") body = <div className="gm-note">could not load this side: {got.reason}</div>;
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

/** "Binary files differ", drawn: the file before and after, one above the other. */
export function GitMediaDiff({ repoId, path, staged }: { repoId: string; path: string; staged: boolean }) {
  return (
    <div className="gm-diff">
      <MediaSide repoId={repoId} path={path} side="old" staged={staged} />
      <MediaSide repoId={repoId} path={path} side="new" staged={staged} />
    </div>
  );
}
