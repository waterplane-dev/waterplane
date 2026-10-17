---
name: host-spenders
description: waterplane host — every place this daemon buys a model call of its own, unattended (packages/host/src): `sidecar.ts` (the one engine seam; code in `sidecar/`), `review.ts`, `assess.ts` (code in `assess/`), `commitmsg.ts`, `naming.ts`, `prompts.ts` (a fork's own wording) and the halt gate every spender honours. Load BEFORE adding or changing any headless `claude -p` or sidecar call — its flags, prompt, timeout, engine route or apply path: this is the seam CLAUDE.md's rule about justifying every dropped flag guards, and where *nothing applies itself* is argued out.
---

# waterplane host — the unattended spenders

Every place the daemon spends on a model with nobody waiting, and the one engine seam they all route through. The rule to load this for is as much CLAUDE.md's on `claude -p` flags as the modules themselves. Router: `host`. Reasoning: [host.md](../../../docs/notes/host.md), [spender-split.md](../../../docs/notes/spender-split.md), [assess-architecture.md](../../../docs/notes/assess-architecture.md).

- `review.ts` — `check` / `validate` / `nextStep` / `continueWork`: verbs on work that has SETTLED.
  Verdicts in a sidecar keyed by intent id. A chosen next step POSTS its own intent.
- `sidecar.ts` + `sidecarroute.ts` + `sidecarclaude.ts` + `sidecartrust.ts` + `sidecaropenai.ts` + `sidecartasks.ts` + `sidecarname.ts` — (`sidecar.ts` is the facade over `sidecar/`: routing, the claude engine and its flags, the folder-trust refusal, the local engine, summary, naming+commit) the ONE place an UNATTENDED completion is bought: engines `claude-p` (today's
  headless call, moved verbatim — envelope, timeouts and `detectHeadlessLimit` unchanged) and
  `openai-compat` (one toolless POST to a local `{baseURL}/chat/completions`). Per-task routing via
  `WATERPLANE_SIDECAR_SUMMARY`/`_ASSESS`/`_REVIEW`/`_NAME`/`_COMMIT` (+ `_TIMEOUT_MS` 120000,
  `_MAX_TOKENS` 2048, `_API_KEY`), **every route defaulting to claude**. Only a task whose contract
  ALREADY forbids tools may take the local engine (`NEEDS_TOOLS` in `sidecarroute.ts`) — summary,
  `naming.ts` and commit by construction (their input is all IN the prompt); assess and review READ a
  repo, so they refuse it **in words naming the variable**, and a malformed spec refuses too, never
  falls back to claude (spending the token is the thing the knob exists to stop).
  **Every failure is the empty result the callers already treat as "no summary / no verdict"** —
  a refused route, a dead server, a non-2xx, a half-written body, or a reasoning model that spent
  its budget thinking and returned an empty `content`. Thinking is never the answer:
  `reasoning_content` is not read and `<think>` blocks are stripped. Generous `max_tokens` and a 120 s
  timeout because **ollama cold-loads an idle model**. **No limit phrase matching for the local
  engine** — it has no account. **Every spender gates on `halt.ts`'s `isHalted()`**
  (`sidecarclaude.ts`, `sidecaropenai.ts`, `usage.ts`), **and every spawned child registers with `trackRun`** (`sidecarclaude.ts`, `usage.ts`), so an emergency halt refuses a new call and kills a mid-review `claude -p`; a NEW spender copies the gate, and the `trackRun` too if it spawns. Base flags = `runSummaryTask`
  (the tab-name call is `sessions/record.ts`'s `nameTab`/`nameNow`, `host-core`); `runNameTask`/`runCommitTask` share
  `runTextTask`, which carries the measured argv (`--thinking disabled` included; the measurement
  table is a comment in `sidecarname.ts`) and drops none of `runSummaryTask`'s.
  **`runToolTask` refuses a folder Claude Code does not trust** (`workspaceTrust`): a tool task keeps
  project settings, and `claude -p` loads a repo's hooks WITHOUT the trust dialog.
  It READS `.claude.json` (`CLAUDE_CONFIG_DIR` honoured — tests point it at a fixture), never writes
  it; folder or any ancestor `true` = trusted, unreadable = refused. Never add a bypass knob.
  `usage.ts` (`host-ledgers`) is no sidecar but IS an unattended `claude` in a PTY: same halt gate,
  never started under `--doctor`.
  `packages/host/test/sidecar.test.mjs`, `scripts/e2e-sidecar.mjs`.
- `prompts.ts` — `promptText(name, fallback)`: `<config dir>/prompts/<name>.md` read PER CALL (never
  cached), the pinned default byte for byte when the file is absent, empty or unreadable. EVERY
  spender's instruction wording goes through it; only the wording is overridable, the JSON contracts
  the parsers read stay in code. A new unattended prompt is a new `promptText` name, documented in
  [host.md](../../../docs/notes/host.md#promptsts--customising-the-unattended-prompts-without-editing-core).
- `assess.ts` + `assess/hassrun.ts` + `assess/hassapply.ts` + `assess/hassexec.ts` + `assess/hassinput.ts` — "of the work still standing, what is still worth doing?" `assess.ts` is a facade; the code is `assess/`: `hassrun.ts` (the streamed run, `acceptEdits`, the buffer cap), `hassapply.ts` (the apply: `requeueFailed`, ONE kick, `fromNote`, `filed`, splits, `reorder`), `hassexec.ts` (the executor: live progress via the store's `setLive` — `hassstore.ts` — and the slot check via shared `findSlot`), `hassinput.ts` (`MAX_NEW`, the naming caps).
  **The contract is a FILE both
  ways.** `claude -p` is the completion signal and error channel, **never the content**.
  `assess-out.json` is **deleted before the run**; **fresh session**; `--permission-mode acceptEdits`.
  **Nothing here decides** — `shared/assess.ts` holds the verdicts. **Applying `still wanted` to a
  FAILED row PUTS IT BACK** (`requeueFailed`, BEFORE the ranks, then ONE `kick()`); a refusal, and a `settledAt` ≠ the `failedAt` this
  run stamped, are uncounted and never fail the apply. **EVERY run is STREAMED** — unwatched too, or
  `maxBuffer` kills it for succeeding loudly. `AssessProgress` is a READING: live ones memory+socket
  only (`setLive`), the last persists; its throttle has a TRAILING EDGE. A timeout ANSWERS at the
  deadline and kills the process **GROUP** — an orphan outlives `rmSync` and writes a STALE out file.
  **The prompt's naming caps are INTERPOLATED** from `shared/naming.ts`'s constants (`MAX_HEADLINE_CHARS`). Existing rows are
  titled only under `writeNames`, through `intents.name(…, "assess")`, which REFUSES a `hand` field;
  `counts.named` is what was WRITTEN, not offered. A POSTED row is titled whatever the answer was
  and wears no `merge of N: …` label (`label` means "the name a person gave this"). **A `wanted` PAD
  NOTE is OFFERED as a post carrying its own words** — synthesised by `cleanAssessment` from the
  item's own `text` (`AssessNew.fromNote`), never read off the CLI's `new` (a `new` repeating a
  note verbatim is DROPPED), exempt from `MAX_NEW`, and posted with **NO `label`**.
  **The host still never reads or writes `waterplane.pad`** — `fromNote` travels so the PHONE clears the
  note on the receipt, and **the receipt NAMES which ones landed** (`AssessApplyOutcome.filed` →
  `op.ack`'s `filed?: string[]`, remembered in `acks.ts` so a replay says the same): **absent means
  this host cannot tell you, so assume nothing was filed**, while `[]` is the opposite claim (it
  can, and nothing was). **Slot check** ([host.md](../../../docs/notes/host.md#the-slot-check--sharedintentslotts-and-the-assessments-conflictsplit)):
  a slot run judges ONLY the caller's ids, each confirmed in `findSlot`'s LIVE slot (else, or <2,
  refused, nothing bought); a split posts both halves on the original's trigger, THEN ARCHIVES it,
  never cancels, and is refused if a row chains `after` it; a conflict has no apply branch. A stop sets every unstarted half aside; a merge takes the members' lowest seat and carries their `latestClock` or is refused in words; count a post only if `intents.post` accepted it — never `ok:true` for an apply that posted nothing. The assess argv has NO
  `--thinking disabled` — unmeasured for a tool run.
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
  runs DETACHED** — a long pass must not outlive the ack deadline and be shown as failed.
  One pass per repo, refusals in WORDS, `running` is TRANSIENT and locks nothing. Every failure is
  the empty result. `naming.test.mjs` · `scripts/e2e-naming.mjs`.
