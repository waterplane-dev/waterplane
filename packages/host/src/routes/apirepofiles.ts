/**
 * The repo scope, `/api/repos/:id/…`, and its file routes: the conversation
 * archive, the inbox (listing, uploads, the read marker), the dotenv picker,
 * the outbox gallery and its read marker, the transport sweep, one artifact,
 * and the tree browser/editor. Moved out of `api.ts` (host-architecture.md,
 * "api.ts — the HTTP routes as tables"); the routes that RUN something are in
 * `apirepowork.ts`.
 */
import { logTag, sweepCounts, tally } from "@waterplane/shared";
import { findTarget } from "../repos.js";
import {
  markInboxSeen,
  markOutboxSeen,
  deleteArtifact,
  deleteInboxFile,
  discoverArtifactsAsync,
  listInbox,
  listTransport,
  saveInboxFile,
  statInTree,
  sweepTransport,
  type ArtifactKind,
} from "../files.js";
import { listDir, readTreeFile, searchTree, writeTreeFile } from "../tree.js";
import { archivedExists, archivedToolDetails, archivedTranscript, deleteArchived, listArchive } from "../archive.js";
import { bookmarkStore } from "../bookmarks.js";
import { isSecretFile } from "../git.js";
import { listEnvFiles } from "../secrets.js";
import { runExposureWatch } from "../exposurerun.js";
import { MAX_UPLOAD, headerFilename, json, parseMultipart, readBody, readJson, serveTreeFile } from "./apiio.js";
import { dispatchApi, route, type ApiCtx, type ApiEntry, type ApiRoute, type RepoReq } from "./apitable.js";
import { REPO_WORK_ROUTES } from "./apirepowork.js";
import { REPO_PR_ROUTES } from "./apiprs.js";

/**
 * How many paths one sweep may name.
 *
 * The measured worst case is a 523-file inbox, so this is not a limit anybody
 * reaches by tapping a chip — it is the bound on a body that arrives over HTTP
 * naming files to delete. Past it the request is REFUSED IN WORDS rather than
 * truncated: a sweep that silently dropped the tail would report success over
 * the files it never touched, and the reader has no way to see the difference.
 */
const SWEEP_MAX = 5000;

/**
 * The inbox file a request names, or null.
 *
 * The inbox is FLAT, so a name is one path segment and nothing else.
 * Decoding first and joining into `.claude/inbox/${name}` let
 * `..%2F..%2Fsrc/main.ts` resolve back inside the worktree — which
 * `contained` allows, since it only refuses leaving the WORKTREE — and
 * served any repo file with `anyType: true`, i.e. past the VIEWABLE
 * extension gate that exists for exactly this route. Worse, the raw path
 * still carried no literal `/`, so it went on matching the `inbox file`
 * entry in `origin.ts`'s OPAQUE_READ_ROUTES: the one deliberate
 * Origin-less exemption, widened to arbitrary reads.
 *
 * Called by EVERY inbox route before anything else, as the old code decoded
 * before it looked at the method: a name that does not decode throws, for
 * any verb.
 */
function inboxName(rest: readonly string[]): string | null {
  const raw = rest[0] ? decodeURIComponent(rest.join("/")) : null;
  return raw && !raw.includes("/") && !raw.includes("\\") && raw !== "." && raw !== ".." ? raw : null;
}

/**
 * Conversation id → the session's tab name, where this host still knows one:
 * a live session's first, then the newest closed row's. Never derived here —
 * a conversation with no recorded name stays without one.
 */
function tabNames(ctx: ApiCtx): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of ctx.sessions.list()) if (i.claudeSessionId && i.tabTitle) out.set(i.claudeSessionId, i.tabTitle);
  for (const c of ctx.sessions.listClosed()) if (c.claudeSessionId && c.tabTitle && !out.has(c.claudeSessionId)) out.set(c.claudeSessionId, c.tabTitle);
  return out;
}

