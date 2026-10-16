# Before open-sourcing waterplane — the running list

Notes, not a plan anybody has approved. Ordered by what would hurt most if it shipped wrong, not by
effort. Nothing here is legal advice; the items that need a lawyer are marked as such.

**Status, 2026-10-04.** Each item below is tagged **[done]**, **[partly]** or **[open]**; the body text
is the original reasoning and is left as written. Open as of today: the history scan (A1), the
personal-identifier pass over notes and fixtures (A2, A4), a read of the vendors' terms (C2), and the
decision on `WATERPLANE_ALLOW_PUBLIC` as a primary route (B3). A second backend now lives in a private
extension that the public tree excludes (`tools/publictree.test.mjs` guards it), so the public notes
need not discuss it.

Companion: [`DISCLAIMER.md`](../../DISCLAIMER.md) is the user-facing half and is already written.

---

## A. Things that would leak if you pushed today

**A1. Secrets in the working tree and in history.** [open] `.env` files are gitignored, but "gitignored
today" is not "never committed". Before anything becomes public, the whole history needs a scan —
not just the tip — for API keys, Tailscale identifiers, and the MagicDNS name of the desktop.
`secrets.ts` and the compliance checks cover the future; they say nothing about the past.

**A2. Personal identifiers baked into docs and tests.** [open] `docs/notes/` and several fixtures quote
real paths (`/Users/me/dev/...`), the host's MagicDNS name, and repo names from a private
`~/dev`. Some are load-bearing as evidence ("measured on this desktop"), which is the point of those
notes — so this is a rewrite decision, not a `sed`. Decide per file whether the measurement stays
with a redacted path or the example becomes synthetic.

**A3. The transport directories.** [open] (confirm nothing under them was ever committed) `.claude/inbox/` and `.claude/outbox/` hold screenshots of the
author's phone, including notification shades, other apps, and whatever was on screen. They are
gitignored. Confirm that nothing under them was ever committed, and that the new sweep feature is
not the first time anybody looked at how much is in there.

**A4. `WATERPLANE_ALLOWED_HOSTS` / `_ORIGINS` examples.** [open] `.env.example` and the notes carry real
tailnet hostnames in places. Replace with obviously-fake ones.

## B. Security posture, stated rather than assumed

**B1. `SECURITY.md` needs a threat model section, not just rules.** [done] — `SECURITY.md` has a threat model. It currently tells a maintainer
what not to do. A stranger needs the shape first: *the daemon executes arbitrary code; network
identity is the only boundary; here is what an attacker who reaches the port gets.* The rules read
as arbitrary without it.

**B2. A stated vulnerability-reporting route.** [done] — a private advisory route in `SECURITY.md`. An email or a GitHub security advisory link. Without
one, the first report arrives as a public issue.

**B3. Decide the position on public exposure.** [partly] — `SECURITY.md` and the README say the LAN gate is an escape hatch and the password is deny-until-set; no rate-limit or lockout decision recorded. `WATERPLANE_ALLOW_PUBLIC=1` plus the password gate exists
and works. Publishing it means people will use it as the *primary* route rather than the escape
hatch. Either document it as strongly discouraged, or harden it (rate limiting, lockout) before
publishing. Right now it is a footgun with a safety catch and no sign.

**B4. Dependency and supply-chain hygiene.** [done] — `.npmrc` release age, lockfile test, `audit:prod`, Dependabot. Actions: see below. `npm audit` state, a lockfile policy, and a decision on
Dependabot. Note that GitHub Actions are deliberately off in this repo (billed minutes on private
repos; `.github/workflows/ci.yml` is `workflow_dispatch`-only and is the only thing that covers
Linux, so run it by hand before a release; the everyday gate is the local pre-push hook) — public repos get free minutes, so CI becomes available and the local pre-push hook
arrangement should be revisited at the same time.

## C. Licensing and third parties — needs a lawyer for the first two

**C1. Pick a licence.** [done] — MIT (`LICENSE`). Not a formality here: waterplane drives commercial CLIs and ships a Capacitor
Android shell. MIT/Apache-2.0 is the obvious pairing; Apache-2.0 adds a patent grant and an explicit
no-warranty clause that fits a tool like this.

**C2. Whether driving `claude` / `opencode` in a PTY is within their terms.** [open] waterplane automates another
vendor's CLI and types into it. That is almost certainly fine for personal use and is worth an actual
read of both vendors' terms before telling the public to do it at scale. Flagging, not answering.

**C3. Third-party notices.** [done] — `NOTICES.md`. `lucide-react`, `xterm.js`, `node-pty`, Capacitor, and the patched
`node-pty` (`scripts/fix-node-pty.mjs`) — a NOTICE file and a statement that the patch exists and
what it changes.

