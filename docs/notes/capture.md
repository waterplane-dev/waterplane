# Capture — the verified screenshot loop

The *why* behind `packages/host/src/capture.ts`, its backends, and the instruction preset that ships
with it. The rules are one line each in `.claude/skills/host-machine/SKILL.md`; everything here is the
reasoning that line was trimmed of.

## The modules

| module | what it is |
| --- | --- |
| `capture.ts` | `CaptureManager` — the config store (`<repo>/.waterplane/capture.json`), the run lifecycle over `intents/`, the capture loop, the sidecar, the verdict line. `builds.ts`' shape, deliberately. |
| `capture/types.ts` | the `CaptureBackend` seam (`probe` / `leaseKey` / `frame` / `oracle`) plus the minimal local Playwright typings, so nothing is added to `@types`. |
| `capture/web.ts` | a browser, via Playwright resolved at runtime. Viewport and theme emulation, DOM anchor oracle, error-overlay detection, console + network collectors. |
| `capture/android.ts` | `adb exec-out screencap`, with `uiautomator dump` as the oracle. |
| `capture/garmin.ts` | shells out to ciqkit (`sim shot`, `shot-score`). Never imported, never vendored. |
| `capture/window.ts` | a desktop window or the whole screen. **No oracle exists here**, which is the whole story of its verification ceiling. |
| `capture/pixels.ts` | the shell-out pixel toolkit — frame equality, blank/variance floor, changed-percent. Every answer degrades to `null`. |
| `visualskill.ts` | the instruction preset written into a repo as the `visual-check` compliance fix: how an agent should LOOK at a frame without paying for it on every remaining turn. |

## Why the loop is verify → settle → diff → emit

Four questions in the order that makes the later ones cheap, and each one able to end the run:

1. **Verify** — can this capture be believed at all? A target with an anchor has an oracle; one
   without has only pixels. The answer sets the *ceiling* on what the run may claim, and it is
   decided before a frame is kept rather than asserted afterwards.
2. **Settle** — is the screen finished? A frame taken mid-animation, mid-layout or mid-fetch is not
   a wrong frame, it is a frame of something that no longer exists. Everything downstream — the
   diff, the anchor, the score — is measuring a transient if this step is skipped.
3. **Diff** — is this frame different from the last one? A capture identical to the one before it
   answers no question anybody has.
4. **Emit** — only now write the PNG and the sidecar into `.claude/outbox/`.

Running them in any other order costs something real. Diffing before settling compares two arbitrary
moments of the same animation and reports a change that means nothing. Emitting before diffing puts
the frame in front of a person — and, if they hand it on, in front of a model — before anyone has
established it was worth looking at.

## Why settle is frame-stability and never a fixed timeout

A fixed sleep is wrong in both directions and cannot be tuned out of being wrong. Too short and it
captures a skeleton loader; too long and every run in a watch loop pays the worst case for ever. The
number that would be right is a property of the screen, not of the config.

So `settleMs` is a **cap on the wait, never the wait itself**: frames are sampled until two
consecutive ones are identical, and the run proceeds the moment they are. `frames.stableAfterMs` in
the sidecar records when that happened, and is **absent** when it never did — a run that hit the cap
without settling says so instead of pretending the last frame was the settled one.

This is the same rule `deliver.ts` follows for echo: poll for the evidence, do not sleep for the
duration you guess the evidence takes.

## Why the diff gate is load-bearing and not polish

The obvious reading is disk hygiene — do not fill `.claude/outbox/` with 300 identical PNGs. That is
true and it is not why the gate exists.

The gate is **token hygiene**. Every frame emitted is a frame that can be picked up: by the gallery
badge, by a person scrolling, and — the expensive one — by an agent that decides to look. An image
costs roughly `(width x height) / 750` tokens, and because every turn re-sends the whole
conversation, it is not paid once but **again on every remaining turn of the session**. A watch loop
that emits every frame is not a full disk; it is a pile of loaded guns pointed at a context window.

So a frame is emitted only past `diffPct`. And when there is no pixel tool on the machine, the gate
**degrades to "emit every frame, capped, and say so"** — never to silently emitting nothing. A gate
that fails closed is a capture loop that produced no evidence and did not mention it, which is worse
than the disk it was protecting.

## Why the default output is a text verdict and not an image

The verdict line is the product. The image is the fallback.

```
verified:anchor · score 91 · 390x844 dark · console: clean · net: clean
```

That is roughly 50 tokens, against ~440 for the 390x844 frame it describes and ~1,730 for a desktop
one — and it survives being re-sent on every remaining turn in a way the frame does not. It also
answers the questions that are actually being asked in a development loop, which are mechanical
rather than aesthetic: did it render, is the expected text there, did anything error, did it change.

Hence `POST /api/repos/:id/capture/run` with `{"wait":true}` answering the verdict **in the response
body**. An agent that can get the sentence over HTTP never has to open the picture, and the picture
is still on disk for the person holding the phone, whose judgement on "does this look right" beats
the model's and costs nothing at all.

The grammar is derived in one place, host-side, and pinned by a test. Two copies of a verdict
grammar is two answers to "what did this run find".

