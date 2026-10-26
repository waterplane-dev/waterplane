/**
 * The sidebar's words for what a session's FIRST request carried (`SessionCarried.firstRequestTok`,
 * read off the log by the host's ctxlog cursor), beside the Always-on view's estimate of the folder's
 * own files. Two different readings, never added together: the estimate is the folder's files at
 * ~4 characters a token; the first request is the CLI's measured input, which also holds the system
 * prompt, tool schemas, skill listing and this desktop's files. Absent ⇒ no clause, never a 0.
 */
import { fmtCount } from "@waterplane/shared";

interface Row { firstTok: number | null }

/** A session row's short clause: `first request 61k`, or null when unmeasured. */
export function firstShortWords(firstTok: number | null | undefined): string | null {
  return typeof firstTok === "number" && firstTok > 0 ? `first request ${fmtCount(firstTok)}` : null;
}

/** The newest listed session that measured its first request (rows come newest first). */
export function newestFirstTok(rows: readonly Row[]): number | null {
  return rows.find((r) => typeof r.firstTok === "number" && r.firstTok > 0)?.firstTok ?? null;
}

/**
 * The Always-on row's tooltip: the estimate and, when a session here measured it, the first request,
 * each said for what it is. `estimate` is the Claude every-request tokens from the folder's files
 * (null = Claude reads nothing here).
 */
export function alwaysOnTipWords(estimate: number | null, firstTok: number | null): string {
  const est = estimate != null
    ? `This folder's own instruction files: about ${fmtCount(estimate)} tokens on every Claude Code request (characters ÷ 4, an estimate).`
    : "Claude Code reads none of this folder's instruction files.";
  const first = firstTok != null
    ? ` The newest session here measured ${fmtCount(firstTok)} tokens on its first request — those files plus the system prompt, tool schemas, skill listing and this desktop's own files. The Session view splits it.`
    : " No session here has a measured first request yet.";
  return est + first;
}
