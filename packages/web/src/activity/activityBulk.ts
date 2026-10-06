import type { ActivityRow } from "./activityTypes.ts";

/**
 * Why these words cannot be posted again as a work item in their own repo.
 * `null` ⇒ they can.
 *
 * Two rules, and the second is the one worth stating: the verdict is READ OFF
 * the row's own action, never re-derived. `queueRow` already knows the reasons
 * a message may not go again (it is an answer bound to one box, it is bytes, it
 * may already have landed, it is still on its way…), and a bulk path that
 * decided that a second time would eventually disagree with the button next to
 * it — which on this screen means quietly re-sending something the row says is
 * un-re-sendable.
 *
 * Offered only where "it provably is not going to run where it was aimed" is
 * true: a failed row, or one whose session is gone. A row still on its way is
 * refused with that as the reason, because a bulk re-fire of a queue that is
 * simply slow is how one prompt runs twice.
 */
export function refireBlocker(row: ActivityRow): string | null {
  if (row.source !== "queue") {
    return "this one lives on the desktop — run it again from its own row";
  }
  if (row.bucket !== "failed" && row.blockReason !== "sessionGone") {
    return "this one has not failed — it is still on its way";
  }
  if (!row.cwd) return "nothing recorded which repo these words were for";
  const a = row.actions.find((x) => x.id === "retry") ?? row.actions.find((x) => x.id === "sendNow");
  if (!a) return "this row is not a message that can be sent again";
  return a.disabledReason ?? null;
}

/** Why this row cannot be filed away. `null` ⇒ it can. Only one thing stops it:
 *  work that is actually moving, which "I am done with this" does not describe —
 *  stopping that is `cancel`, and it is a different button on purpose. */
export function dismissBlocker(row: ActivityRow): string | null {
  if (row.dismissedAt != null) return "already filed";
  if (row.state === "running" || row.state === "starting") return "this one is running — stopping it is “cancel”";
  return null;
}

/** Partition a selection the way a bulk button has to: what it will act on,
 *  and what it will skip, each with the reason the row itself gave. */
export function partitionBulk(
  rows: readonly ActivityRow[],
  blocker: (r: ActivityRow) => string | null,
): { go: ActivityRow[]; skip: { row: ActivityRow; why: string }[] } {
  const go: ActivityRow[] = [];
  const skip: { row: ActivityRow; why: string }[] = [];
  for (const r of rows) {
    const why = blocker(r);
    if (why) skip.push({ row: r, why }); else go.push(r);
  }
  return { go, skip };
}

/** How many of the sample prompts a confirmation shows. Three is enough to
 *  recognise the set and few enough to read on a phone above the button. */
const BULK_SAMPLE = 3;
const BULK_SAMPLE_CHARS = 70;

/**
 * The lines a bulk confirmation puts in front of the user.
 *
 * A bulk action here is the most dangerous button in this app: one tap over
 * eighty-four prompts somebody spent real work on. So the confirmation states
 * the COUNT, the repos it spans, and a SAMPLE of the actual words — because
 * "84 rows" is not something a person can check, and "…and 81 more" under three
 * prompts they recognise is.
 *
 * Composed here rather than in the sheet so it can be pinned by a test: the
 * sentence a destructive confirmation shows is part of the safety, not
 * decoration on top of it.
 */
export function bulkLines(
  rows: readonly ActivityRow[],
  opts: { verb: "dismiss" | "refire" | "restore"; repoName: (cwd: string) => string; skipped?: number },
): string[] {
  const lines: string[] = [];
  const n = rows.length;
  const thing = n === 1 ? "row" : "rows";
  if (opts.verb === "dismiss") {
    lines.push(`${n} ${thing} filed away as dealt with.`);
    lines.push("Nothing is deleted: the words, the verdict and the buttons stay on the row, under the “dismissed” chip, and “bring back” undoes this.");
  } else if (opts.verb === "restore") {
    lines.push(`${n} ${thing} back in the list.`);
  } else {
    lines.push(`${n} ${n === 1 ? "message goes" : "messages go"} out again as backlog items, each in the repo it was written for.`);
    // What "one at a time" is a promise about MOVED, and the sentence had to
    // move with it. The repo's one shared `backlog · <repo>` conversation is
    // retired (`shared/sessioncost.ts` is the argument): every item now opens
    // its own session and closes it again, and they still run one at a time
    // per repo because the intent store serializes them on the host. Saying
    // "in that repo's own session" would now be describing a conversation that
    // no longer exists, on the one screen that exists to be checked before
    // eighty-four prompts go out.
    lines.push("They run one at a time per repo, each in a new session. Nothing is re-typed and nothing is asked.");
  }

  const byRepo = new Map<string, number>();
  let noRepo = 0;
  for (const r of rows) {
    if (!r.cwd) { noRepo += 1; continue; }
    byRepo.set(r.cwd, (byRepo.get(r.cwd) ?? 0) + 1);
  }
  const repos = [...byRepo.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cwd, k]) => `${opts.repoName(cwd)} ${k}`);
  if (noRepo) repos.push(`no repo recorded ${noRepo}`);
  if (repos.length) lines.push(repos.join(" · "));

  for (const r of rows.slice(0, BULK_SAMPLE)) {
    const one = (r.title || "").replace(/\s+/g, " ").trim();
    lines.push(`“${one.length > BULK_SAMPLE_CHARS ? `${one.slice(0, BULK_SAMPLE_CHARS)}…` : one}”`);
  }
  if (n > BULK_SAMPLE) lines.push(`…and ${n - BULK_SAMPLE} more`);
  if (opts.skipped) lines.push(`${opts.skipped} of the selected ${opts.skipped === 1 ? "row is" : "rows are"} left alone — each says why on its own row.`);
  return lines;
}