## Why a `window` capture can never claim `verified:*`

The levels are `verified:anchor`, `settled:stable`, `unverified`, plus the terminal
`error-overlay:<kind>` and `blank`. The word **verified is reserved for the anchor level**, because
an anchor is the only rung with an oracle: something outside the pixels asserted that the expected
text is on the screen.

`capture/window.ts` has no oracle and cannot have one. It receives a rectangle of the desktop; there
is no DOM to query, no `uiautomator dump`, no simulator reporting what it drew. Two identical
consecutive frames prove the screen stopped moving and nothing more, so the ceiling is
`settled:stable`.

This is the repo's standing rule applied to a new reader: **heuristics degrade to null or absent,
never to a wrong number**. A `window` backend that answered `verified:anchor` off a pixel match would
be inventing the one fact the level exists to carry. The same rule puts `score` and `theme` out of
the sidecar entirely when nothing could measure them — **absent, never `0`, never `"light"` as a
default**.

## Why Playwright is an optional lazily-resolved dep and not a root dependency

`thumbs.ts` already made this decision and it is being followed, not re-litigated. Node has no image
decoder, `sharp` never gets added, and the tools that do the work (`sips`, `magick`, `ffmpeg`) are
probed once, lazily, and their absence degrades the answer rather than the daemon.

Playwright is the same shape and worse: it is heavy, it downloads browsers, and **most repos on this
machine have no web target at all**. Putting it in the root `package.json` would charge every
`npm install` in the monorepo — including the Garmin and Android repos this loop also serves — for a
backend they will never invoke.

So it is resolved at runtime through `createRequire` with a **variable** specifier (a static
`import("playwright")` of a non-dependency fails module resolution under `tsc --strict`, which is why
the typings in `capture/types.ts` are local and `any`-shaped rather than pulled from `@types`).
Resolution order is the target repo's own `node_modules` first, then the host's: a repo that already
tests with Playwright has the right version pinned, and the host's copy is the fallback, not the
authority.

Both miss ⇒ the backend reports `{ available: false, reason }` — **a sentence, never a boolean** —
and every other backend keeps working. The phone renders that sentence through `Unavailable.tsx`.
Never a greyed-out button: a `title` is invisible on a phone, and "web needs Playwright, and here is
how to get it" is the only form of that fact anyone can act on.

## Why ciqkit is shelled out to and never imported or vendored

ciqkit is an **independent project**. It has its own CI, its own release cycle, its own broker and
its own self-spawning simulator daemon, and it has to keep working on machines where waterplane does not
exist. The moment waterplane imports it, ciqkit's test matrix grows a dependency on this repo's module
graph and its releases start being gated on a phone client — for nothing.

Vendoring is worse than importing. A vendored copy is a fork that nobody remembers is a fork: it goes
stale silently, and the failure mode is a Garmin capture that disagrees with the simulator run the
developer did by hand on the same repo ten minutes earlier.

So the coupling is a **process boundary and two agreements**:

- the **sidecar JSON** ciqkit writes (`anchor_confirmed` and friends), and
- **shot-score semantics** — an advisory 0-100, where absent means unscorable and never `0`.

Plus the exit codes, which carry a distinction worth keeping: `0` captured, `1` the job failed, and
**`3` captured but the anchor was contradicted**. Exit 3 is not a hard failure — a frame exists and
it is evidence. It downgrades the level and records `anchor.missing`, which is exactly the shape of
"the screen is real and it is not the screen you expected", the most useful thing this loop can ever
say.

`WATERPLANE_CIQKIT_BIN` overrides the binary, which is also what lets e2e point at a stub and pin the
downgrade path without a simulator.

## Why targets live in `.waterplane/capture.json` and not as `buildscan.ts` markers

`buildscan.ts` answers "what can this REPO build" by reading its manifests. That granularity is
correct for builds and wrong for captures.

The measured case: a Garmin monorepo holds **16 apps under one repo**. Each has its own project
directory, its own device, its own screen names. A per-repo marker can express one of those sixteen;
expressing all sixteen means sixteen repos, which is not how the work is organised, or a marker
format that grows an array — at which point it is a config file with extra steps.

So capture targets are an explicit per-repo LIST, each entry carrying its own `dir` (contained to the
repo, like `BuildConfig.dir`), `anchor`, and backend-specific fields. It sits next to `builds.json`
in `.waterplane/` for the same reason that file does: it describes what this repo can be asked to do, it is
edited from the phone, and it is the repo's business rather than the host's.

The second reason is that **a capture target cannot be inferred**. `buildscan.ts` can offer a gradle
task because the build file is evidence for it, and it **invents nothing** where there is no
evidence. Nothing in a repo's manifests says which screen matters or what text should be on it. That
is a judgement, so it is typed in once and stored, never guessed.

Unknown `backend` ⇒ the row is **refused in words naming the known ids**, never silently coerced —
`resolveBackend()`'s rule, for `resolveBackend()`'s reason: a capture that ran something other than
what was asked for and said nothing is the failure mode.

## Why error-overlay frames are kept

