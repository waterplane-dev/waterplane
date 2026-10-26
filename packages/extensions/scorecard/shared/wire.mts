/**
 * The scorecard extension's wire: what the phone may ask the host half, typed once for both ends.
 * Pure, no node imports — the host compiles it (`tsconfig.extensions.json`), the phone bundles it.
 *
 * The reading is the public OpenSSF Scorecard API (`api.securityscorecards.dev`) for the repo's
 * GitHub remote: no credential, no model call. A repo with no GitHub remote, a private one, or one
 * the API has not scored gets NO score — `absent` says why in a sentence, never a 0.
 *
 * Transport: the generic plugin channel on the one socket. Phone → host is `plugin.call`; host →
 * phone is ONE tiny push, `changed` (`{ at, slug }`), after which the phone reads that repo again.
 */

/** One Scorecard check as the API scored it. */
export interface ScoreCheck {
  /** The API's check name, verbatim ("Pinned-Dependencies"). */
  name: string;
  /** 0–10; -1 = inconclusive / not applicable (the API's own value) — never failing. */
  score: number;
  /** The API's one-line reason ("dependency not pinned by hash detected -- score normalized to 6"). */
  reason: string;
  /** The API's details lines, capped by the host (≤ 20 lines, each ≤ 300 chars). */
  details: string[];
  /** The check's documentation page (the API's `documentation.url`), or null. */
  docUrl: string | null;
  /** The API's short description (`documentation.short`), or "". */
  short: string;
}

/** Why a check that loses points is not counted: a person's reason, or one shipped built in. */
export interface ScoreAccept {
  reason: string;
  /** ISO time the accept was made (built-in: absent). */
  at?: string;
  /** The check's score when accepted. The accept lapses when the score later falls BELOW it. */
  score?: number;
  /** Shipped with waterplane (solo-unfixable), not typed by anyone; cannot be withdrawn. */
  builtIn?: true;
}

/** A check as the sheet draws it: the reading plus whether it counts. */
export interface CheckView extends ScoreCheck {
  /** 0 <= score < 10. */
  failing: boolean;
  /** Present when a failing check is accepted (and the accept has not lapsed). */
  accepted?: ScoreAccept;
}

export interface ScoreView {
  /** Repo id (the phone's `RepoTarget.id`) this answers for. */
  repo: string;
  /** `owner/name` on github.com that is scored, or null when the repo has no GitHub remote and none is set. */
  slug: string | null;
  /** Where `slug` came from: the `origin` remote (else the first GitHub remote), or a person's
   *  "scored as" (a private repo published through a public mirror — this repo's own case). */
  slugFrom: "remote" | "set" | null;
  /** The aggregate 0–10 as the API gives it, or null with `absent`. */
  score: number | null;
  /** Why there is no score, in a sentence ("private repo — Scorecard scores public repos only"). */
  absent?: string;
  /** The API's run date (ISO) and scored commit, when scored. */
  date?: string;
  commit?: string;
  scorecardVersion?: string;
  /** Every check, API order. Empty when absent. */
  checks: CheckView[];
  /** How many checks are failing and not accepted — the chip's number, and exactly what its tap opens. */
  open: number;
  /** When the host read the API (ms epoch), or null when it never has. */
  readAt: number | null;
  /** True when the repo is private and this reading was scored on the desktop with the scorecard CLI
   *  (not the public score); `date` is when. No `viewerUrl` then. */
  local?: true;
  /** The badge / public viewer page for the slug, when scored. */
  viewerUrl?: string;
  /** A sentence about something the host could not use (the accepts file does not parse, so no
   *  person's accept counts and none can be written). Shown on the sheet; absent when all is well. */
  problem?: string;
}

/** Built-in accepts: checks a solo maintainer cannot pass. Keyed by the API's check name. */
export const BUILT_IN_ACCEPTS: Readonly<Record<string, string>> = {
  "Code-Review": "Solo maintainer: needs a second person approving changes; self-merged pull requests do not count.",
  "Contributors": "Solo maintainer: needs contributors from several organisations.",
  "Fuzzing": "No fuzzing integration (OSS-Fuzz, ClusterFuzzLite) for this project; accepted for a solo project.",
};

/** A read is reused this long before the host asks the API again. */
export const SCORE_FRESH_MS = 6 * 60 * 60_000;
/** Whether a slug is public (unauthenticated GitHub API) is reused this long — 60 requests/hour per IP. */
export const VISIBILITY_FRESH_MS = 24 * 60 * 60_000;
export const PUSH_CHANGED = "changed";
/** The setup row's check id. */
export const CHECK_ID = "scorecard";
/** A GitHub `owner/name`, as GitHub allows them. */
export const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Longest accept reason the host keeps. */
export const REASON_MAX = 500;

// A type alias, not an interface: it must satisfy PluginMethods' index signature.
export type ScorecardMethods = {
  /** The cached view; starts a read in the background when stale (a `changed` push follows). */
  read: { args: { repo: string }; result: ScoreView };
  /** Read the API now, past the cache. */
  refresh: { args: { repo: string }; result: ScoreView };
  /** Accept a failing check with a reason (non-empty, ≤ REASON_MAX). */
  accept: { args: { repo: string; check: string; reason: string }; result: ScoreView };
  /** Withdraw a person's accept (a built-in one is refused in words). */
  unaccept: { args: { repo: string; check: string }; result: ScoreView };
  /** Score this repo as another public `owner/name` (a mirror), or null to go back to the remote. */
  scoredAs: { args: { repo: string; slug: string | null }; result: ScoreView };
  /** Put the check's remedy prompt in the repo's backlog — waits for a tap, never fires. */
  remedy: { args: { repo: string; check: string }; result: { intentId: string; existing: boolean; state?: string } };
};
