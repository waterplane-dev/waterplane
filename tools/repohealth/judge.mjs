/**
 * The one place in this tool that may cost a token, and the guard that stands
 * in front of it.
 *
 * ── Why a guard and not a feature ──────────────────────────────────────────
 *
 * Everything else here is free: `git`, regexes, arithmetic, no model, no
 * network. That is what makes the series safe to run on every commit and safe
 * to backfill across 157 of them. A handful of questions in the whole design
 * are worth a model — "are these two duplicate blocks the same behaviour under
 * different names", "did this change simplify the behaviour or relocate it",
 * "is this export really unreached or only unreachable to a text scan" — and
 * every one of them is a question a PERSON asks about ONE subject,
 * deliberately, looking at it. None is a question a daily tool should ask
 * itself, which is why the list lives in `question()` and not in a loop.
 *
 * So the shape is a button, never a default. `bundle()` assembles the evidence
 * and can be inspected for nothing; `run()` prints what the answer would cost
 * BEFORE anything is spent, and without an explicit `--yes` or a `y` typed at
 * a terminal it exits 2 having called `spawn` zero times. `spawn` is injected
 * precisely so the test can assert that count, because "it asks first" is a
 * property that has to be checked by counting calls — reading the code proves
 * it about today's code only.
 *
 * The second half of the guard is that an empty bundle is not for sale.
 * `events.mjs` emits events whose subject is a series key — a rank, a slope —
 * and those carry no file to show anybody. Offering to spend on one is
 * offering to buy a confident answer about nothing, so `run()` exits 2 saying
 * there is no evidence to send, after printing the estimate and before asking
 * anything.
 *
 * `WATERPLANE_JUDGE_MODEL` overrides the model for this one call, downwards and per
 * desktop; it is listed in `.env.example` with every other knob, because that
 * file is CLAUDE.md's complete list and a knob missing from it is a knob
 * nobody knows exists.
 *
 * ── The constraint that is load-bearing ────────────────────────────────────
 *
 * THIS IS THE ONLY MODULE IN `tools/repohealth/` ALLOWED TO SPAWN `claude`.
 * `tools/repohealth.test.mjs` asserts it as a TEXT check over every file in
 * the directory — the token as a spawn target must appear here and nowhere
 * else. A text check rather than a runtime one because the failure it guards
 * against is an import added in a hurry, which passes every runtime test that
 * does not happen to take that branch. If you are moving code out of this
 * file, the binary name moves with it or the check fails; that is the check
 * working, not the check being wrong.
 *
 * ── Where the answer goes ──────────────────────────────────────────────────
 *
 * `.claude/outbox/repohealth-judge-<event>.md`, in full every time it is
 * named. NEVER into the series JSONL. A judgment is prose from a model that
 * may answer differently tomorrow; the JSONL is a deterministic history that
 * has to re-derive identically on another machine years later. Mixing them
 * would make the fixture depend on a model, which is the one dependency the
 * whole pre-registration design exists to refuse.
 *
 * And the repo's rule: **nothing applies itself.** A judgment is sentences a
 * person reads. It never edits a source file and never marks a pair resolved.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveEnv } from "../../packages/shared/dist/index.js";

/** Named in full at every mention; a bare filename does not resolve on a phone. */
export const OUTBOX_DIR = ".claude/outbox";

/** Filesystem-safe, and short enough to still read as the event it came from. */
export function slug(id) {
  return String(id ?? "event")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "event";
}

/** `.claude/outbox/repohealth-judge-<event>.md` — the only output this writes. */
export const outPath = (id) => `${OUTBOX_DIR}/repohealth-judge-${slug(id)}.md`;

