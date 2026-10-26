# scorecard — a repo's OpenSSF Scorecard on the phone (optional extension)

What the public OpenSSF Scorecard says about a repo's GitHub remote, one tap from the repo. No
credential, no model call: the host reads `api.securityscorecards.dev` and the phone only draws it.
Optional: switch it on or off in Settings › Tools & diagnostics › plugins. A dev checkout starts it
**on**; for a release, `deploy/ship.json` decides whether it is carried and its default switch.

## What you see

- **A `failing 3` chip on the repo row** (the score, e.g. 6/10, is in its title), drawn only when the
  repo is scored and has failing checks that nobody accepted. The number is exactly those checks, and
  the tap opens the sheet cut to them (*n of N — clear*). Unscored, absent or nothing open: no chip.
- **The sheet** (one repo): the score once, the date read, which GitHub repo was scored and why, a
  link to the public report, a refresh. Then **Failing** (each row: the API's reason, details folded,
  a doc link, **ask Claude** and **accept…**), **Accepted** (always visible, with the reason) and
  **Passing** (folded, with its count).
- **ask Claude** files the check's remedy prompt in the repo's backlog and waits for a tap; nothing
  fires. **accept…** asks for a reason (required, up to 500 characters) and then the check no longer
  counts. **stop accepting** (behind a confirm) puts it back.
- **A setup row** (`scorecard`) in Repo readings, whose hand-to-agent button opens the same cut.

## Where the data comes from

1. The repo's `origin` remote (else its first GitHub remote), or the repo named in **scored as**.
2. A visibility check against the unauthenticated GitHub API first, so a private repo's name never
   goes to OpenSSF. The slug itself does go to `api.github.com` for that check; GitHub allows 60
   unauthenticated requests an hour per IP, so the answer is cached for 24 hours. Private, no GitHub
   remote or not yet scored: the sheet says so in a sentence, never a 0.
3. The Scorecard API for that public `owner/name`; reused for six hours, **refresh** reads it now.

**Scored as** is for a private repo with a public mirror (this repo's own case): type the mirror's
`owner/name` (letters, digits, - . _ and one slash), save; *clear* goes back to the remote.

The score is only as fresh as the project's own `ossf/scorecard-action` workflow: that run is what
publishes results to the API. No workflow, no score.

## Accepts

A person's accepts live in `<state dir>/scorecard/accepted.json` (reason, time, the score at the
time). An accept lapses if the check's score later falls below what it was accepted at.

Three are **built in** and cannot be withdrawn, because a solo maintainer cannot pass them:
Code-Review (needs a second approver), Contributors (needs several organisations) and Fuzzing.
The sheet marks them *built in* and says why.

## Files

| path | what |
|---|---|
| `shared/wire.mts` | the contract both halves import |
| `host/` | the API read, visibility check, accepts file, remedy prompt |
| `web/` | sheet, chip, setup row words; `logic.ts` holds the cut and chip count, tested in `logic.test.mjs` |
