/**
 * The change brief: what a push would send and a pull would bring, explained
 * for a person who does not read the diff — the Review sheet's "Explain".
 *
 * ── What this is, and what it deliberately is not ──────────────────────────
 *
 * `commitmsg.ts`'s shape on a different question: one toolless headless call,
 * its whole input in the prompt, routed by its own knob (`explain`) through the
 * same `runTextTask` argv, so it drops none of `nameTab`'s flags. TAPPED, never
 * unattended — and **nothing applies itself**: the answer is Markdown a person
 * reads before deciding to push or pull. It never pushes, pulls, commits or
 * refuses anything.
 *
 * The model defaults to sonnet, not haiku: the brief's first question is
 * "is anything here security-relevant", and that is the one reading where the
 * cheapest model's miss costs more than the call.
 *
 * ── The one write ──────────────────────────────────────────────────────────
 *
 * A `git fetch` first (`gitlog.ts`'s, refs only), so "to pull" is as of now.
 * A failed fetch is not a failed brief: it is SAID, and the brief covers what
 * the last good fetch knew.
 *
 * ── What the model is shown ────────────────────────────────────────────────
 *
 * Per direction: the commits (subject and a clipped body), the stat, and the
 * diff from the merge base — lockfiles and dotenv files left out of the diff
 * (noise and secrets; the stat still names them). Plus the repo's layout, two
 * levels deep, so "which component needs deploying" is read off real paths.
 * A clipped diff is said in the prompt AND on the answer (`truncated`).
 */
import { cleanChangeFocusNote, cleanChangeFoci, CHANGE_FOCI, type ChangeBrief, type ChangeBriefSpend } from "@waterplane/shared";
import { execFileP as pexec } from "./proc.js";
import { gitFetch } from "./gitlog.js";
import { runExplainTask, sidecarPlan } from "./sidecar.js";
import { env } from "./env.js";
import { promptText } from "./prompts.js";

const EXPLAIN_MODEL = env("EXPLAIN_MODEL") || "sonnet";
const EXPLAIN_TIMEOUT_MS = Number(env("EXPLAIN_TIMEOUT_MS") || 170_000);

/** Per direction. Two of these is ~20k tokens — a brief, not a review. */
const DIFF_CAP = 40_000;
const COMMITS_MAX = 60;
const BODY_CAP = 600;
const LAYOUT_MAX = 120;

/** Left out of the diff, never out of the stat: noise, and files that may hold secrets. */
const DIFF_EXCLUDE = [
  ":(glob,exclude)**/package-lock.json", ":(glob,exclude)**/yarn.lock", ":(glob,exclude)**/pnpm-lock.yaml",
  ":(glob,exclude)**/Cargo.lock", ":(glob,exclude)**/poetry.lock", ":(glob,exclude)**/go.sum",
  ":(glob,exclude)**/.env", ":(glob,exclude)**/.env.*", ":(glob,exclude)**/*.min.js",
];

const SYSTEM_DEFAULT =
  "You explain code changes to the person who owns the project but does not read code. " +
  "Plain language, short, concrete. Output Markdown only — no preamble, no closing remarks.";

async function git(wt: string, args: string[]): Promise<string> {
  return (await pexec("git", args, { cwd: wt, maxBuffer: 32 * 1024 * 1024 })).stdout;
}

interface Side { count: number; commits: string; stat: string; diff: string; truncated: boolean }

async function side(wt: string, range: string, mergeRange: string): Promise<Side> {
  const count = Number((await git(wt, ["rev-list", "--count", range]).catch(() => "0")).trim()) || 0;
  if (!count) return { count, commits: "", stat: "", diff: "", truncated: false };
  const log = await git(wt, ["log", `-n${COMMITS_MAX}`, "--no-color", "--format=%h %s%n%b%x1e", range]).catch(() => "");
  const commits = log.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [head, ...body] = c.split("\n");
    const b = body.join("\n").trim();
    return `- ${head}${b ? `\n  ${b.slice(0, BODY_CAP).replace(/\n/g, "\n  ")}` : ""}`;
  }).join("\n") + (count > COMMITS_MAX ? `\n…and ${count - COMMITS_MAX} older commits not listed` : "");
  const stat = (await git(wt, ["diff", "--stat=120", "--no-color", mergeRange]).catch(() => "")).trim();
  let diff = await git(wt, ["diff", "--no-color", mergeRange, "--", ".", ...DIFF_EXCLUDE]).catch(() => "");
  const truncated = diff.length > DIFF_CAP;
  if (truncated) diff = diff.slice(0, DIFF_CAP) + "\n…(diff truncated here — the rest of this change is not shown)";
  return { count, commits, stat, diff, truncated };
}

