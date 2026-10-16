import { timedFetch, TRANSCRIPT_TIMEOUT_MS } from "@waterplane/shared";
import type { ContextSeriesDoc, ExternalSession, RepoTarget, SessionShellDetail, TranscriptDoc, TranscriptToolDetail } from "@waterplane/shared";
import { nfetch, jget } from "./webapiFetch";
import { readJsonFused } from "./webapiBody";
import type { SlashCommand } from "./webapiTypes";

/** Sessions, transcripts and the reader's reads. One slice of `api` (see api.ts). */
export const sessionsApi = {
  repos: () => jget<{ targets: RepoTarget[] }>("/api/repos").then((d) => d.targets),

  slash: (cwd: string) =>
    jget<{ commands: SlashCommand[] }>(`/api/slash?cwd=${encodeURIComponent(cwd)}`).then((d) => d.commands),

  external: () => jget<{ sessions: ExternalSession[] }>("/api/external").then((d) => d.sessions),

  /** Structured conversation transcript for the reader view. `since` = the
   *  updatedAt we already hold; the host answers 204 (→ null) when unchanged,
   *  so polling a quiet session costs nothing. */
  transcript: async (sessionId: string, since?: number, detail: "lite" | "full" = "lite"): Promise<TranscriptDoc | null> => {
    const q = new URLSearchParams({ id: sessionId });
    if (since) q.set("since", String(since));
    // `lite` (the default, and what the reader asks for unless the user picked
    // "full details") leaves tool inputs/results on the host; they come from
    // `transcriptTools` when someone opens one. See transcriptUtil's
    // ReaderToolsMode for the three settings behind this.
    if (detail === "full") q.set("detail", "full");
    // Raw `timedFetch`, not `nfetch`: a background poll must not blink the
    // NetActivity bar (see the note on nfetch). The FUSE, though, is not
    // optional here — this is the request whose hang leaves the reader on
    // "loading transcript…" instead of falling back to the cached document.
    // It covers the headers only, so the body takes a stall fuse of its own.
    const r = await timedFetch(`/api/transcript?${q}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (r.status === 204) return null; // unchanged since `since`
    if (!r.ok) throw new Error(`${r.status} transcript`);
    return readJsonFused<TranscriptDoc>(r, TRANSCRIPT_TIMEOUT_MS);
  },

  /**
   * What the session's terminal has actually printed, as lines, off the
   * DESKTOP (host `sessions.screenLines`).
   *
   * Both ends record the same way and from the same pure rule; the daemon is
   * simply the better vantage point — it is watching every session, always,
   * where this device only sees one at a time and only while it is awake. What
   * it CANNOT do is derive the history after the fact: the CLI draws in the
   * alternate screen, so a replay of the raw bytes is one screen however long
   * the session has run. Hence `history`, which says whether the desktop has
   * anything beyond the current grid — a freshly restarted daemon has not, and
   * its one screen must not replace an archive this phone has been keeping for
   * an hour. `nfetch` because it runs on a tap and is worth a line in the
   * activity bar.
   */
  scrollback: async (sessionId: string): Promise<{ lines: string[]; history: boolean; bounded: boolean; at: number }> => {
    const r = await nfetch(`/api/scrollback?id=${encodeURIComponent(sessionId)}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (!r.ok) throw new Error(`${r.status} scrollback`);
    const d = await readJsonFused<{ lines?: string[]; history?: boolean; bounded?: boolean; at?: number }>(r, TRANSCRIPT_TIMEOUT_MS);
    // `history` absent is a host one version behind, and the honest reading of
    // that is "it did not say" — which must not be taken as a promise, because
    // the caller decides whether to DROP this device's own archive for it.
    return { lines: d.lines ?? [], history: !!d.history, bounded: !!d.bounded, at: d.at ?? Date.now() };
  },

  /** The input/result pair a `lite` transcript withheld, for one turn, keyed by
   *  tool_use id. Same fuse as the transcript fetch: this runs on a tap, so a
   *  hang has to become "couldn't load" rather than a spinner that never ends. */
  transcriptTools: async (sessionId: string, turnId: string): Promise<Record<string, TranscriptToolDetail>> => {
    const q = new URLSearchParams({ id: sessionId, turn: turnId });
    const r = await timedFetch(`/api/transcript/tools?${q}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (!r.ok) throw new Error(`${r.status} tool details`);
    const d = await readJsonFused<{ tools?: Record<string, TranscriptToolDetail> }>(r, TRANSCRIPT_TIMEOUT_MS);
    return d.tools ?? {};
  },

  /** One background shell's whole command and output tail (host
   *  `readShellDetail`). Runs on a tap and then every few seconds while the row
   *  stays open, so `timedFetch`: a hang becomes "couldn't load", and a poll
   *  does not fill the activity bar. 404 = that shell is gone. */
  shellDetail: async (sessionId: string, pid: number): Promise<SessionShellDetail & { at: number }> => {
    const q = new URLSearchParams({ id: sessionId, pid: String(pid) });
    const r = await timedFetch(`/api/shell?${q}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error || `${r.status} shell`);
    }
    return readJsonFused<SessionShellDetail & { at: number }>(r, TRANSCRIPT_TIMEOUT_MS);
  },

  /**
   * How full a session's context window has been, over time — parsed from the
   * same conversation log as the transcript (host `ctxlog.ts`). Same `since`
   * → 204 (→ null) rule, so the graph can poll a quiet session for a stat.
   *
   * `nfetch`, not `timedFetch`: unlike the transcript poll this runs on a TAP
   * and takes a visible moment on a 20 MB log, so it belongs in the activity
   * bar. The fuse is not optional either way.
   */
  contextSeries: async (sessionId: string, since?: number): Promise<ContextSeriesDoc | null> => {
    const q = new URLSearchParams({ id: sessionId });
    if (since) q.set("since", String(since));
    const r = await nfetch(`/api/context?${q}`, undefined, TRANSCRIPT_TIMEOUT_MS);
    if (r.status === 204) return null; // unchanged since `since`
    if (!r.ok) throw new Error(`${r.status} context series`);
    return readJsonFused<ContextSeriesDoc>(r, TRANSCRIPT_TIMEOUT_MS);
  },
};