**C4. The in-app disclaimers must survive forks.** [partly] — `DISCLAIMER.md` says so; `ModelField`'s warning is still easy to delete. `DISCLAIMER.md` says this; consider whether the
hosted-model warning in `ModelField` should be structurally hard to remove (it is currently one
component and one string, which is honest but easy to delete).

## D. Onboarding — the difference between a repo and a project

**D1. A README that starts from zero.** [done] — the README starts from zero. What it is, the one-paragraph architecture (phone PWA ↔
Tailscale ↔ Node daemon ↔ real CLI in a PTY), and a five-minute install. `CLAUDE.md` is superb
orientation *for an agent* and is the wrong first document for a human.

**D2. The install has sharp edges.** [done] — README install path, `npm run doctor`. `npm install` patches `node-pty`; `npm run restart` is mandatory
and hand-killing breaks launchd; Tailscale must be up; `tailscale serve` is needed for a secure
context. Each is documented somewhere in `docs/notes/`. None is on a path a newcomer walks.

**D3. A screenshot or a 30-second capture.** [done] — gifs under `docs/media/`, regenerated by `npm run media`. The product is visual and the pitch does not survive
being described.

**D4. Decide what `docs/notes/` IS in public.** [done] — linked from the README and CONTRIBUTING. It is ~1 MB of measured reasoning and it is the most
valuable thing in the repo — and it reads as internal correspondence. Keep it, link it from the
README as "why everything is the shape it is", and do not apologise for it.

**D5. Contributing guide, scoped to the doctrine.** [done] — `CONTRIBUTING.md`. The rules that would otherwise be re-litigated in
every PR: heuristics degrade to absent, never a wrong number; nothing applies itself; a count on a
control is a filter; never grey out a button; one send path; `CLAUDE.md` has a size budget enforced
by a test. These are already written down — point at them.

## E. Product questions that only matter once strangers run it

**E1. A first-run acceptance gate for hosted models.** [done] — the hosted-model acknowledgement (`hostedAck.ts`, `HostedAckSheet.tsx`). Designed but deliberately not built: on a
single-user machine it is friction nobody asked for, but a distributed build wants a one-time
acknowledgement before the first hosted launch, stored per device and resettable. Build it with the
terms, not ahead of them.

**E2. Single-user assumption is everywhere.** [open] — stated in `DISCLAIMER.md`, by design. No accounts, no roles, no audit trail; anyone who
reaches the daemon gets every repo under `WATERPLANE_ROOT`. Stated in `DISCLAIMER.md`; it will still be the
first feature request.

**E3. Hard-coded personal defaults.** [partly] — defaults are in `.env.example` and the README table. `WATERPLANE_ROOT` defaulting to `~/dev`, the model catalogue fallback
list, the assumption that the summariser is a `claude -p` call. Each is fine as a default and should
be findable.

**E4. Telemetry.** [done] — no telemetry, stated. There is none, and that is a selling point worth stating explicitly rather than
leaving people to wonder.

**E5. Platform reality.** [done] — README: macOS or Linux, Windows only in WSL2. macOS + launchd is the tested path; Linux/systemd is plausible and
unverified. Windows (2026-10-07): the host runs in WSL2, verified on one Windows 11 box from a Windows
checkout (`scripts/windows/`, [distribution.md](distribution.md#windows-the-launcher-drives-the-host-in-wsl));
native Windows is not a thing. Say so rather than letting people discover it.

## F. Known gaps in what the app currently claims

**F1. Local-model tokens are invisible to the statistics screen.** [done] — a second backend's store is read by its extension and shown as a contributed ledger tab. `tokenstats.ts` reads
`~/.claude/projects/**/*.jsonl` and nothing else. An opencode session — local or hosted — writes to
opencode's own store and is therefore absent from a screen that presents itself as *every token this
desktop has used*. Nothing is being wrongly merged today; the number is simply silent about a
growing share of the work. Either read the second store or say on the screen what it does not cover.

**F2. No measurement path for local tokens-per-second.** [open] — by design, throughput is omitted rather than estimated. Neither ollama's `/api/ps` nor opencode
publishes a live throughput figure this host can read, so the runtime bar shows what it can measure
(loaded model, resident size, CPU, memory) and omits throughput rather than estimating it.

**F3. Six failing host tests** [done] — historical; the suite is green. in `deliverecho`/`deliversubmit`, from in-flight uncommitted work on
`deliver.ts`/`sessions.ts` (`sessions.turnFromHook` not yet exported). Green tests before publishing.

**F4. `CLAUDE.md`'s 12k budget is enforced; `docs/notes/` is not.** [done] — `CONTRIBUTING.md` says it. That is deliberate, and a
newcomer will not know it. One line in the contributing guide.
