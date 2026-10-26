/**
 * **Which exposure findings earn a push, and which keys the host must remember.** The watch's
 * promise (proposal §2-3): an ALERT is a push the same day, one per new finding, keyed
 * (repo, measure, subject, version). Pure, no clock but the `now` handed in, no file reads — the
 * host (`exposurepush.ts`) owns the store and the sending.
 *
 *  - **Pushed once FOREVER.** The remembered set is never pruned: an accept that lapses, or a
 *    finding that clears and comes back with the same key, does not push a second time.
 *  - **Seeding is silent, per repo.** The store carries a `repos` marker: the first time the sweep
 *    sees a repo as WATCHED (first run, late add, re-add, missed runs, no store at all) it remembers
 *    that repo's alert keys, pushes none, and marks the repo. Only a marked repo pushes new keys.
 *  - **Only open alerts.** `digest` findings and accepted ones (`applyAccepts`, the one reader of an
 *    accept) are neither pushed nor remembered, so a digest finding is never "spent".
 *  - **Up to {@link EXPOSURE_PUSH_CAP} pushes per repo per sweep**, one per finding; more than that
 *    is ONE push naming the count, and every key is remembered.
 */
import { applyAccepts, type ExposureAccept, type ExposureFinding, type ExposureRow, type Severity } from "./exposure.js";

export const EXPOSURE_PUSH_CAP = 3;

/** One push to send. `attention` = critical/high severity (a person is asked to look today). */
export interface ExposurePush {
  repo: string;
  dir: string;
  title: string;
  body: string;
  /** The stable tag: a later push for the same finding replaces it in the OS tray. */
  tag: string;
  /** The attention key (same spelling as the tag) so the cause can resolve the item. */
  key: string;
  attention: boolean;
  /** The finding keys this push stands for (all of them remembered by the caller). */
  keys: string[];
}

export interface ExposurePushPlan {
  push: ExposurePush[];
  /** Keys to add to the store (never already in it). */
  remember: string[];
  /** Repos seen as watched for the first time: to add to the store's marker. */
  seenRepos: string[];
  /** Attention keys whose finding is no longer open (or whose repo has none left): to resolve. */
  resolve: string[];
}

/** What the store holds: pushed keys, and the repos whose first sight has been seeded. */
export interface ExposurePushed { keys: ReadonlySet<string>; repos: ReadonlySet<string> }

/** `unreadable`: the accepts file exists but cannot be read, so nothing is known about this row. */
export interface ExposureSeries { row: ExposureRow; accepts: Record<string, ExposureAccept> | null; unreadable?: boolean }

/** The dedupe key: (repo, finding.key, version), `\u0000`-joined so no field can fake another.
 *  `finding.key` already carries the advisory id and the subject. */
export const exposurePushKey = (repo: string, f: Pick<ExposureFinding, "key" | "version">): string =>
  `${repo}\u0000${f.key}\u0000${f.version ?? ""}`;

/** The attention key of one finding's push, and of a repo's summary push. */
export const exposureAttentionKey = (repo: string, findingKey: string): string => `exposure:${repo}:${findingKey}`;
export const exposureSummaryKey = (repo: string): string => `exposure:${repo}`;

const LOUD: readonly Severity[] = ["critical", "high"];
const isLoud = (f: ExposureFinding): boolean => !!f.severity && LOUD.includes(f.severity);

export function exposurePushes(
  series: readonly ExposureSeries[],
  watched: (dir: string) => boolean,
  pushed: ExposurePushed,
  now: Date | string,
): ExposurePushPlan {
  const push: ExposurePush[] = [];
  const remember = new Set<string>();
  const seenRepos = new Set<string>();
  const resolve = new Set<string>();
  for (const { row, accepts, unreadable } of series) {
    if (!row || typeof row.dir !== "string" || typeof row.repo !== "string" || !watched(row.dir)) continue;
    if (unreadable) continue; // nothing is known: push nothing, remember nothing
    const alerts = (Array.isArray(row.findings) ? row.findings : []).filter((f) => f?.level === "alert");
    if (row.firstRun || !pushed.repos.has(row.repo)) {
      for (const f of alerts) {
        const k = exposurePushKey(row.repo, f);
        if (!pushed.keys.has(k)) remember.add(k);
      }
      if (!pushed.repos.has(row.repo)) seenRepos.add(row.repo);
      continue;
    }
    const open = applyAccepts(alerts, accepts, now).filter((f) => !f.accepted);
    // Resolve what is no longer open: every remembered key of this repo whose finding is gone.
    const openKeys = new Set(open.map((f) => f.key));
    const prefix = `${row.repo}\u0000`;
    for (const k of pushed.keys) {
      if (!k.startsWith(prefix)) continue;
      const fk = k.slice(prefix.length).split("\u0000")[0];
      if (!openKeys.has(fk)) resolve.add(exposureAttentionKey(row.repo, fk));
    }
    if (!open.length) resolve.add(exposureSummaryKey(row.repo));
    const seen = new Set<string>();
    const fresh = open.filter((f) => {
      const k = exposurePushKey(row.repo, f);
      if (pushed.keys.has(k) || remember.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!fresh.length) continue;
    for (const f of fresh) remember.add(exposurePushKey(row.repo, f));
    const keys = fresh.map((f) => exposurePushKey(row.repo, f));
    if (fresh.length > EXPOSURE_PUSH_CAP) {
      push.push({
        repo: row.repo, dir: row.dir, keys, attention: fresh.some(isLoud),
        title: `${fresh.length} new exposure findings in ${row.repo}`,
        body: fresh.slice(0, EXPOSURE_PUSH_CAP).map((f) => f.text).join("\n") + `\nand ${fresh.length - EXPOSURE_PUSH_CAP} more, in the exposure watch.`,
        tag: exposureSummaryKey(row.repo), key: exposureSummaryKey(row.repo),
      });
      continue;
    }
    for (const f of fresh) {
      push.push({
        repo: row.repo, dir: row.dir, keys: [exposurePushKey(row.repo, f)], attention: isLoud(f),
        title: `${row.repo}: ${f.measure} ${f.subject}${f.version ? "@" + f.version : ""}`,
        body: f.text,
        tag: exposureAttentionKey(row.repo, f.key), key: exposureAttentionKey(row.repo, f.key),
      });
    }
  }
  return { push, remember: [...remember], seenRepos: [...seenRepos], resolve: [...resolve] };
}
