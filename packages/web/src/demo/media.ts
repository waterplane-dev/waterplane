/**
 * Where a host file's URL points in the demo (demo-mode-plan.md §2, `abs()`).
 *
 * An artifact or inbox file is loaded as a raw attribute — `<img src>`, a
 * download, a video poster — which never passes through a transport, so the
 * demo cannot answer it from the fake desktop. It is bundled media instead,
 * under `public/demo/media/<repoId>/<path>` (WP4 ships the files; a dot-named
 * segment is stored as `dot-…`, `bundledSegment`), served by
 * the same origin as the bundle. Pure; node-tested.
 *
 * Only the two raw-attribute shapes are mapped. A `stat=1` probe is a JSON
 * question asked through `fetch`, so it stays an `/api` URL and the fake
 * desktop answers it; every other `/api` URL is left alone for the same reason.
 */

/**
 * The bundled-media root. Vite's base comes first, so a static demo hosted under a sub-path
 * (`WATERPLANE_DEMO_BASE=/demo/`, GitHub Pages) finds its pictures; node tests have no
 * `import.meta.env` and get the root-hosted path.
 */
const BASE = (typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL) || "/";
export const DEMO_MEDIA_ROOT = `${BASE.replace(/\/$/, "")}/demo/media`;

const ARTIFACT = /^\/api\/repos\/([^/?#]+)\/artifact$/;
const INBOX = /^\/api\/repos\/([^/?#]+)\/inbox\/([^/?#]+)$/;

/**
 * Pictures uploaded INTO the demo this visit (the annotator's marked image),
 * by `<repoId>/<inbox file name>`. The fake desktop keeps no bytes, but the
 * page that sent them still holds them: the transport hands each upload's
 * object URL here, so the prompt that names the file can show the very marks
 * that were drawn. Page memory only — a reload forgets it, and the path then
 * falls back to the bundled-media URL like any other.
 */
const uploads = new Map<string, string>();

export function rememberDemoUpload(repoId: string, name: string, url: string): void {
  uploads.set(`${repoId}/${name}`, url);
}

const INBOX_REL = ".claude/inbox/";

/**
 * A path segment as it is STORED in the bundle. **No bundled file may sit under a
 * dot-named segment**: the Android build drops every hidden file and directory
 * from the APK's assets (aapt's `ignoreAssetsPattern` `.*`, `packages/app/android/app/build.gradle`),
 * so `public/demo/media/r1/.claude/outbox/x.png` existed in the browser and was
 * a 404 in the APK — an empty gallery and two "gone" downloads in the Play
 * build's demo. `.claude` is stored as `dot-claude`. Pure; the inverse is not
 * needed (nothing reads a bundled path back as a repo path).
 */
export function bundledSegment(seg: string): string {
  return seg.startsWith(".") ? `dot-${seg.slice(1)}` : seg;
}

/** A repo-relative path as it is stored under `public/demo/media/<repoId>/`. */
export function bundledRel(rel: string): string {
  return rel.split("/").map(bundledSegment).join("/");
}

/** Each segment of a repo-relative path, as stored in the bundle and encoded; `..` and empty segments refused. */
function encodePath(rel: string): string | null {
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  return parts.map((p) => encodeURIComponent(bundledSegment(p))).join("/");
}

/** `url` as bundled media, or `url` unchanged when it is not a host file. */
export function demoMediaUrl(url: string): string {
  if (!url.startsWith("/api/")) return url;
  let u: URL;
  try { u = new URL(url, "http://demo.invalid"); } catch { return url; }
  if (u.searchParams.has("stat")) return url;
  const art = ARTIFACT.exec(u.pathname);
  if (art) {
    const path = u.searchParams.get("path") ?? "";
    const kept = path.startsWith(INBOX_REL) ? uploads.get(`${art[1]}/${path.slice(INBOX_REL.length)}`) : undefined;
    if (kept) return kept;
    const rel = encodePath(path);
    return rel ? `${DEMO_MEDIA_ROOT}/${art[1]}/${rel}` : url;
  }
  const inbox = INBOX.exec(u.pathname);
  if (inbox) {
    const kept = uploads.get(`${inbox[1]}/${decodeURIComponent(inbox[2])}`);
    if (kept) return kept;
    const name = encodePath(decodeURIComponent(inbox[2]));
    return name ? `${DEMO_MEDIA_ROOT}/${inbox[1]}/${bundledRel(".claude/inbox")}/${name}` : url;
  }
  return url;
}
