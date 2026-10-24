/**
 * HTTP reads about one live session: the reader's transcript and the tool
 * details it withheld, the desktop's own scrollback, one background shell,
 * the context series — plus the slash-command list and the sessions this
 * daemon did not start. Documents somebody asked for, so HTTP, never the
 * socket. Moved out of `api.ts` (host-architecture.md, "api.ts — the HTTP
 * routes as tables").
 */
import { conversationTabNames, deleteArchived, deleteConversation, listArchive, listConversations, pageBounds, pickRefusal } from "../archive.js";
import { bookmarkStore } from "../bookmarks.js";
import { derive } from "../backends/derive.js";
import { resolveBackend } from "../backends/index.js";
import type { BackendDescriptor } from "../backends/types.js";
import { backendSlashCommands, listSlashCommands } from "../slash.js";
import { discoverExternal } from "../discover.js";
import { json } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";

/** The descriptor a `?backend=` names (absent ⇒ claude), or the sentence resolving it threw. */
function backendOf(id: string | null): BackendDescriptor | string {
  try { return resolveBackend(id || undefined); } catch (e) { return e instanceof Error ? e.message : "unknown backend"; }
}

export const SESSION_ROUTES: readonly ApiEntry[] = [
  // Structured conversation transcript for the reader view (the scrollable,
  // searchable alternative to the terminal). Parsed from the claude CLI's own
  // conversation log; falls back to the PTY-capture history. Big JSON, read-only
  // → HTTP, not the socket. `since` lets the client skip a refetch when nothing
  // changed (204 = unchanged).
  route("GET", "/api/transcript", ({ res, url }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const since = Number(url.searchParams.get("since") || 0);
    // Default `lite`: tool inputs/results are the overwhelming majority of a
    // busy conversation's bytes and the phone re-downloads and re-stores the
    // whole document on every change. `full` stays available for a caller that
    // wants the log in one piece.
    const detail = url.searchParams.get("detail") === "full" ? "full" : "lite";
    const doc = id ? ctx.sessions.getTranscript(id, since, detail) : null;
    if (!doc) { json(res, { error: "no transcript" }, 404); return true; }
    if (doc === "unchanged") {
      res.writeHead(204).end();
      return true;
    }
    json(res, doc);
    return true;
  }),

  // What this session's terminal has actually printed, as lines — the desktop's
  // own scrollback (`sessions.screenLines`, one real VT replay over the PTY
  // ring). The phone keeps a reconstruction of its own for the case this route
  // cannot be reached, and that copy duplicates blocks and misses others by
  // construction; with a link there is no reason to read it. Read-only, one
  // document somebody asked for → HTTP, never the socket.
  route("GET", "/api/scrollback", async ({ res, url }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const doc = id ? await ctx.sessions.screenLines(id) : null;
    if (!doc) { json(res, { error: "no such session" }, 404); return true; }
    json(res, { sessionId: id, ...doc, at: Date.now() });
    return true;
  }),

  // ONE background shell, opened on the shells sheet: its whole command (the
  // `SessionInfo` copy is capped) and the tail of what it printed. Read-only,
  // asked for by a person → HTTP, never the socket. `pid` only selects among
  // this session's own wrapper shells (`readShellDetail`).
  route("GET", "/api/shell", ({ res, url }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const pid = Number(url.searchParams.get("pid") || 0);
    const doc = id && Number.isInteger(pid) && pid > 0 ? ctx.sessions.shellDetail(id, pid) : null;
    if (!doc) { json(res, { error: "that shell is not running under this session any more" }, 404); return true; }
    json(res, { sessionId: id, ...doc, at: Date.now() });
    return true;
  }),

  // The two strings a `lite` document withheld, for ONE turn — what the reader
  // fetches when someone actually opens a tool call. Keyed by the turn's own id
  // (see transcript.ts: a turn NUMBER slides as the log grows).
  route("GET", "/api/transcript/tools", ({ res, url }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const turn = url.searchParams.get("turn") || "";
    const tools = id && turn ? ctx.sessions.getToolDetails(id, turn) : null;
    if (!tools) { json(res, { error: "no tool details" }, 404); return true; }
    json(res, { sessionId: id, turnId: turn, tools });
    return true;
  }),

  // How full this session's context window has been, over time — the same
  // conversation log the reader parses, read as a series instead of as turns
  // (`ctxlog.ts`). Read-only, big-ish, polled → HTTP with the transcript's own
  // `since` → 204 rule, so a quiet session costs a stat.
  route("GET", "/api/context", ({ res, url }, ctx) => {
    const id = url.searchParams.get("id") || "";
    const since = Number(url.searchParams.get("since") || 0);
    const doc = id ? ctx.sessions.getContextSeries(id, since) : null;
    if (!doc) { json(res, { error: "no context series" }, 404); return true; }
    if (doc === "unchanged") { res.writeHead(204).end(); return true; }
    json(res, doc);
    return true;
  }),

  // `<cwd>/.claude/commands/**` is a directory listing under whatever path the
  // query names, so `cwd` goes through the one gate (`containRepoDir`) like every
  // other directory a client names. A refused or absent one falls back to the
  // root — today's default — not to a 4xx: the composer's `/` list must keep
  // working, and the phone would have to word the refusal.
  //
  // `&backend=<id>` (2.2 `commands`): THAT backend's own list (`slash.ts`'s
  // `backendSlashCommands`) — validated whole, `{commands: [], why}` where it lists
  // none, fails or answers garbage, never claude's set in its place. An unknown id
  // is the same shape with the sentence, still a 200: the sheet says it, the
  // composer keeps working. No `backend` ⇒ exactly the answer this always gave.
  route("GET", "/api/slash", async ({ res, url }, ctx) => {
    const cwd = (await ctx.containRepoDir(url.searchParams.get("cwd"))) ?? ctx.root;
    const id = url.searchParams.get("backend");
    if (!id) { json(res, { commands: listSlashCommands(cwd) }); return true; }
    const b = backendOf(id);
    json(res, typeof b === "string" ? { commands: [], why: b } : await backendSlashCommands(b, cwd));
    return true;
  }),

  // A NON-claude backend's conversations (backend contract v2, the `conversations` slot): the same
  // listing the repo archive route answers for claude, read through the backend's own source and
  // asked for by backend id. `cwd` goes through the one gate. A backend that lists none: 404 in
  // words, never an empty archive. DELETE is the destructive twin (the phone confirms first).
  route("GET", "/api/conversations", async ({ res, url }, ctx) => {
    const b = backendOf(url.searchParams.get("backend"));
    if (typeof b === "string") { json(res, { error: b }, 400); return true; }
    const cwd = await ctx.containRepoDir(url.searchParams.get("cwd"));
    if (!cwd) { json(res, { error: "that directory is not a repo here" }, 400); return true; }
    // The same options the repo archive route builds — the person's tab names and bookmarks
    // included, or a plugin's rows lose both (review R9). `pageBounds` turns `?offset=x` into the
    // default page, never a NaN that slices an empty one.
    const opts = {
      ...pageBounds(url.searchParams.get("offset"), url.searchParams.get("limit")),
      q: url.searchParams.get("q") || "",
      bookmarked: url.searchParams.get("bookmarked") === "1",
      bookmarks: bookmarkStore(ctx.root).of(cwd),
      names: conversationTabNames(ctx.sessions.list(), ctx.sessions.listClosed()),
    };
    // claude's jsonl is a provider like any other: the same listing the repo archive route gives.
    const listing = (await listConversations(b, cwd, opts))
      ?? (derive(b).store("conversations") === "claude-jsonl" ? listArchive(cwd, opts) : null);
    if (!listing) { json(res, { error: pickRefusal(b) ?? "this backend lists no conversations right now" }, 404); return true; }
    json(res, listing);
    return true;
  }),

  route("DELETE", "/api/conversations", async ({ res, url }, ctx) => {
    const b = backendOf(url.searchParams.get("backend"));
    if (typeof b === "string") { json(res, { error: b }, 400); return true; }
    const cwd = await ctx.containRepoDir(url.searchParams.get("cwd"));
    if (!cwd) { json(res, { error: "that directory is not a repo here" }, 400); return true; }
    const id = url.searchParams.get("id") || "";
    const r = derive(b).store("conversations") === "claude-jsonl" ? deleteArchived(cwd, id) : await deleteConversation(b, cwd, id);
    // Deleting a conversation drops its bookmark with it, as the repo archive route does.
    if (r.ok) bookmarkStore(ctx.root).set(cwd, id, null);
    json(res, r, r.ok ? 200 : 400);
    return true;
  }),

  route("GET", "/api/external", async ({ res }, ctx) => {
    json(res, { sessions: await discoverExternal(ctx.sessions.managedPids()) });
    return true;
  }),
];
