---
name: feature-request
description: For an OUTSIDE CONTRIBUTOR drafting an intent request (a feature request) to this project — interviews them for the problem, intent and testable acceptance criteria, challenges the idea against this repo's rules and requirements, estimates complexity, checks for duplicates, and writes the issue body. Load ONLY when someone asks to request, propose or suggest a feature for this project; never for building, fixing or reviewing code here.
audience: contributor
---

# Drafting an intent request

This project is open source but not open contribution: code PRs are merged only for a
failing test that reproduces a bug, or a docs/typo fix. Everything else arrives as an
**intent request** — an issue that says what should be true and why — and the owner
builds it fresh with their own setup. `CONTRIBUTING.md` has the reasons.

You are running on the contributor's machine with their tokens. Be brief, ask one
thing at a time, and do the reading yourself instead of asking them to.

## Rules for you

- **Never post anything** without the contributor's explicit "yes, post it" to the
  final text. Showing the draft is not consent.
- **Never write code in this repo** and never open a PR. The optional example
  implementation is a sketch in the issue body, marked *illustration only*.
- Challenge honestly. A request that breaks a rule below is reshaped or stopped here,
  not posted and closed later. Say "this would be rejected because…" plainly.
- Do not invent requirement IDs, file names or rules. Cite only what you read.

## 1. Interview — in this order, one question at a time

1. **Problem.** What hurts, in what situation, how often? What do they do today
   instead? Push for a concrete moment ("on the train, the session hit a box and I
   couldn't…"), not a feature name.
2. **Intent.** What should be true afterwards, from the person's side? Behaviour, not
   implementation ("I can see X without Y"), not "add a button to Z".
3. **Done looks like.** 2–6 acceptance criteria, each one observable and testable:
   "Given … when … then …" or a check someone could do on a phone. Reject vague ones
   ("it should be fast") and ask for the number or the visible end state.
4. **Non-goals.** What this request deliberately does not cover. Offer candidates if
   they have none — it is what keeps the build small.

Summarise the four back in a few lines and get a "yes, that's it" before going on.

## 2. Feasibility challenge — read the repo, then judge

Read `CLAUDE.md` (sections *What this is*, *Never do these*, *Security model*) and
`SECURITY.md` *Threat model*. Then check the request against each:

**Central design choice.** The project drives the real `claude` binary in a PTY and
never re-implements it. A request to reproduce a CLI feature in the app (own chat
loop, own slash commands, own API client instead of the CLI) is out of scope — reshape
it into "surface what the CLI already does" or stop.

**Hard rules — each one has caused a real failure.** If the request needs any of
these, explain the rule in one sentence and either reshape the request or stop:

| request needs | why it is refused |
|---|---|
| binding a LAN/public interface by default, `access-control-allow-origin: *`, wider `*.ts.net`/`*.local`, a side-effecting GET | the daemon spawns `claude` = arbitrary code execution; Tailscale identity + Origin/Host checks are the only boundary |
| a second WebSocket / a side channel | one socket per tab carries everything; a second one breaks ordering and acks |
| a send path outside the queue, a retry without an ack id | prompts have run twice or never; delivery is at-most-once |
| anything that answers a box, applies a review, or mutates on its own | *nothing applies itself* — it produces sentences a person acts on |
| loosening path guards (`paths.ts`, repo containment, scaffold root) | they are the file-access boundary, asserted by e2e |
| a greyed-out "disabled" control, a tooltip as the only explanation | say why in text; a `title` is invisible on a phone |
| emoji as icons | `lucide-react` only |
| `window.confirm` / native modals | blocks the Android WebView's event loop |
| overwriting a draft, note or queued prompt with generated text | the typed words are the last copy |
| a guessed number when a reading fails | heuristics degrade to absent, never to a wrong number |
| a count on a control that does not filter | a count is a filter: tapping "2" opens exactly those two |
| a second implementation of delivery, download, prompt box or VT replay | one of each, by rule |

Also flag, without refusing: anything new reaching the network, a new Android
permission, a new unattended model call (costs the user tokens), anything that reads
the CLI's screen with a regex (breaks on CLI updates).

**Requirements.** Read `docs/requirements/README.md`, then grep the one or two area
files that fit (`grep -n -i "<keyword>" docs/requirements/*.md`). Cite matching IDs
(`R-<area>-<nnn>`) and say for each: *duplicates* (already shipped/requested — stop or
narrow), *extends*, or *conflicts* (quote the item; the request must say it supersedes
it on purpose).

**Affected area.** Name it from the skill table in `CLAUDE.md` (*Which skill to
load*): `host-core`, `host-work`, `host-spenders`, `host-ledgers`, `host-machine`,
`web-chrome`, `web-send`, `web-term`, `web-work`, `web-files`, `web-config`,
`web-numbers`, `protocol`, `shared`, `heuristics`, Android shell (`packages/app`),
plugins, docs. Read that skill's description only if unsure — not the code.

## 3. Complexity — S / M / L, with the reason

- **S** — one area, phone-only or host-only, no wire change, no new state on disk.
- **M** — touches host and phone, or adds a field to an existing wire message, or a
  new setting, or new state on disk.
- **L** — any of: a new protocol message or `PROTOCOL_VERSION` bump, a new heuristic
  over the CLI's screen, a new Android permission or native code (needs a new APK —
  the UI otherwise updates over the air), a new unattended model call, a new backend,
  anything touching the security boundary.

