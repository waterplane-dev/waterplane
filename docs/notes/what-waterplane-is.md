# What waterplane actually is, what's unique about it, and where to push

A strategic read of the codebase as it stands, written for the person deciding what to build next.
Opinionated on purpose. Where I'm guessing about the outside world rather than reading the repo, I
say so.

---

## 1. The one-sentence version

**waterplane turns the desktop you already work on into something you can drive from a phone on a bad
link, by remote-controlling the real `claude` binary in a pseudo-terminal instead of
re-implementing it.**

Everything interesting downstream comes from those two commitments — *your desktop* and *the real
binary* — plus a third that isn't in the pitch but is most of the code: *the link is unreliable, and
the app has to keep being honest when it is*.

---

## 2. What is genuinely unique

Ranked by "how hard would this be for someone else to copy", which is a better question than "how
cool is it".

### 2.1 The offline send queue with at-most-once delivery — the real moat

This is the thing. Nothing else here is close.

A prompt typed in a tunnel is delivered **exactly once**, in order, possibly hours later, possibly
across a host restart, a phone reload, and a browser that killed the tab. That property is not one
feature; it is about fifteen interlocking rules, each of which exists because the naive version
produced a specific, ugly failure:

- lanes, so a PTY composer never gets two writes concatenated into one line
- an ackId ledger **persisted** host-side (`acks.json`, TTL longer than the client's), so a retry
  that races the first delivery is re-acked rather than re-typed
- four honest delivery verdicts — `ok` / `retry` / `unconfirmed` / `unsubmitted` — where only one is
  auto-retryable, and the two ambiguous ones are later *settled* against the CLI's own conversation
  log rather than guessed at
- attempts rolled back when the socket wasn't actually open, so an outage doesn't spend the give-up
  budget
- retirement that is never a delete (`retireToPad`)
- and a named ledger of the sends that gave up, because a *count* of failures is the one number
  nobody can act on

**Why it's a moat:** every one of these is a lesson, not a design. You cannot spec them up front.
Anyone building this fresh ships the naive version, and their users lose prompts for a year before
they learn the same list. That's a real head start — and it compounds, because each rule makes the
next feature safe to build on top.

### 2.2 It drives the actual binary

Every slash command, the context meter, plan mode, trust prompts, `/resume`, MCP, hooks, whatever
ships next Tuesday — all work with no integration effort, because there is no integration. The app
is a terminal and a set of *observers* over that terminal.

The cost is honest and visible in the code: `prompt.ts`, `limit.ts`, `context.ts` are regex
heuristics over TUI output, and they are fragile by construction. The mitigation is the interesting
part, and it's a genuine engineering position rather than a hope:

- every heuristic **degrades to null/absent, never to a wrong number**
- each is pinned by an e2e script against a stub TUI that deliberately misbehaves
  (`repaint` / `blind` / `deaf` / `paste` / `menu`)
- and the hard signals are taken from hooks (`Stop`, `UserPromptSubmit`) whenever the pipe is live,
  with silence heuristics only as the fallback — and the code says out loud, in the UI, when it is
  guessing

That last habit is the actual house style, and it's worth naming: **the app distinguishes "I know"
from "I'm guessing" everywhere, and tells the user which one it's doing.**

### 2.3 The handover: work that survives the phone being closed

`launch.ts` is the sharpest single idea in the repo. A `session.create` carrying `needs` (the files
its prompt names) is not spawned on receipt — it is persisted, acked, and opened by the **host**
when the last file lands. Hours later. With the phone off.

Before it, the ordering lived in the browser's send queue: thirty minutes of bad tunnel failed the
upload, and the create and every prompt behind it failed with it, while the desktop — which had
nothing else to do — never knew the work was supposed to happen.

The generalisation is the valuable bit: **intent is small and should be handed over immediately;
bytes are large and can take as long as they take.** That principle is under-exploited so far. See
§6.

### 2.4 Everything degrades to something readable

Not a feature — a discipline, applied maybe fifteen times:

| With the link down | you still get |
|---|---|
| scrolling the TUI (a remote operation!) | `screenlog.ts` — the locally rebuilt scrollback, labelled as a reconstruction |
| the file grid | cached listings, re-filtered locally under strict containment rules |
| thumbnails | bytes cached by the page in IDB, so an offline grid paints with no request |
| the reader view | prefetched transcripts, swept for *every* session, status labelled *last known* |
| the app shell itself | the APK, because a dead tunnel otherwise replaces the whole app with a browser error page |

The APK point deserves emphasis: shipping the same Vite bundle inside Capacitor **specifically so
the app shell is never on the network** is a correct and unusual call.

### 2.5 The small ideas that are quietly excellent

- **`collage.ts`** — a mark cannot leave the image it is drawn on, so a bug spanning three
  screenshots can only be circled once they are one canvas. Optimises the *output aspect ratio*, not
  the tile count. Nobody else has thought about this.
- **`archive.ts`** — closing a session was never a delete; the route back was what was missing. So:
  no bookkeeping, no shortlist, just `readdir` over the logs the CLI already writes. Nothing to
  desync, nothing a restart loses.
- **`tree.ts` saves require a `baseSha`** — because the second writer in that repo is an *agent*,
  and last-write-wins would silently delete a turn's work.
- **`settle.ts`** — asking, later and read-only, what became of a delivery whose verdict was
  ambiguous. Most systems leave a gravestone; this one goes and finds out.
- **CLI mode** (`cliKeys.ts`) — Android soft keyboards report no `keydown` for letters, so the box
  holds a pad of spaces and diffs every `input` event. That's someone actually using the thing on a
  phone and refusing to accept a broken affordance.

---

## 3. What is *not* unique

Worth being clear-eyed, because effort spent here is effort not spent on §2.

- Terminal-in-a-browser (xterm.js over a WebSocket) — commodity, many implementations
- Tailscale as the transport — the obvious right answer, not a differentiator
- A file browser, a git diff view, a build-button sheet — table stakes for this shape of app
- Push notifications, a settings screen, a usage meter — necessary, not distinguishing
- The Gemini "decision oracle" — interesting, but it is a *different product* wearing this one's
  clothes (see §7)

---

## 4. Who this is for

**The core user is one person: someone with a real dev machine, real repos, and dead time away from
the desk who wants that time to be productive rather than merely anxious.** Commutes, sofa, kitchen,
a queue at the doctor's, the twenty minutes before a meeting.

The killer moment is specific and worth designing everything around:

> Something is wrong. You take a screenshot on your phone, circle it, write "fix this", and put the
> phone away. By the time you're back at the desk it's done — or waiting for you with one question.

Secondary users, in rough order of plausibility:

1. **Solo devs / indie hackers** — same person, different label. Highest fit.
2. **On-call engineers** — driving an agent through triage from a phone is a genuinely new
   capability. Different trust model (they'd want read-only-by-default), but the offline queue is
   *more* valuable to them, not less.
3. **Small teams sharing a beefy build machine** — plausible, but requires multi-user auth this
   deliberately does not have. Do not chase this yet.

Who it is **not** for: anyone without a desktop; anyone whose work is already fully in the cloud
(they should use the cloud thing); anyone who wants a chat app.

---

## 5. Will people like it? An honest read

**Yes, a small number of people will like it a great deal, and most people will never get far enough
to find out.** Those are different problems and the second one is the one to work on.

### What will land immediately

- The offline queue, the first time a tunnel dies and nothing is lost. This is the "oh" moment.
- Screenshot → circle → "fix this". Nothing else makes this as short.
- The honesty. Every readout says how old it is and whether it's a guess. Once you've been burned by
  a UI that lied about a connection, you notice this instantly and can't go back.
- The archive, the first time you close a session you needed.

### What will stop people

Ranked by how many people it stops:

1. **Setup.** Tailscale + a daemon + `tailscale serve` for HTTPS + an APK sideload + `claude`
   already logged in. Every one of those is a cliff. `npm run doctor` and the insecure-origin banner
   help, but the honest measure is: *how many minutes from "I heard about this" to "I queued my
   first prompt from my phone"?* If that number is over ten, growth is capped no matter how good the
   inside is.
2. **The name.** The product was called "Un-Suck Mobile Coding" (USMC), a joke about the problem rather than
   a claim about the solution; A name that does not
   say what the thing does is a weak signal, cheap to fix, and it interacts with #1 — people don't push through setup friction
   for something they can't describe to themselves.
3. **The trust question.** "A daemon on my dev machine that spawns arbitrary code execution, reached
   over a network." The security model here is genuinely good and genuinely conservative — Tailscale
   identity as the boundary, origin *and* host checks because a WebSocket ignores same-origin,
   deny-until-set for LAN, loopback-only hooks, path containment asserted by e2e. But it is
   explained in `SECURITY.md` and CLAUDE.md, i.e. to people who already trust it. That reasoning
   needs to be the *first* thing a newcomer reads, not the last.
4. **First-party competition.** Anthropic ships a web app and cloud sessions for Claude Code. For a
   large fraction of "I want to check on my agent from my phone", that is now the default answer,
   and it needs no setup at all. This is the single biggest strategic fact in this document.

### The answer to #4 — and it's a good one

Do not compete on "look at your agent from your phone". Compete on **your machine, your files, your
builds, your bad link**:

- your actual working tree, uncommitted, with the repo's real toolchain
- a real Android build producing a real APK you can install from the phone that queued it
- an agent that can touch your local database, your simulator, your device
- a link that is *expected* to fail, on a train, in a basement, abroad
- no code leaving your machine

A cloud session cannot do any of those, and won't. That is the durable position, and every roadmap
item below is chosen to widen it.

---

## 6. Where to push, ranked

### Bet 1 — Make the first ten minutes not a cliff *(highest leverage by a distance)*

Concretely:

- **A one-command installer** that runs the doctor, sets up `tailscale serve`, installs the launchd
  service, and prints a QR code to the phone. The gap between "works if you read CLAUDE.md" and
  "works" is where all the lost users are.
- **QR pairing.** The host prints a code; the phone scans it and is configured. `hosturl.ts` already
  knows the address rules — this is mostly UI.
- **A 60-second screen recording** at the top of the README: screenshot → circle → queue → walk away
  → it's done. The product is legible in video and illegible in prose.
- **A hosted APK** (or Play internal-testing track), because "sideload this" loses people who would
  otherwise have stayed.

None of this is interesting engineering, and it is worth more than the next five features combined.

### Bet 2 — Push the handover further

`launch.ts` proved the principle: hand the *intent* over immediately, let the bytes follow. Almost
nothing else uses it yet.

- **Host-side outcome delivery.** The desktop knows a turn finished and produced an APK. It should
  push it toward the phone without being asked — `autopull.ts` is halfway there already.
- **Host-side chains.** Multi-prompt plans currently drain through the phone's queue. A plan handed
  over wholesale would run overnight with the phone off, which is the actual promise.
- **Host-side answers to *known* questions.** Not the oracle — something narrower and safer: "if the
  box is exactly a trust prompt for a directory I've already trusted, answer it." Bounded, explicit,
  auditable via `sentlog.ts`.

The unifying frame: **the phone should be an input device and a viewport, not a coordinator.** Every
job it currently coordinates is a job that stops when it sleeps.

### Bet 3 — Make the honesty legible to a newcomer

The app knows an extraordinary amount about its own state — `netpulse`, `netsync`, `nettraffic`,
`giveups`, `waiting()`, `blockedReasonText`, `whyIdle`. A newcomer sees none of it, because each
readout only appears when its specific thing goes wrong.

Consider **one screen that answers "is everything fine, and if not, what and why"** — not another
sheet, a *default* view. The parts already exist and already agree with each other by construction
(reasons are emitted by the ladder that decides, never re-derived). Assembling them is presentation
work over an invariant that already holds.

This also happens to be the demo. "It tells you the truth about a flaky link" is very hard to show
in a screenshot and very easy to show in one screen.

### Bet 4 — Own the build → device loop

`builds.ts` + `nativeSave.ts` + the pull queue already do something no cloud session can: **build on
your machine, install on the phone in your hand.** That is a complete loop and it is under-sold.

Sharpen it: one tap from "the build finished" to "it's installing", the artifact named and dated,
`stale` clearly flagged (the distinction between "here is the APK" and "this run made it" is already
modelled — surface it). For mobile devs specifically this is the reason to use waterplane over anything
else, and mobile devs are exactly the people who want to work from a phone.

### Bet 5 — The multi-agent view

The launcher already handles several sessions, worktrees, fan-out, backlogs, schedules, and the
serialization rule that stops five queued opens from spending one usage limit five ways.

What's missing is **the overview**: N agents working, which need me, which are blocked, which are
done, in one glance, ranked by "needs a human". The facts all exist (`waiting()`,
`autoFireBlocker`, the prompt detector, the limit state, the new usage budget). This is the feature
that turns "drive one agent from a phone" into "supervise several", which is a different and larger
claim.

Do this *after* Bet 1. It's a power-user feature and it needs users first.

---

## 7. What to cut, or at least stop feeding

- **The decision oracle.** Gemini answering Claude's questions is a genuinely different product with
  a different risk profile bolted onto this one. It's opt-in, suggest-only, blocklisted and
  redacted — carefully done — but it dilutes the story ("what is this thing?") and consumes
  attention. Keep it working; stop investing.
- **Feature breadth generally.** The sheet list is past thirty. `uistats.ts` exists precisely to
  find the unused ones — use it, and delete on the evidence. Every sheet is surface area a newcomer
  has to not-be-confused-by.
- **Anything that needs multi-user auth.** The single-user boundary is what makes the security model
  simple enough to be correct. Teams are a different product; don't half-build it.

---

## 8. Positioning

If I had to write the README's first line:

> **Your desktop's coding agent, driven from your phone — over a link that's allowed to fail.**

The three claims, in order of how much they differentiate:

1. **Your machine.** Real repos, real toolchain, real builds, nothing leaves the box.
2. **The real CLI.** Not a reimplementation — every feature it has, this has, on the day it ships.
3. **Built for a bad link.** Type it in a tunnel; it arrives exactly once, in order, when it can.

Claim 3 is the one nobody else makes, and it's the one that's hardest to copy. Lead with 1 for
comprehension, close with 3 for the people who'll actually stay.

---

## 9. Risks worth writing down

| Risk | Severity | Mitigation status |
|---|---|---|
| Upstream TUI change breaks the heuristics | High, recurring | Good: degrade-to-null, e2e-pinned against a hostile stub. Not eliminable — it's the price of §2.2. |
| First-party mobile/cloud absorbs the casual use case | High | Answered by §5's positioning, but only if the positioning is *actually adopted* in the README and the setup flow. |
| Single-maintainer complexity load | Medium-high | The `docs/notes/` + CLAUDE.md discipline is unusually strong and is doing real work here. Keep it. |
| A security regression in the origin/containment guards | Low probability, severe | Well covered by e2e, and the invariants are written down in the imperative. Keep them asserted, never "cleaned up". |
| Feature sprawl outrunning the audience | Medium | Real, and already visible in the sheet count. §7. |

---

## 10. The short version

The engineering here is better than the product's legibility. The queue, the handover, and the
degrade-to-honest discipline are genuinely differentiated and genuinely hard to copy; the setup
flow, the name, and the first-run story are ordinary and are what's actually capping adoption.

**Spend the next stretch on the first ten minutes, not the next feature.** Then push the handover
further, because "it keeps working with the phone in your pocket" is the promise nothing else can
make.