const nf = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * `id` is `kind:subject:DAY` — three fields, and the last one is a day and not
 * a sha, because `narrate.mjs` keys the ledger on the day (a second commit on
 * an already-narrated day must not re-fire the day). An older id ending in a
 * sha still parses: whatever is in the last field is carried as `at` and
 * resolved below.
 *
 * A subject is a path, a series key (`size.p95`), a hatch name, or several of
 * those joined with `|`. None of them contains `:`, so the split is
 * unambiguous; a subject that somehow did is rejoined rather than truncated.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function partsOf(event) {
  const id = String(event?.id ?? "");
  const bits = id.split(":");
  const kind = event?.kind ?? bits[0] ?? "";
  const at = bits.length > 2 ? bits[bits.length - 1] : "";
  const subject = bits.length > 2 ? bits.slice(1, -1).join(":") : "";
  return { id, kind, at, subject };
}

/**
 * The two commits a day names: the LAST first-parent commit of that day, and
 * the last one of the day-row BEFORE it.
 *
 * Both, because they are the two ends of what the narrative actually reported.
 * A day-row is `perDay`'s reduction of every commit of that day, so "the day's
 * change to this file" is the diff between those two shas — not `<sha>^`,
 * which is only the last of possibly nine commits, and not `<sha>` alone,
 * which has no before in it.
 *
 * `%ci` and not `%ct`, mirroring `git.mjs`: a day here is the commit's own UTC
 * offset, never the machine's, and 22 of this history's commits sit in the
 * 22:00 hour where the two disagree. `rev-list` is newest-first, so the first
 * match walking down is the latest commit on or before the day, and the next
 * one with a strictly earlier day is the previous day-row's.
 */
function commitsForDay(day, git) {
  const out = git(["rev-list", "--first-parent", "--format=%H%x00%ci", "HEAD"]);
  let sha = "";
  let onDay = "";
  for (const line of out.split("\n")) {
    if (!line || line.startsWith("commit ")) continue;
    const [s, ci] = line.split("\0");
    if (!s || !ci) continue;
    const d = ci.slice(0, 10);
    if (!sha) {
      if (d > day) continue;
      sha = s;
      onDay = d;
      continue;
    }
    if (d < onDay) return { sha, prevSha: s };
  }
  return { sha, prevSha: "" };
}

/**
 * The one question this bundle is being assembled to ask.
 *
 * Matched on the event kinds `events.mjs` actually emits. A kind nobody
 * listed gets the neutral question rather than the nearest-looking one: a
 * confident answer to the wrong question is the failure this whole module is
 * shaped around.
 */