const REPO_FILE_ROUTES: readonly ApiEntry<RepoReq>[] = [
  // ── Conversation archive: /api/repos/:id/archive ──────────────────
  // Closing a session keeps its conversation on disk; the reopen stack and the
  // recent list are capped shortlists, so this is the uncapped route back.
  // Read-only listing → GET; the delete is the one destructive verb here and
  // gets its own method.
  //
  // Bookmarks (R-conversations-007) and the read-only transcript come first:
  // `archive/*` would otherwise answer them as a listing / a delete.
  // POST sets or updates one ({id, note?, name?}); a live session's
  // conversation may have no log yet, so a live one in this worktree counts.
  route<RepoReq>("POST", "archive/bookmark", async ({ req, res, wt }, ctx) => {
    const body = await readJson(req);
    const id = typeof body?.id === "string" ? body.id : "";
    const live = ctx.sessions.list().some((i) => i.claudeSessionId === id && i.cwd === wt);
    if (!archivedExists(wt, id) && !live) { json(res, { ok: false, error: "no such conversation in this repo" }, 404); return true; }
    const store = bookmarkStore(ctx.root);
    const prev = store.get(wt, id);
    // An update keeps when it was first bookmarked; a field the body leaves
    // out keeps what it had, a field sent empty clears it.
    const b = store.set(wt, id, {
      at: prev?.at ?? Date.now(),
      note: "note" in (body ?? {}) ? body.note : prev?.note,
      name: "name" in (body ?? {}) ? body.name : prev?.name,
    });
    if (!b) { json(res, { ok: false, error: "bad bookmark" }, 400); return true; }
    json(res, { ok: true, id, bookmark: b });
    return true;
  }),
  route<RepoReq>("DELETE", "archive/bookmark", ({ res, url, wt }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const r = bookmarkStore(ctx.root).set(wt, id, null);
    if (r === undefined) { json(res, { ok: false, error: "bad id" }, 400); return true; }
    json(res, { ok: true, id });
    return true;
  }),
  // One archived conversation as the reader's document, read off its log —
  // nothing spawned, nothing spent. Same `since` → 204 and `detail` rules as
  // `/api/transcript`; `conv` is a bare id, the path is `transcriptPath`'s.
  route<RepoReq>("GET", "archive/transcript/tools", ({ res, url, wt }) => {
    const conv = url.searchParams.get("conv") || "";
    const turn = url.searchParams.get("turn") || "";
    const tools = archivedToolDetails(wt, conv, turn);
    if (!tools) { json(res, { error: "no tool details" }, 404); return true; }
    json(res, { sessionId: conv, turnId: turn, tools });
    return true;
  }),
  route<RepoReq>("GET", "archive/transcript", ({ res, url, wt }) => {
    const doc = archivedTranscript(wt, url.searchParams.get("conv") || "",
      Number(url.searchParams.get("since") || 0), url.searchParams.get("detail") === "full" ? "full" : "lite");
    if (!doc) { json(res, { error: "no transcript" }, 404); return true; }
    if (doc === "unchanged") { res.writeHead(204).end(); return true; }
    json(res, doc);
    return true;
  }),
  route<RepoReq>("GET", "archive/*", ({ res, url, wt }, ctx) => {
    json(res, listArchive(wt, {
      offset: Number(url.searchParams.get("offset") || 0),
      limit: Number(url.searchParams.get("limit") || 0) || undefined,
      q: url.searchParams.get("q") || "",
      bookmarked: url.searchParams.get("bookmarked") === "1",
      bookmarks: bookmarkStore(ctx.root).of(wt),
      names: tabNames(ctx),
    }));
    return true;
  }),
  // Deleting a conversation drops its bookmark with it.
  route<RepoReq>("DELETE", "archive/*", ({ res, url, wt }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const r = deleteArchived(wt, id);
    if (r.ok) bookmarkStore(ctx.root).set(wt, id, null);
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),

  route<RepoReq>("GET", "inbox/*", async ({ req, res, url, rest, wt }) => {
    const name = inboxName(rest);
    if (rest[0] && !name) { json(res, { error: "not found" }, 404); return true; }
    if (!name) {
      json(res, { files: listInbox(wt) });
      return true;
    }
    // Same download=1 / thumb=<w> contract as the artifact route (below):
    // the gallery's download button and thumbnails work on inbox files too.
    await serveTreeFile(req, res, wt, `.claude/inbox/${name}`, name, url, { anyType: true });
    return true;
  }),
  // Marking read is a write, so it gets its own POST rather than riding on
  // the listing GET: a cross-origin GET carries no Origin for the guard to
  // judge, and no `/api` GET should change state. See origin.ts.
  route<RepoReq>("POST", "inbox/seen", ({ res, wt }) => {
    markInboxSeen(wt);
    json(res, { ok: true });
    return true;
  }),
  route<RepoReq>("POST", "inbox/*", async ({ req, res, rest, target, wt }, ctx) => {
    inboxName(rest);
    const tooBig = () => {
      res.writeHead(413, { "content-type": "application/json", "connection": "close" });
      res.end(JSON.stringify({ error: "payload too large" }));
      req.resume(); // drain so the connection closes cleanly
    };
    if (Number(req.headers["content-length"] || 0) > MAX_UPLOAD) {
      tooBig();
      return true;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      tooBig();
      return true;
    }
    const ctype = req.headers["content-type"] || "";
    const saved: any[] = [];
    const skipped: any[] = [];
    const files = ctype.toLowerCase().startsWith("multipart/")
      ? parseMultipart(body, ctype)
      : [{ filename: headerFilename(req.headers["x-file-name"]), data: body }];
    // `x-dedupe: 1` marks a QUEUED upload being (re-)sent by the phone's send
    // queue: same name + same size already on disk means this exact upload
    // already landed, so answer with the file instead of writing a twin.
    const dedupe = String(req.headers["x-dedupe"] || "") === "1";
    for (const f of files) {
      const r = saveInboxFile(wt, f.filename, f.data, { dedupe });
      if ("error" in r) skipped.push({ name: f.filename, error: r.error });
      else saved.push(r);
      // The one place that knows an upload ARRIVED. Without this line the
      // only record of a phone upload is the file itself, so an image the
      // agent was told to look at and that is not on disk leaves nothing to
      // read: "the POST never happened" and "the POST was refused" look
      // identical from here, and both look like a client bug. One line per
      // file, and uploads are rare.
      console.log(`${logTag} inbox ${target.repoName} · ${f.filename} · ${f.data.length}B · ` +
        ("error" in r ? `REFUSED ${r.error}` : r.deduped ? "already there (re-send)" : "saved"));
    }
    // A session may have been waiting for exactly this file since before
    // the phone went into a tunnel. Ask the gate now rather than on the next
    // tick — this is the moment the answer changed.
    if (saved.length) ctx.launches.fileLanded(wt);
    json(res, { saved, skipped });
    return true;
  }),
  route<RepoReq>("DELETE", "inbox/*", ({ res, rest, wt }) => {
    const name = inboxName(rest);
    if (!name) return false;
    const ok = deleteInboxFile(wt, name);
    json(res, { ok }, ok ? 200 : 400);
    return true;
  }),
  // Not a route: the decode, for every other verb — see `inboxName`.
  route<RepoReq>("*", "inbox/*", ({ rest }) => {
    inboxName(rest);
    return false;
  }),

  // Candidate dotenv files for the set-secret picker (names + git flags, NO contents).
  route<RepoReq>("GET", "envfiles/*", ({ res, wt }) => {
    json(res, { files: listEnvFiles(wt) });
    return true;
  }),

  // Opening the outbox clears its unread badge. A write, so POST — same rule
  // as the inbox marker: no /api GET may change state (see origin.ts).
  route<RepoReq>("POST", "artifacts/seen", ({ res, wt }) => {
    markOutboxSeen(wt);
    json(res, { ok: true });
    return true;
  }),

  route<RepoReq>("GET", "artifacts/*", async ({ res, url, wt }) => {
    const scope = (url.searchParams.get("scope") as "repo" | "outbox") || "repo";
    const since = Number(url.searchParams.get("since") || 0) || undefined;
    const limit = Number(url.searchParams.get("limit") || 0) || undefined;
    const query = url.searchParams.get("q") || undefined;
    const fkind = (url.searchParams.get("kind") as ArtifactKind) || undefined;
    json(res, await discoverArtifactsAsync(wt, { scope, sinceSeconds: since, limit, query, kind: fkind }));
    return true;
  }),

  // ── Clearing out a transport directory ────────────────────────────
  // GET is the PLAN and writes nothing: every file in the directory with its
  // size and mtime, plus the per-age tallies the chips draw. The cut itself
  // is `shared/sweep.ts`, run on the phone, so the number on the chip and the
  // list it opens come from one function — see that module's note.
  route<RepoReq>("GET", "sweep/*", ({ res, url, wt }) => {
    const scope = url.searchParams.get("scope") === "inbox" ? "inbox" : "outbox";
    const rows = listTransport(wt, scope);
    json(res, { scope, rows, total: tally(rows), counts: sweepCounts(rows, Date.now()) });
    return true;
  }),

  // POST deletes, and takes the PATHS the person was shown — never an age for
  // this side to re-cut. `files.ts sweepTransport` states why; the short
  // version is that a set re-derived here is a set nobody approved.
  route<RepoReq>("POST", "sweep/*", async ({ req, res, wt }) => {
    const body = await readJson(req);
    const paths: unknown = body?.paths;
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
      json(res, { error: "paths must be an array of worktree-relative strings" }, 400);
      return true;
    }
    // A cap, and it is SAID rather than silently applied: a request naming
    // more files than this is not a sweep anybody composed by tapping.
    if (paths.length > SWEEP_MAX) {
      json(res, { error: `too many paths — ${paths.length}, cap is ${SWEEP_MAX}` }, 400);
      return true;
    }
    const out = sweepTransport(wt, paths as string[]);
    // 200 even with failures: the sweep ran and the body says exactly what
    // became of every path. A non-2xx here would make a partial success
    // indistinguishable from a refusal on the phone.
    json(res, out);
    return true;
  }),

  route<RepoReq>("GET", "artifact/*", async ({ req, res, url, wt }) => {
    const rel = url.searchParams.get("path") || "";
    // `stat=1` — the file's mtime and size, no bytes. This exists so a client
    // that only knows a PATH (a file mentioned in a transcript, an image
    // referenced by a backlog item) can build the same mtime-versioned thumb
    // URL the gallery builds from its listing: same URL ⇒ the same immutable
    // cache entry, on the device and in the service worker, instead of an
    // un-versioned one that no cache is allowed to keep (web/fileMtime.ts).
    if (url.searchParams.get("stat") === "1") {
      // Same viewability gate as the byte path: stat must not confirm the
      // existence of anything this route would refuse to serve.
      const st = statInTree(wt, rel);
      if (!st) { json(res, { error: "not found" }, 404); return true; }
      json(res, { mtime: st.mtime, size: st.size });
      return true;
    }
    // download=1 → force a save-as (Content-Disposition attachment) so a
    // notification tap downloads the file instead of rendering it inline.
    const name = rel.split("/").pop() || "artifact";
    await serveTreeFile(req, res, wt, rel, name, url);
    return true;
  }),

  route<RepoReq>("DELETE", "artifact/*", ({ res, url, wt }) => {
    const rel = url.searchParams.get("path") || "";
    const ok = deleteArtifact(wt, rel);
    json(res, { ok }, ok ? 200 : 400);
    return true;
  }),

  // ── Tree browse + edit: /api/repos/:id/tree[/file] ────────────────
  // The gallery's flat deliverables list can't answer "what is IN this repo";
  // this can, one directory per request. `tree.ts` holds the rules.
  route<RepoReq>("GET", "tree/file/*", ({ res, url, wt }) => {
    const p = url.searchParams.get("path") || "";
    if (isSecretFile(p)) {
      return json(res, { error: "this app doesn't display .env files — see the secrets sheet" }, 403), true;
    }
    const f = readTreeFile(wt, p);
    if (!f) return json(res, { error: "not found" }, 404), true;
    json(res, f);
    return true;
  }),
  // PUT, not POST: this replaces a named resource, and it must never be a
  // GET (origin.ts — no /api GET may change state).
  route<RepoReq>("PUT", "tree/file/*", async ({ req, res, wt }) => {
    const { path: p, body, baseSha } = await readJson(req, 4_000_000);
    const r = writeTreeFile(wt, String(p || ""), String(body ?? ""), String(baseSha || ""));
    json(res, r, r.ok ? 200 : r.code === "stale" ? 409 : 400);
    return true;
  }),
  route<RepoReq>("GET", "tree/*", async ({ res, url, rest, wt }) => {
    if (rest[0]) return false;   // `tree/file` is above; any other `tree/<x>` is nobody's
    const p = url.searchParams.get("path") || "";
    const q = url.searchParams.get("q") || "";
    const listing = q.trim() ? await searchTree(wt, p, q) : await listDir(wt, p);
    if (!listing) return json(res, { error: "not a directory" }, 404), true;
    json(res, listing);
    return true;
  }),
  // Re-check the exposure watch now (`exposurerun.ts`; beside the watch's accept/triage it would push
  // `apirepowork.ts` past its 500-line cap). Runs the model-free collector for this worktree's target,
  // one run per target (a second tap joins), up to 5 minutes; a POST because it spawns and writes.
  // 200 `{ ok, exit, sentence }` once it ran; 409, same shape + `refused: true`, when nothing ran.
  route<RepoReq>("POST", "exposure/run", async ({ res, target }) => {
    const r = await runExposureWatch(target.worktreePath);
    json(res, r, r.refused ? 409 : 200);
    return true;
  }),
];

/** The repo scope's table, in order. Only same-`kind` entries can shadow each other. */
const REPO_ROUTES: readonly ApiEntry<RepoReq>[] = [...REPO_FILE_ROUTES, ...REPO_WORK_ROUTES, ...REPO_PR_ROUTES];

/**
 * `/api/repos/:id/…`: resolve the target FIRST — an unknown id is a 404 for
 * every method and sub-path — then the repo's own table, matched against what
 * follows the id. Nothing matched ⇒ `false`, and the caller's 404.
 */
export const REPO_SCOPE: ApiRoute = {
  ...route("*", "/api/repos/:id/*", async ({ req, res, url, path, method, params, rest }, ctx) => {
    const target = await findTarget(ctx.root, params.id!);
    if (!target) return json(res, { error: "unknown repo" }, 404), true;
    return dispatchApi(REPO_ROUTES, { req, res, url, path, method, target, wt: target.worktreePath }, rest, ctx);
  }),
  sub: { prefix: "/api/repos/:id", table: REPO_ROUTES as readonly ApiEntry<never>[] },
};
