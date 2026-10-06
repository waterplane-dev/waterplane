/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import type { SmartPickCandidate, SmartPickFacts } from "@waterplane/shared";
import { SMARTPICK_MAX_CHARS, SMARTPICK_MAX_ITEMS } from "@waterplane/shared";
import { CLIP_CHARS } from "./hspknobs.js";

// ── The prompts ─────────────────────────────────────────────────────────────

/**
 * The contract, as the model is told it.
 *
 * Pinned verbatim by `packages/host/test/smartpick.test.mjs`, because a drift
 * here is a contract drift that nothing downstream can see: `cleanSmartPick`
 * would go on refusing every answer and every pass would record `failed`, which
 * reads exactly like a flaky model.
 *
 * The last paragraph is a cost control that does not work on its own, and is
 * kept anyway. Thinking is what this call is billed for (see the header), and
 * asking the model for a straight answer did NOT stop it — 2,644 thinking tokens
 * were spent with this paragraph in place, and `--thinking disabled` in the argv
 * is what actually did it. It stays because it costs nothing and because it is
 * the ONLY lever on the local engine, which has no such flag.
 *
 * Everything else in it is a `never`: the four of them are the whole of "a
 * machine may groom this list and may not rewrite it", and each is enforced
 * twice — here in words to the model, and in `cleanSmartPick` against the
 * answer. The clock paragraph is the fifth and is enforced the same way: the
 * model is told what an `at` means to each of the three verbs so its `why` is
 * about something real, and `cleanSmartPick` corrects a timed pick and refuses
 * a mixed merge whatever it answers.
 */
export const SMARTPICK_SYSTEM = [
  "You groom a short list of coding tasks waiting to run in one repository. You get the tasks with ids, and a little about the repo (branch, uncommitted files, recent commit subjects). Decide three things: which ONE task should run next, which tasks are the same job and should be merged into one, and the order the rest should run in.",
  "Prefer as next: a task that unblocks others, a task the uncommitted files or recent commits show is already half done, or the smallest task on a dirty tree. Merge only tasks that are clearly one piece of work; when you merge, write one task text that keeps every concrete detail, every file path and every constraint from all of them, and say in one sentence why they are one job.",
  "A task with an `at` runs at that time on its own: never pick it as next, and merge it only with a task whose `at` is identical. You MAY order tasks that share the same `at` among themselves — put the one that should run first at that time earliest — but never move such a task past a task with a different `at` or with none.",
  "Never invent a task. Never drop a task. Never change the words of a task you do not merge. Never answer with anything but the JSON object.",
  'Answer with ONE JSON object and nothing else:\n{"pick":"<id>","order":["<id>",...],"merges":[{"ids":["<id>","<id>"],"text":"...","why":"..."}],"why":"<one sentence>"}',
  "`order` lists every id exactly once, merged ones included. If nothing should change, return the ids in the order you were given them and leave `merges` empty.",
  "This is a list-tidying job, not a coding job: decide from the words in front of you and answer straight away. Do not reason step by step and write no prose outside the JSON — this call is bought before every item this repo runs, and thinking is the whole of what it costs.",
].join("\n\n");

/** "2 days" / "3 h" / "just now" — how long a task has been waiting, which is
 *  the one fact about a row that is not in its words. */
function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The repo's waiting items and its cheap facts, as the JSON the model reads.
 *
 * Two caps, and NEITHER of them drops an item silently:
 *
 *  • `SMARTPICK_MAX_ITEMS` — past forty the prompt stops being a few thousand
 *    tokens. The rest keep their positions untouched and the record says how
 *    many were not looked at (`omitted`), because a pass that quietly ignores
 *    half a backlog while reporting a clean sweep is worse than one that admits
 *    it ran out of room.
 *  • `SMARTPICK_MAX_CHARS` — items go in WHOLE, in current order, until the
 *    budget is spent; past it an item goes in as its first few hundred
 *    characters and is marked `clipped`. A clipped item may be sorted (the
 *    model saw enough to place it) and may never be merged, which
 *    `cleanSmartPick` enforces off that flag.
 *
 * Returns the candidates it ACTUALLY sent, `clipped` stamped, because those are
 * the candidates the sanitiser must be given: a clip made here and not carried
 * through is a merge folding words nobody read.
 */
export function smartpickPrompt(p: {
  repo: string;
  facts: SmartPickFacts;
  cands: readonly SmartPickCandidate[];
  createdAt: (id: string) => number;
  now: number;
}): { text: string; sent: SmartPickCandidate[]; omitted: number } {
  const head = p.cands.slice(0, SMARTPICK_MAX_ITEMS);
  const omitted = p.cands.length - head.length;

  let spent = 0;
  const sent: SmartPickCandidate[] = [];
  const tasks: Record<string, unknown>[] = [];
  for (const c of head) {
    const whole = spent + c.text.length <= SMARTPICK_MAX_CHARS;
    const text = whole ? c.text : c.text.slice(0, CLIP_CHARS);
    spent += text.length;
    const cand: SmartPickCandidate = whole ? { ...c } : { ...c, clipped: true };
    sent.push(cand);
    tasks.push({
      id: c.id,
      text,
      ...(c.label ? { label: c.label } : {}),
      age: age(p.now - p.createdAt(c.id)),
      ...(c.resume ? { resume: true } : {}),
      // WHEN, when a person set one. The sentence and nothing else about the
      // trigger: the grace, the hold and the armed instant are facts the model
      // has no verb for, and a field it cannot act on is prompt it is billed
      // for. The KEY never goes in either — equality is decided here, against
      // the store, not by a model comparing two strings.
      ...(c.at ? { at: c.at } : {}),
      ...(whole ? {} : { clipped: true }),
    });
  }

  return {
    text: JSON.stringify({
      repo: { name: p.repo, branch: p.facts.branch, dirty: p.facts.dirty, commits: p.facts.commits },
      tasks,
    }),
    sent,
    omitted,
  };
}