function question(kind, members) {
  if (/^pair-/.test(kind)) {
    const which = members.length === 2 ? ` The two blocks are \`${members[0]}\` and \`${members[1]}\`.` : "";
    return (
      "Are these two blocks the same behaviour under different names, or two things that merely look alike?" +
      which +
      " If they are one behaviour, name the single implementation that should exist and say what would have to move to it. " +
      "If they are not, say which detail makes them different — that detail is the answer."
    );
  }
  if (kind === "orphan") {
    const which = members.length ? ` The names are ${members.map((m) => `\`${m}\``).join(", ")}.` : "";
    return (
      "Is each of these exported names genuinely unreached, or is it reached in a way a text scan cannot see — " +
      "a re-export, a dynamic lookup, a string key, a name only a config or a test fixture mentions?" +
      which +
      " For each one, say reached or unreached and name the evidence in the file that settles it."
    );
  }
  if (/^(maxfile|file-crossed-lines|rank|slope)$/.test(kind)) {
    return (
      "Did this change SIMPLIFY the behaviour or RELOCATE it? " +
      "Relocating is moving the same decisions somewhere else, possibly into more files; simplifying is having fewer decisions afterwards. " +
      "Say which, and name the specific decision that moved or disappeared."
    );
  }
  if (kind === "untested") {
    return (
      "What behaviour in this module would a test have to pin for the module to be worth calling covered? " +
      "Name the specific decisions it makes, not the functions it exports, and say which of them a test could hold still without a running host."
    );
  }
  return "What actually changed here, and is it one change or several unrelated ones? Name them.";
}

const SYSTEM =
  "You answer one question about one piece of a codebase. " +
  "Answer in at most eight lines of plain prose, no headings, no code fences, no preamble. " +
  "You are given all the evidence there is; do not ask for more and do not speculate about files you cannot see. " +
  "If the evidence does not settle the question, say so in one line and say what would settle it.";

/**
 * The evidence, capped.
 *
 * The budget is split EVENLY across the pieces rather than filled first-come.
 * A dup pair whose first block is 50k and second is 200 lines is exactly the
 * case the judgment is for, and a first-come cap would send the first block
 * and a stub of the second — a question with half its evidence, answered
 * confidently, which is worse than not asking.
 *
 * Every trim states how much it dropped beside how much it kept, for the same
 * reason the narrative does: a truncation the reader cannot size is a fact
 * they have to assume the worst about.
 *
 * ── Where a path comes from ───────────────────────────────────────────────
 *
 * Out of the id's SUBJECT, and out of nothing else. The subject is `a|b` for a
 * pair, a single path for an orphan, a file crossing or the longest file, a
 * `|`-joined list for the untested event, and a series key like `size.p95` for
 * a rank or a slope. A `path#name` member is split at the `#`: the path is the
 * evidence, the name goes into the question.
 *
 * A subject with no path in it yields NO evidence, and that is the right
 * answer — there is nothing to show a model about a percentile. `run()` then
 * refuses rather than offering to buy an empty prompt.
 *
 * ── Content or diff, and never the wrong one ──────────────────────────────
 *
 * `git show <sha> -- <path>` is a DIFF, not a file, and it was what every
 * bundle here used to send. For a duplicate pair that is catastrophic and
 * silent: the question is "are these two blocks the same behaviour", and on a
 * day that happened not to touch the file the answer arrives as the empty
 * string. Two kinds of question need two kinds of evidence, so each is asked
 * for by name:
 *
 *  • `file-crossed-lines`, `maxfile` — a CHANGE happened and the question is
 *    what it did, so the evidence is the day's diff: `git diff <previous
 *    day-row's commit> <this day-row's commit> -- <path>`. Not `<sha>^`: a
 *    day-row is `perDay`'s reduction of every commit of that day, and `^` is
 *    the last of possibly nine.
 *  • everything else — a STATE is being asked about (are these two blocks one
 *    behaviour, is this name reached, what would a test pin), so the evidence
 *    is the file: `git show <commit>:<path>`. For `pair-gone` that commit is
 *    the PREVIOUS day-row's, because the pair is by definition not in the tree
 *    of the day it stopped being recorded.
 *
 * @param {{id: string, kind?: string, files?: string[]}} event
 * @param {string} root
 * @param {{prereg: object, git?: Function}} deps
 */
export function bundle(event, root, deps = {}) {
  const prereg = deps.prereg;
  const cap = Number(prereg?.JUDGE_MAX_CHARS) || 60000;
  const git =
    deps.git ||
    ((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));

  const { id, kind, at, subject } = partsOf(event);

  // A day is resolved to the two commits the day-row sits between; a last
  // field that is already a sha stands for itself and has no "before".
  let sha = at;
  let prevSha = "";
  if (DAY_RE.test(at)) {
    try {
      ({ sha, prevSha } = commitsForDay(at, git));
    } catch {
      sha = "";
      prevSha = "";
    }
  }

  const wantsDiff = kind === "file-crossed-lines" || kind === "maxfile";
  const ref = kind === "pair-gone" && prevSha ? prevSha : sha;

  // Members keep their `#name`; paths do not. One path may carry two members
  // (this history's only pair is two methods of one file) and is read once.
  const members = subject.split("|").filter(Boolean);
  const named = new Map();
  for (const m of members) {
    const p = m.split("#")[0];
    if (!p.includes("/")) continue;
    if (!named.has(p)) named.set(p, []);
    const name = m.includes("#") ? m.slice(m.indexOf("#") + 1) : "";
    if (name) named.get(p).push(name);
  }
  const paths = (Array.isArray(event?.files) && event.files.length ? event.files : [...named.keys()]).slice(0, 8);

  /** @type {{path: string, how: string, text: string}[]} */
  const pieces = [];
  for (const p of paths) {
    const names = named.get(p) || [];
    const look = names.length ? ` — look at ${names.map((n) => `\`${n}\``).join(", ")}` : "";
    try {
      if (!ref) throw new Error(`event id ${id} names no commit or day to read the tree at`);
      let how;
      let text;
      if (wantsDiff && prevSha) {
        how = `git diff ${prevSha.slice(0, 12)} ${sha.slice(0, 12)} -- ${p} (this day-row's whole change to the file)`;
        text = git(["diff", prevSha, sha, "--", p]);
      } else {
        const when = ref === prevSha ? "the day-row before it" : at;
        how = `git show ${ref.slice(0, 12)}:${p} (the file as of ${when})${look}`;
        text = git(["show", `${ref}:${p}`]);
      }
      if (!text.trim()) throw new Error(`nothing came back for ${p} at ${ref.slice(0, 12)}`);
      pieces.push({ path: p, how, text });
    } catch (err) {
      // Evidence that could not be read is SAID, never dropped silently: a
      // model told "here are two blocks" and shown one answers the wrong
      // question and never mentions that it did.
      pieces.push({ path: p, how: "could not be read", text: `(unavailable: ${err?.message || String(err)})` });
    }
  }

  const head = [question(kind, members), "", `Evidence — ${nf(pieces.length)} piece(s), event ${id}:`, ""].join("\n");

  // The cap is on the PROMPT, so the question, the headers and the truncation
  // notices come out of it before the evidence is shared. Splitting `cap`
  // itself is what the first version did, and a two-piece bundle then shipped
  // a prompt several hundred chars over a limit the test asserts and the
  // caller was told. The notice is measured against its own worst case: both
  // of its counts are written out at the width of the WHOLE piece, which is
  // the largest either can be — the cut half in particular can be far wider
  // than the share it was cut down to — so a trimmed body plus its real
  // notice is never longer than the share.
  const frame =
    head.length +
    1 +
    pieces.reduce((t, p) => t + `--- ${p.path} (${p.how})\n`.length, 0) +
    Math.max(0, pieces.length - 1) * 2;
  const share = pieces.length ? Math.max(0, Math.floor((cap - frame) / pieces.length)) : cap;

  let truncated = 0;
  const blocks = pieces.map((piece) => {
    let body = piece.text;
    if (body.length > share) {
      const widest = nf(piece.text.length);
      const worst = `\n… ${widest} chars shown of ${widest}; ${widest} cut to stay under the ${nf(cap)}-char cap.`;
      const kept = Math.max(0, share - worst.length);
      truncated += 1;
      body = `${body.slice(0, kept)}\n… ${nf(kept)} chars shown of ${nf(piece.text.length)}; ${nf(
        piece.text.length - kept,
      )} cut to stay under the ${nf(cap)}-char cap.`;
    }
    return `--- ${piece.path} (${piece.how})\n${body}`;
  });

  const prompt = head + "\n" + blocks.join("\n\n");

  return {
    id,
    kind,
    at,
    ref,
    files: pieces.map((p) => p.path),
    chars: prompt.length,
    truncated,
    cap,
    prompt,
  };
}