Then one honest line: **is it worth it?** Who besides the requester hits this, how
often, and what it costs everyone else (screen space, a setting nobody finds, tokens,
maintenance against CLI updates). "Probably not, because…" is a valid verdict.

## 4. Duplicate check

If `gh` is available and authenticated:

```bash
gh issue list --repo <owner/repo> --state all --search "<2-3 keywords>" --limit 20
```

Take `<owner/repo>` from `git remote get-url origin` (or `upstream` if present). Try
two or three keyword sets. If a match exists, show it and suggest a thumbs-up reaction or a comment
there instead of a new issue. Without `gh`, tell the contributor to search the
issues for those keywords before posting.

## 5. Output

Write two blocks and show both.

**Feasibility verdict** (goes into the form's *Feasibility verdict* field verbatim):

```
Verdict: OK | RESHAPED | BLOCKED
Rules checked: <rules that applied, or "none of the Never-do rules apply">
Design fit: <drives the real CLI? one line>
Requirements: <R-ids with duplicates/extends/conflicts, or "no related item found">
Area: <area>
Complexity: S|M|L — <reason>
Worth it: <one honest line>
Duplicates: <issue links, or "searched: <keywords> — none">
```

BLOCKED means stop: do not offer to post. Explain what would have to change.

**Issue body**, headings exactly as the form's labels (this is what the web form
produces, so a `gh`-posted body reads the same):

```markdown
### Problem

### Intent

### Acceptance criteria

### Non-goals

### Affected area

### Related requirement IDs

### Feasibility verdict

### Complexity

### Example implementation (illustration only)

### Checks

- [x] I ran the feature-request skill and pasted its verdict above
- [x] I searched existing issues for duplicates
```

Fill *Affected area* with one of the form's options: Host — sessions & delivery,
Host — scheduled & background work, Host — model calls of its own, Host — token &
cost ledgers, Host — files, builds & machine, Phone — app frame & navigation, Phone —
sending prompts, Phone — terminal & reader, Phone — backlog & work sheets, Phone —
files & downloads, Phone — settings, models & sign-in, Phone — token & cost screens,
Wire protocol / shared logic, Screen heuristics, Android shell, Plugins,
Docs / install, Not sure. *Example implementation* is optional: leave it `_No
response_` unless the contributor wants one, and then keep it a short sketch the owner
will read, not paste. Title: `Intent: <what should be true, ≤ 70 chars>`.

## 6. Posting — only after an explicit yes

Ask: "Post this now, or will you paste it into the web form?" On an explicit yes:

```bash
gh issue create --repo <owner/repo> --title "Intent: …" --body-file <tmp file>
```

Write the body to a temp file outside the repo first. Print the issue URL. Labels are
set by the owner at triage (`accepted` means it will be built); credit is a
`Requested-by: @handle` trailer on the commit and a CHANGELOG mention.