The instinct is to treat a Vite HMR overlay, a Next.js error portal or a React error boundary as a
failed run and bin the frame. That is the one moment the frame is most valuable.

A run whose evidence was deleted **cannot be debugged from a phone**, which is the entire premise of
this app. So the overlay is the *verdict* — `error-overlay:vite-hmr` — the intent row settles
`failed`, and the PNG lands in `.claude/outbox/` anyway, flagged, with the overlay text captured into
the sidecar. Fail loud and destroy the evidence are two different things, and only one of them is a
rule here.

The sidecar's `errorOverlay` is **absent when the frame is clean**, like everything else that could
not be measured.

## The sidecar

Written beside the PNG via `newOutboxPath(wt, "capture-<targetId>", ".json")` — both extensions are
already in `files.ts`'s `DOC_EXT`/`IMAGE_EXT`, so the gallery, the unseen-outbox badge, `thumbs.ts`
and `download.ts` carry it with no changes at all.

```jsonc
{
  "v": 1,
  "runId": "cr_ab12cd34",                        // IS the intent id
  "target": { "id": "t_home", "name": "watchapp - home", "backend": "garmin" },
  "startedAt": 1757745600000, "finishedAt": 1757745612000,
  "verification": "anchor" | "stable" | "unverified",
  "anchor": { "wanted": ["TOTAL"], "found": ["TOTAL"], "missing": [] },  // ABSENT with no anchor
  "score": 91,                     // 0-100 advisory, ciqkit semantics. ABSENT when unscorable.
  "viewport": { "w": 390, "h": 844 },
  "theme": "dark",                 // ABSENT when unknown (android / garmin / window)
  "frames": { "sampled": 3, "stableAfterMs": 1300 },   // stableAfterMs ABSENT when never stable
  "errorOverlay": { "kind": "vite-hmr", "text": "…" }, // ABSENT when clean
  "console": { "errors": 0, "warnings": 2, "lines": ["…"] },  // web only, capped; ABSENT elsewhere
  "network": { "failed": 0, "lines": [] },                    // web only; ABSENT elsewhere
  "diff": { "againstRelPath": ".claude/outbox/capture-t_home-….png", "changedPct": 12.4 },
  "files": [ { "relPath": ".claude/outbox/capture-t_home-2026-09-13-….png", "w": 390, "h": 844 } ],
  "verdict": "verified:anchor · score 91 · 390x844 dark · console: clean · net: clean"
}
```

Every path in it is a **full transport path**. That is the repo-wide convention and it is mechanical
rather than stylistic: `.claude/outbox/capture-t_home-….png` is what a reader turns into the picture,
and a bare filename resolves only when the listing happens to hold exactly one media file by that
name — never in prose, and never reliably twice.

## The ladder, and why it ships as a file in the repo

`visualskill.ts` writes `.claude/skills/visual-check/SKILL.md` into a repo, as the `visual-check`
compliance fix. In brief, the preset says: use the cheapest rung that answers the question.

1. **A deterministic check** — zero tokens, cannot hallucinate. Pixel diff, blank/variance floor and
   shot-score, a DOM/uiautomator/OCR anchor, the console and network sidecar. Most questions in a
   development loop are mechanical, and this rung answers them.
2. **A text verdict** (~50 tokens) — capture's default output, and the rung to prefer.
3. **The person's own eyes, through the phone gallery** — zero model tokens, because artifacts in
   `.claude/outbox/` are looked at over HTTP and never enter a conversation. A contact sheet belongs
   here and never in a conversation: six tiles still cost ~1,730 tokens and each tile is too small to
   read.
4. **A subagent**, which burns the image in its own window and returns a sentence — worth it for many
   frames, a long-lived parent session, or a judgement that can be written into a prompt. Its
   break-even has a numerator people forget: a subagent pays a fresh system prompt and tool schemas
   before it looks at anything.
5. **Look at it yourself** — legitimate for one small frame in a short session or a tight visual
   loop. The most expensive rung, and a choice rather than a reflex.

Three things about how it is delivered are deliberate:

- **It is a file in the target repo**, not a paragraph on the host. The agent that needs the rule is
  the `claude` process running in that repo, and it reads that repo's `.claude/skills/`. A rule the
  agent never loads is a rule that does not exist.
- **It is a user-tapped compliance fix**, because that is the only sanctioned way anything writes
  into an existing repo — `scaffold.ts` seeds only NEW repos and `setupwatch.ts` never writes at all.
  Additive, idempotent, and it never overwrites an existing copy: the preset asks its reader to
  measure the subagent baseline on this machine and edit the number in, and a re-run that rewrote the
  file would delete the only part of it that was ever true here.
- **It is offered only where capture is configured.** Configuring a target IS the opt-in. Emitting
  the row for every repo would be advice about a loop that repo does not run — a warn nobody can
  close, which is the same failure `summarize()` keeps the host-scope Gemini row out of the badge
  for. `compliance.ts` reads `.waterplane/capture.json` **defensively** (parse in a `try`, check the shape,
  anything unreadable answers zero targets): that file is written by a client that may be older or
  newer than this daemon, and a checklist that threw on a malformed config would take the whole setup
  sheet down with it.