/**
 * The binary. The only occurrence of this token as a spawn target in the whole
 * tool — see the header; the test is a text check and this line is what it
 * finds.
 */
const BIN_DEFAULT = "claude";

/**
 * The argv, and CLAUDE.md's rule that a new unattended `-p` call starts from
 * `summarize()`'s flags and JUSTIFIES EVERY ONE IT KEEPS AND EVERY ONE IT
 * DROPS. This call is not even unattended — a person pressed something and is
 * watching — but the rule is about what a headless call costs, and that does
 * not change because somebody is in the room.
 *
 * KEPT, all of `summarize()`'s:
 *  • `-p --output-format json` — the envelope is both the answer and the error
 *    channel. A run the account refused still parses, and its `result` is a
 *    quota banner; without the envelope that banner would be written into
 *    `.claude/outbox/repohealth-judge-<event>.md` as though it were a judgment.
 *  • `--setting-sources user` — no PROJECT settings, so no repo `CLAUDE.md`.
 *    12k chars of always-on rules to answer "are these two blocks the same
 *    behaviour", where the evidence is already in the prompt. The narrative's
 *    own context metric exists because that weight is real.
 *  • `--tools ""` — every byte of evidence is IN the prompt, by construction:
 *    that is what `bundle()` is. A judgment with tools is an agent turn that
 *    reads the repo, which is a different price and a different feature, and
 *    it is also the mechanical guarantee behind the harder rule — with no
 *    tools there is nothing to edit a file with, so a judgment cannot apply
 *    itself even if it decides it should.
 *  • `--system-prompt` — its own eight-line contract, replacing Claude Code's.
 *
 * DROPPED, with the reason:
 *  • `--model` is passed ONLY when `SUMMARY_MODEL` is set. The cheap callers
 *    pin the cheapest model because their job is tidying prose; this one asks
 *    the single question in the tool that a wrong answer makes worse than no
 *    answer, and it is bought by hand, once. So the default model is the right
 *    default here, and the env var is the knob for anyone who disagrees —
 *    downwards, deliberately, per desktop.
 *  • `--thinking disabled` is NOT added, and that is the deliberate difference
 *    from `runSmartPickTask`. Its own comment says why: "a review is a
 *    judgement about code … neither of those is a job where the thinking is
 *    the waste". Here the thinking IS the product, and there is no watchdog
 *    behind this call for it to blow through.
 *  • No `--permission-mode`: nothing is being written by the model. The file
 *    is written by this process, from the envelope.
 *  • No `--output-format stream-json --verbose`: that buys WATCHING a
 *    twenty-minute run (`assess.ts`). This is one question over at most 60k
 *    chars; there is nothing to watch and the extra parse is another place to
 *    mistake a stream event for an answer.
 *  • No `--continue`, no `--add-dir`: a judgment carries no history and reads
 *    no directory.
 */
