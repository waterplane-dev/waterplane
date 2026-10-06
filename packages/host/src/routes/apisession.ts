/**
 * HTTP reads about one live session: the reader's transcript and the tool
 * details it withheld, the desktop's own scrollback, one background shell,
 * the context series — plus the slash-command list and the sessions this
 * daemon did not start. Documents somebody asked for, so HTTP, never the
 * socket. Moved out of `api.ts` (host-architecture.md, "api.ts — the HTTP
 * routes as tables").
 */
import { listSlashCommands } from "../slash.js";
import { discoverExternal } from "../discover.js";
import { json } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";

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

  route("GET", "/api/slash", ({ res, url }, ctx) => {
    const cwd = url.searchParams.get("cwd") || ctx.root;
    json(res, { commands: listSlashCommands(cwd) });
    return true;
  }),

  route("GET", "/api/external", async ({ res }, ctx) => {
    json(res, { sessions: await discoverExternal(ctx.sessions.managedPids()) });
    return true;
  }),
];
