/**
 * The Send-sheet seeds the Opt-ins region (`OptInRegion.tsx`) hands over, and
 * the few words that region says of its own. Pure, no React; pinned by
 * `optInSeed.test.mjs`.
 *
 * **A seed is not a send.** An `agent` offer seeds its prompt at a new session
 * in this repo; a `schedule` offer seeds the same plus a standing weekly clock
 * in the PHONE's zone, the catalog's model and `waitUntilFree` — and the person
 * sees and can change every one of those on the Send sheet before anything
 * goes. The catalog and its wording are `shared/optins.ts`'s.
 */
import { optInDef, optInPrompt, optInRule, optInWalkPrompt } from "@waterplane/shared";
import type { OptInRow, OptInSent, RepoTarget } from "@waterplane/shared";
import type { SendSeed } from "./sendIntent/sendTypes.ts";

type SeedRepo = Pick<RepoTarget, "id" | "repoName" | "worktreePath">;

/** Where a seed from this region says it came from. */
export function optInOrigin(repoName: string, label: string): string {
  return `From ${repoName}'s opt-ins — ${label}`;
}

/**
 * The seed for one `agent` or `schedule` offer, or `null` for an offer the
 * agent does not run (`fix`/`open`, or an id this phone has no words for).
 * `tz` is the phone's IANA zone: "Monday 09:00" means the person's Monday.
 */
export function optInSeed(id: string, repo: SeedRepo, tz: string): SendSeed | null {
  const def = optInDef(id);
  const prompt = optInPrompt(id, repo.repoName);
  if (!def || prompt == null) return null;
  const a = def.action;
  if (a.kind !== "agent" && a.kind !== "schedule") return null;
  const base: SendSeed = {
    prompts: [prompt],
    target: { kind: "repo", cwd: repo.worktreePath },
    cwdHint: repo.worktreePath,
    repoId: repo.id,
    origin: optInOrigin(repo.repoName, def.title),
  };
  if (a.kind === "agent") return base;
  const rule = optInRule(id, tz || "UTC");
  if (!rule) return null;
  return {
    ...base,
    target: { kind: "repo", cwd: repo.worktreePath, launch: { model: a.model } },
    when: { kind: "at", rule, graceMin: a.graceMin, name: def.title, waitUntilFree: true },
  };
}

/** Offers an agent can POST (`agent`/`schedule`) — the walk-through's reason to exist. */
export function postableOptIns(offered: readonly OptInRow[]): OptInRow[] {
  return offered.filter((r) => {
    const k = optInDef(r.id)?.action.kind;
    return k === "agent" || k === "schedule";
  });
}

/** The walk-through is offered only when an agent could post at least two. */
export function walkOffered(offered: readonly OptInRow[]): boolean {
  return postableOptIns(offered).length >= 2;
}

/** The button's words. N is EVERY offered card, because the prompt names every
 *  one (the tap-only ones as "just say whether they fit") — a count on a
 *  control is the list it acts on. */
export function walkLabel(n: number): string {
  return `walk me through these ${n}…`;
}

/** The walk-through as a seed: one new session in this repo that interviews
 *  and posts each picked offer as its OWN work item. `null` with nothing offered. */
export function optInWalkSeed(offered: readonly OptInRow[], repo: SeedRepo): SendSeed | null {
  const prompt = optInWalkPrompt(offered, repo.repoName);
  if (prompt == null) return null;
  return {
    prompts: [prompt],
    target: { kind: "repo", cwd: repo.worktreePath },
    cwdHint: repo.worktreePath,
    repoId: repo.id,
    origin: optInOrigin(repo.repoName, `walk through ${offered.length} offers`),
  };
}

/** The folded lists' heads — the count IS the list each one opens. */
export function declinedHead(n: number): string {
  return `${n} you said not for me`;
}
export function unfitHead(n: number): string {
  return `${n} ${n === 1 ? "doesn't" : "don't"} fit this repo`;
}

/** The started list's head and its one-line guide. */
export function startedHead(n: number): string {
  return `Started here · ${n}`;
}
export const STARTED_GUIDE =
  "You began these in this repo, and the desktop does not see them set up yet. Sending one again starts it over.";

/** The day a send is named by, in the phone's own words — "24 Oct". */
export function sentDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** What became of the last send, one sentence — the host's status, never re-guessed here. */
export function optInSentWords(sent: OptInSent, day: (at: number) => string = sentDay): string {
  const on = `Sent ${day(sent.at)}`;
  switch (sent.status) {
    case "waiting": return `${on} — waiting in this repo's backlog.`;
    case "running": return `${on} — running now.`;
    case "open": return `${on} to a session that is still open.`;
    case "done": return `${on} — that run finished, but it is not set up yet.`;
    case "failed": return `${on} — that run failed.`;
    case "canceled": return `${on} — that row was cancelled.`;
    case "ended": return `${on} — that session has closed, and it is not set up yet.`;
  }
}

/** The second tap's words on a started card's verb: it was sent before. */
export const SEND_AGAIN_CONFIRM = "already sent — again?";

/** Nothing offered — said plainly, and pointing at what is folded below. */
export function noOffersWords(declined: number, unfit: number): string {
  const below = declined + unfit > 0 ? " What you turned down and what does not fit this repo are folded below." : "";
  return `Nothing to offer here right now — every opt-in is either on or answered.${below}`;
}

/** The region's one-line guide, above everything it draws. */
export const OPTINS_GUIDE =
  "Optional things this repo can turn on. Nothing here is a problem, and nothing is sent until you send it.";

/** The region switch's `?` — what this region compares, beside the other two. */
export const OPTINS_REGION_WORDS =
  "Opt-ins compare nothing: they are offers, not readings. Each is on, off or not for you, and none is counted in the repo's badge.";