function argvFor(env) {
  const model = resolveEnv(env, "JUDGE_MODEL").value || env.SUMMARY_MODEL || resolveEnv(env, "SUMMARY_MODEL").value || "";
  return [
    "-p",
    "--output-format", "json",
    ...(model ? ["--model", model] : []),
    "--setting-sources", "user",
    "--tools", "",
    "--system-prompt", SYSTEM,
  ];
}

/** `y`/`yes` on one line from a real terminal. Anything else is a no. */
async function askAtTerminal(stdin, stdout) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("spend it? [y/N] ");
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * Print the price, then ask, then — only then — spend.
 *
 * The estimate is `chars / 4`, stated AS an estimate and beside the char count
 * it came from, because a tokens number with no chars beside it is a number
 * the reader cannot check. Same rule as the narrative's.
 *
 * Exit 2 rather than 1 for "not confirmed": 1 is a failure and this is not one.
 * Nothing went wrong when a person declines to spend money — the caller should
 * be able to tell the two apart without parsing a message.
 *
 * An empty bundle is refused at the same exit code and for the same reason.
 * `rank`, `slope` and any other event whose subject is a series key carries no
 * file, so the prompt would be a question and the word "Evidence" over
 * nothing; offering to BUY that is worse than a failure, because a model will
 * answer it anyway and the answer will be about nothing. The estimate is
 * printed first regardless, so the refusal still says what was not spent.
 *
 * `spawn` is injected. The default is `spawnSync`; the test passes a counter
 * and asserts it stays at zero, which is the only way to check a guard.
 *
 * @param {ReturnType<typeof bundle>} b
 * @param {{confirm?: boolean, spawn?: Function, stdin?: object, stdout?: object,
 *          out?: (line: string) => void, root?: string, env?: object,
 *          write?: Function, now?: string}} opts
 * @returns {Promise<{code: number, spawned: number, path?: string, lines: string[]}>}
 */