/** Root files and directories two levels deep — enough to name a component. */
async function layout(wt: string): Promise<string> {
  const files = (await git(wt, ["ls-files"]).catch(() => "")).split("\n").filter(Boolean);
  const seen = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    seen.add(parts.length === 1 ? f : parts.slice(0, Math.min(2, parts.length - 1)).join("/") + "/");
    if (seen.size >= LAYOUT_MAX) break;
  }
  return [...seen].sort().join("\n");
}

function section(title: string, s: Side): string {
  return [
    `===== ${title}: ${s.count} commit${s.count === 1 ? "" : "s"} =====`,
    `----- COMMITS (newest first) -----\n${s.commits}`,
    s.stat && `----- FILES CHANGED -----\n${s.stat}`,
    s.diff.trim() && `----- DIFF (lockfiles and .env files left out) -----\n${s.diff}`,
  ].filter(Boolean).join("\n\n");
}

const no = (reason: string, extra: Partial<ChangeBrief> = {}): ChangeBrief => ({ reason, ...extra });

/** Explain what a push would send and a pull would bring, under the foci a person ticked. */
export async function explainChanges(wt: string, body: { foci?: unknown; note?: unknown }): Promise<ChangeBrief> {
  const foci = cleanChangeFoci(body.foci);
  const note = cleanChangeFocusNote(body.note);

  const upstream = (await git(wt, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")).trim();
  if (!upstream) return no("This branch has no upstream, so there is nothing to compare a push or pull against. Push it once to set one.");

  const fetched = await gitFetch(wt);
  const fetchNote = fetched.ok ? undefined : `The fetch failed, so "to pull" is as of the last fetch that worked. ${fetched.error ?? ""}`.trim();

  const [out, inc] = await Promise.all([
    side(wt, "@{u}..HEAD", "@{u}...HEAD"),
    side(wt, "HEAD..@{u}", "HEAD...@{u}"),
  ]);
  const counts = { push: out.count, pull: inc.count, fetchNote };
  if (!out.count && !inc.count) return no(`Nothing to push or pull — this branch matches ${upstream}.`, counts);
  const truncated = out.truncated || inc.truncated;

  const asks = CHANGE_FOCI.filter((f) => foci.includes(f.id)).map((f) => `- ${f.ask}`);
  if (note) asks.push(`- The owner's own focus, in their words: ${note}`);
  const parts: string[] = [
    `Explain the changes below to the project's owner. Branch \`${(await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim()}\` against \`${upstream}\`.`,
    `Structure: ${out.count ? "a section `## To push`" : ""}${out.count && inc.count ? " and " : ""}${inc.count ? "a section `## To pull`" : ""}. ` +
      `Each starts with two or three sentences on what the changes are FOR, then one \`###\` subsection per focus below, in that order, bullets preferred. ` +
      `A focus with nothing to say gets one line saying so — never padding.` +
      (out.count && inc.count ? ` End with \`## Both together\`: only if the two sides touch the same areas or could conflict; otherwise omit it.` : ""),
    asks.length ? `Foci:\n${asks.join("\n")}` : `No focus was chosen: give only the short summary per section.`,
    `Rules: describe effects, not code; name files only when it helps the owner find something. ` +
      `Say only what the commits and diffs show — when something cannot be told from what you were given, say so instead of guessing.` +
      (truncated ? ` Part of a diff was cut to fit (marked); say which side your reading may be incomplete for.` : ""),
    `----- REPO LAYOUT (tracked paths, two levels) -----\n${await layout(wt)}`,
  ];
  if (out.count) parts.push(section("TO PUSH (here, not on the upstream)", out));
  if (inc.count) parts.push(section("TO PULL (on the upstream, not here)", inc));

  const run = await runExplainTask({
    cwd: wt,
    prompt: parts.join("\n\n"),
    system: promptText("change-brief", SYSTEM_DEFAULT),
    model: EXPLAIN_MODEL,
    timeoutMs: EXPLAIN_TIMEOUT_MS,
  });
  // The phone says what this cost, so the numbers are the envelope's or absent.
  const local = sidecarPlan("explain").engine === "openai-compat";
  const u = run.usage;
  const spend: ChangeBriefSpend = {
    engine: local ? "local" : "claude",
    model: local ? "local model" : EXPLAIN_MODEL,
    usd: run.usd,
    inTok: u ? u.inTok + u.cacheRead + u.cacheWrite : undefined,
    outTok: u?.outTok,
    durationMs: run.durationMs,
  };
  if (run.limited) return no(run.detail || "The account is out of quota — nothing was explained.", { ...counts, limited: true, spend });
  if (run.failed) return no(run.detail || "No explanation came back.", { ...counts, spend });
  const text = run.text.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1").trim();
  if (!text) return no("No explanation came back.", { ...counts, spend });
  return { text, ...counts, truncated: truncated || undefined, spend };
}
