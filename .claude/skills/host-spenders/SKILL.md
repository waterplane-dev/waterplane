---
name: host-spenders
description: waterplane host — every place this daemon buys a model call of its own, unattended (packages/host/src): `sidecar.ts` (the one engine seam and its routing knobs), `review.ts`, `assess.ts`, `commitmsg.ts`, `naming.ts`. Load BEFORE adding or changing any headless `claude -p` or sidecar call — its flags, prompt, timeout, engine route or apply path: this is the seam CLAUDE.md's rule about justifying every dropped flag guards, and where *nothing applies itself* is argued out.
---

# waterplane host — the unattended spenders

Every place the daemon spends on a model with nobody waiting, and the one engine seam they all route through. The rule to load this for is as much CLAUDE.md's on `claude -p` flags as the modules themselves. Router: `host`. Reasoning: [host.md](docs/notes/host.md).

- `review.ts` — `check` / `validate` / `nextStep` / `continueWork`: verbs on work that has SETTLED.
  Verdicts in a sidecar keyed by intent id. A chosen next step POSTS its own intent.
- `sidecar.ts` + `sidecarroute.ts` + `sidecarclaude.ts` + `sidecartrust.ts` + `sidecaropenai.ts` + `sidecartasks.ts` + `sidecarname.ts` — (`sidecar.ts` is the facade over `sidecar/`: routing, the claude engine and its flags, the folder-trust refusal, the local engine, summary, naming+commit) the ONE place an UNATTENDED completion is bought: engines `claude-p` (today's
  headless call, moved verbatim — envelope, timeouts and `detectHeadlessLimit` unchanged) and
  `openai-compat` (one toolless POST to a local `{baseURL}/chat/completions`). Per-task routing via
  `WATERPLANE_SIDECAR_SUMMARY`/`_ASSESS`/`_REVIEW`/`_NAME`, **every one defaulting to
  claude**. Only a task whose contract ALREADY forbids tools may take the local engine — the
  summary and `naming.ts` by construction (their input is all IN the prompt); assess
  and review READ a repo, so they refuse it **in words naming the variable**, and a malformed spec
  refuses too, never falls back to claude (spending the token is the thing the knob exists to stop).
  **Every failure is the empty result the callers already treat as "no summary / no verdict"** —
  a refused route, a dead server, a non-2xx, a half-written body, or a reasoning model that spent
  its budget thinking and returned an empty `content` (measured: 421 of 451 tokens). Thinking is
  never the answer: `reasoning_content` is not read and `<think>` blocks are stripped. Generous
  `max_tokens` and a 120 s timeout because **ollama cold-loads an idle model**. **No limit phrase
  matching for the local engine** — it has no account. `runNameTask`/`runCommitTask` share `runTextTask`, which carries the measured argv
  (`--thinking disabled` included; the measurement table is a comment in `sidecarname.ts`) and drops none of `runSummaryTask`'s (the tab-name call's).
  **`runToolTask` refuses a folder Claude Code does not trust** (`workspaceTrust`): a tool task keeps
  project settings, and `claude -p` loads a repo's hooks WITHOUT the trust dialog (measured 2.1.289).
  It READS `.claude.json` (`CLAUDE_CONFIG_DIR` honoured — tests point it at a fixture), never writes
  it; folder or any ancestor `true` = trusted, unreadable = refused. Never add a bypass knob.
  `packages/host/test/sidecar.test.mjs`, `scripts/e2e-sidecar.mjs` (a ten-line HTTP stub; CI needs
  no ollama).