export async function run(b, opts = {}) {
  const {
    confirm = false,
    spawn = spawnSync,
    stdin = process.stdin,
    stdout = process.stdout,
    out = (l) => console.log(l),
    root = process.cwd(),
    env = process.env,
    write = writeFileSync,
    now = new Date().toISOString(),
  } = opts;

  const lines = [];
  let spawned = 0;
  const say = (l) => { lines.push(l); out(l); };

  const tokens = Math.ceil((b?.chars || 0) / 4);
  say(`input ≈ ${nf(b?.chars || 0)} chars (~${nf(tokens)} tokens) across ${nf((b?.files || []).length)} file(s)`);
  if (b?.truncated) say(`${nf(b.truncated)} of ${nf((b.files || []).length)} piece(s) trimmed to stay under the ${nf(b.cap)}-char cap`);
  say(`answer would be written to ${outPath(b?.id)}`);

  if (!(b?.files || []).length) {
    say(
      `no evidence to send: the subject of ${b?.id ?? "this event"} names no file, so there is nothing to show a model. ` +
        `Nothing spent, nothing spawned; ${outPath(b?.id)} not written.`,
    );
    return { code: 2, spawned, lines };
  }

  let ok = confirm === true;
  if (!ok) {
    if (!stdin?.isTTY) {
      say(`not confirmed: no --yes and no terminal to ask at. Nothing spent, nothing spawned; ${outPath(b?.id)} not written.`);
      return { code: 2, spawned, lines };
    }
    ok = await askAtTerminal(stdin, stdout);
    if (!ok) {
      say(`declined. Nothing spent, nothing spawned; ${outPath(b?.id)} not written.`);
      return { code: 2, spawned, lines };
    }
  }

  const bin = resolveEnv(env, "CLAUDE_BIN").value || BIN_DEFAULT;
  const args = argvFor(env);
  spawned += 1;
  const res = spawn(bin, args, {
    cwd: root,
    input: b.prompt,
    encoding: "utf8",
    env,
    maxBuffer: 8 * 1024 * 1024,
  });

  const stdoutText = String(res?.stdout ?? "");
  let answer = stdoutText;
  try {
    const envelope = JSON.parse(stdoutText);
    if (envelope && typeof envelope.result === "string") answer = envelope.result;
  } catch {
    /* raw — an envelope that did not parse is still the best text there is */
  }
  answer = answer.trim();

  if (res?.status !== 0 || !answer) {
    // A failure is a SENTENCE and an exit code, never a half-written file: a
    // judgment file that exists is read as a judgment, and an empty one would
    // be read as "the model had nothing to say", which is a different claim.
    const detail = String(res?.stderr ?? "").trim() || `exit ${res?.status ?? "?"}`;
    say(`no answer came back (${detail}); ${outPath(b?.id)} not written.`);
    return { code: 1, spawned, lines };
  }

  const rel = outPath(b.id);
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const doc = [
    `# ${rel}`,
    "",
    `Event \`${b.id}\`${b.ref ? ` read at \`${String(b.ref).slice(0, 13)}\`` : ""} · asked ${now}`,
    `Evidence: ${nf(b.chars)} chars (~${nf(tokens)} tokens) across ${nf(b.files.length)} file(s) — ${b.files.join(", ")}`,
    "",
    "This is one model's reading of the evidence above, bought deliberately. It is",
    "not part of the series: nothing here is in the JSONL and nothing here applies",
    "itself.",
    "",
    answer,
    "",
  ].join("\n");
  write(abs, doc, "utf8");
  say(`judgment written to ${rel}`);
  return { code: 0, spawned, path: abs, lines };
}
