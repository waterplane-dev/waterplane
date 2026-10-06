---
name: host-spenders
description: waterplane host — every place this daemon buys a model call of its own, unattended (packages/host/src): `sidecar.ts` (the one engine seam and its routing knobs), `review.ts`, `smartpick.ts`, `assess.ts`, `commitmsg.ts`, `naming.ts`. Load BEFORE adding or changing any headless `claude -p` or sidecar call — its flags, prompt, timeout, engine route or apply path: this is the seam CLAUDE.md's rule about justifying every dropped flag guards, and where *nothing applies itself* is argued out.
---

# waterplane host — the unattended spenders

Every place the daemon spends on a model with nobody waiting, and the one engine seam they all route through. The rule to load this for is as much CLAUDE.md's on `claude -p` flags as the modules themselves. Router: `host`. Reasoning: [host.md](docs/notes/host.md).

- `review.ts` — `check` / `validate` / `nextStep` / `continueWork`: verbs on work that has SETTLED.
- `smartpick.ts` — **the look a repo takes over its own waiting items before one of them fires**, and
  the only place CLAUDE.md's *nothing applies itself* is knowingly excepted (the user chose it, with
  the trade-off in view). The guard ladder IS the correctness and its order is fixed: un-ticked repo
  ⇒ a `Set` lookup and NOTHING else (**an un-ticked repo costs exactly zero** — no git, no
  fingerprint, no file read) · not a candidate row · **already in flight for this cwd ⇒ hold**, with
  no git, no fingerprint and not even the candidate list (the second row of a repo reaches the hook
  in the SAME pass — `serial` only bites after a claim) — **asked BEFORE "fewer than 2 candidates",
  because the other order let a sibling LEAVING the list mid-pass release the held row and start it
  under its own running pass** · a merged row inside `MERGE_HOLD_MS` (30 s) ⇒ hold, so **the pick is
  never a row the pass itself just wrote** · fewer than 2 candidates · fingerprint unchanged ⇒ `null`
  · the churn floor.
  **EVERY failure fires the original order** — timeout (its own 20 s watchdog, not only the child's),
  failed, limited, unreadable, a late answer — each recorded against the fingerprint the pass STARTED
  on, so the next tick reads "nothing changed" and the item fires as it was; an applied pass records
  the fingerprint it LEFT BEHIND, or the repo buys a completion per tick for ever — **and a THROW
  inside `finish()` records too** (the `.catch` had already been released and wrote nothing, so the
  same doomed pass was bought every tick). **The fingerprint is asked AGAIN when the answer lands**:
  nothing is held while a pass thinks, so an edit, a cancel, a reorder or a hand fire in those ~3 s
  makes the answer about a list that no longer exists — applied, it posted a merge of the OLD words
  over words somebody had just typed. Changed ⇒ `late`, recorded against the CURRENT fingerprint so
  the next tick fires the order the person has now. **Nothing is ever
  destroyed**: a merge `edit({archived:true})`s its originals — never cancel, dismiss or remove — and
  `SmartPickIntents` is narrowed so those verbs are not even reachable. Apply order is
  record-`applying` FIRST → post the merged row (`mg<sha1(passId+ids)>`, deterministic so a replay
  cannot make a second row) → archive → rewire every `after` chain naming a member (an archived
  predecessor never settles: a stranded chain waits for ever) → `applied` → sort; `finishApplying()`
  completes an interrupted one on boot, every step being idempotent; a post the store REFUSES closes
  its record `refused` rather than leaving it `applying` for boot to retry for ever. **`undo` works
  AFTER the merged row has run** — the sleeper's case, since the pass picks and applies in one
  breath: not run ⇒ the machine-written row is REMOVED; run or running ⇒ it is ARCHIVED (never
  removed — it is the only account of the session that ran it), a running one is NOT stopped, and the
  answer SAYS the originals will run again. Either way it restores each member's previous `order` AND
  previous `archived` (not always `false`), **re-points the chains FIRST and touches the merged row
  LAST** (the other order failed every chain but the first — `update()` kicks a synchronous pass and
  the merged row was already out of `rows` AND out of `knownIntents`), and remembers the id-set + the
  member TEXTS so the same merge is never proposed twice — edit an item and it is offered again.
  **A one-off with a clock IS a candidate** (`isTimedWorkRow` — that was the whole ask), so the pass
  sees it with its `at` in the prompt; the rules are `shared/smartpick.ts`'s and are all refusals
  (slot pinned, never the pick, merged only with a twin on the identical `timedWorkKey`), the
  fingerprint carries `atKey` so a re-timed row is not read as unchanged, and `MergeRecord` carries
  the `trigger`+`holdForHost` so the merged row and a BOOT REPLAY of it both wait on that clock
  instead of on `idle`. **The HOLD is asked SEPARATELY from the clock**, because `timedWorkKey` speaks
  for it only on a row that HAS one and *drop the clock* keeps the hold on a row that has not: two of
  those compared equal at `""`, the merge was waved through, and the row that replaced two held rows
  held nothing and fired while another repo's item was mid-turn. Candidate field, a refusal in
  `cleanSmartPick`, a re-ask against the LIVE rows at apply time, and its own place in the
  fingerprint. **This pass is not a send**: no
  `deliver`, no `session.input`, `--tools ""`. Cost is THINKING, not input (measured: a trivial haiku
  reply = 548 thinking tokens, $0.0049), so `SMARTPICK_SYSTEM` says *answer straight away* and that
  paragraph is pinned. `smartpick.test.mjs` · `smartpickstore.test.mjs` · `smartpickchains.test.mjs`
  (the real store, where an undo's kicks are synchronous) · `pickhold.test.mjs`.
  Verdicts in a sidecar keyed by intent id. A chosen next step POSTS its own intent.
- `sidecar.ts` + `sidecarroute.ts` + `sidecarclaude.ts` + `sidecartrust.ts` + `sidecaropenai.ts` + `sidecartasks.ts` + `sidecarname.ts` — (`sidecar.ts` is the facade over `sidecar/`: routing, the claude engine and its flags, the folder-trust refusal, the local engine, summary+smart pick, naming+commit) the ONE place an UNATTENDED completion is bought: engines `claude-p` (today's
  headless call, moved verbatim — envelope, timeouts and `detectHeadlessLimit` unchanged) and
  `openai-compat` (one toolless POST to a local `{baseURL}/chat/completions`). Per-task routing via
  `WATERPLANE_SIDECAR_SUMMARY`/`_ASSESS`/`_REVIEW`/`_SMARTPICK`/`_NAME`, **every one defaulting to
  claude**. Only a task whose contract ALREADY forbids tools may take the local engine — the
  summary, the smart pick and `naming.ts` by construction (their input is all IN the prompt); assess
  and review READ a repo, so they refuse it **in words naming the variable**, and a malformed spec
  refuses too, never falls back to claude (spending the token is the thing the knob exists to stop).
  **Every failure is the empty result the callers already treat as "no summary / no verdict"** —
  a refused route, a dead server, a non-2xx, a half-written body, or a reasoning model that spent
  its budget thinking and returned an empty `content` (measured: 421 of 451 tokens). Thinking is
  never the answer: `reasoning_content` is not read and `<think>` blocks are stripped. Generous
  `max_tokens` and a 120 s timeout because **ollama cold-loads an idle model**. **No limit phrase
  matching for the local engine** — it has no account. `runNameTask` is `runSmartPickTask`'s argv
  VERBATIM (`--thinking disabled` included) and drops none of `runSummaryTask`'s (the tab-name call's).
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
  can, and nothing was).
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