- `assess.ts` — "of the work still standing, what is still worth doing?" **The contract is a FILE both
  ways.** `claude -p` is the completion signal and error channel, **never the content**.
  `assess-out.json` is **deleted before the run**; **fresh session**; `--permission-mode acceptEdits`.
  **Nothing here decides** — `shared/assess.ts` holds the verdicts. **Applying `still wanted` to a
  FAILED row PUTS IT BACK** (`requeueFailed`, BEFORE the ranks, then ONE `kick()` — a kick per row
  fired row 1 before the ranks or a pick existed); a refusal, and a `settledAt` ≠ the `failedAt` this
  run stamped, are uncounted and never fail the apply. **EVERY run is STREAMED** — unwatched too, or
  `maxBuffer` kills it for succeeding loudly. `AssessProgress` is a READING: live ones memory+socket
  only (`setLive`), the last persists; its throttle has a TRAILING EDGE. A timeout ANSWERS at the
  deadline and kills the process **GROUP** — an orphan outlives `rmSync` and writes a STALE out file.
  **The prompt's naming caps are INTERPOLATED** from `naming.ts`'s constants. Existing rows are
  titled only under `writeNames`, through `intents.name(…, "assess")`, which REFUSES a `hand` field;
  `counts.named` is what was WRITTEN, not offered. A POSTED row is titled whatever the answer was
  (its prompt is the run's own words) and no longer wears a `merge of N: …` label — that was machine
  bookkeeping in `label`, which means "the name a person gave this"; existing rows keep theirs, no
  migration. **A `wanted` PAD NOTE is now OFFERED as a post carrying its own words** — synthesised by
  `cleanAssessment` from the item's own `text` (`AssessNew.fromNote`), never read off the CLI's `new`
  (a `new` repeating a note verbatim is DROPPED), exempt from `MAX_NEW`, and posted with **NO
  `label`** (`from an assessment` over a person's own sentence is a lie `itemHeadline` would show
  above it). Detail says `N filed from the pad` beside `N pad note(s) judged and left on the pad`.
  **The host still never reads or writes `waterplane.pad`** — `fromNote` travels so the PHONE clears the
  note on the receipt, and **the receipt NAMES which ones landed** (`AssessApplyOutcome.filed` →
  `op.ack`'s `filed?: string[]`, remembered in `acks.ts` so a replay says the same). `intents.post`
  refuses on its own (`PENDING_MAX`, an unrunnable draft) and the loop `continue`s, so `ok:true` was
  true of an apply that posted NOTHING — three ticked offers, three notes tombstoned, no row
  anywhere. This is the one pad delete taken on a REMOTE receipt instead of a durable local copy,
  which is why it is the one that loses words. The phone clears `ticked ∩ filed`; **absent means
  this host cannot tell you, so assume nothing was filed**, while `[]` is the opposite claim (it
  can, and nothing was). **Slot check** ([host.md](docs/notes/host.md#the-slot-check--sharedintentslotts-and-the-assessments-conflictsplit)):
  a slot run judges ONLY the caller's ids, each confirmed in `findSlot`'s LIVE slot (else, or <2,
  refused, nothing bought). A split posts both halves (ids hashed from run+sid) on the
  original's trigger, THEN ARCHIVES it, never cancels — refused if a row chains `after` it; any stop
  sets every unstarted half aside; a slot merge sits at its members' lowest seat; a conflict has no apply branch; a merge
  carries `latestClock` of its one-off members or is refused in words; a slot's order is
  `backlogedits.reorder`. The assess argv has NO `--thinking disabled` — unmeasured for a tool run.
- `commitmsg.ts` — **the commit message the Review sheet's button asks for**: the tab-name call
  wearing a different prompt, and literally the same function (`sidecar.ts`'s `runCommitTask` IS
  `runNameTask`, second routing knob), so the measured flags cannot drift into a second copy. TAPPED,
  never unattended — hence the timeout knob the naming pass deliberately lacks. The diff is
  `git.ts`'s **`gitPendingDiff`, never `gitReviewDiff`** (that one diffs against MAIN and would
  describe work already committed on a feature branch); untracked files arrive as NAMES, and the
  prompt SAYS so. The repo's last ten `%s` subjects ride along as the house style, because
  `--setting-sources user` drops the CLAUDE.md that would otherwise have to carry it. **It writes
  nothing** — no commit, no stage, no file — and every failure is a SENTENCE, never an empty box.
  `shared/naming.ts`'s `cleanCommitMessage` is the rule half: an attribution trailer is DROPPED
  silently (on a person's commit it is a false claim about who wrote the change), an over-long
  subject REFUSES rather than clips (`git log` shows that line for ever).
- `naming.ts` — what an untitled backlog row is CALLED: one toolless pass (`WATERPLANE_NAME_MODEL`,
  `--thinking disabled`) writing a 3–8 word headline and one of four kinds. **A name a PERSON typed
  is NEVER replaced** — `name()` refuses a `hand` field PER HALF (a hand title still takes a missing
  kind), and a typed `label` IS a title (`itemHeadline`'s own test), so nothing is bought for a row
  the display rule would never show it on. `edit()`'s `""` clears value AND author ("nobody has
  said"); a title the cleaner REFUSES writes nothing and **SAYS so** — dropping typed words in
  silence is the quiet half of the same rule. **Words go in WHOLE** — an over-budget item is a batch
  of ONE: a title off a clip is the truncation `cleanHeadline` refuses. **`begin()` acks, the pass
  runs DETACHED** — 10 batches × 120 s against a 20 s ack deadline is a working pass shown as failed.
  One pass per repo, refusals in WORDS, `running` is TRANSIENT and locks nothing. Every failure is
  the empty result. `naming.test.mjs` · `scripts/e2e-naming.mjs`.
