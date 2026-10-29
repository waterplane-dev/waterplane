# git

### R-git-001 · shipped
Git status shows the count of files with untracked changes.
- asked: 2026-09-18
- shipped: 58066b0

### R-git-002 · superseded
A worktree row is visually tied to its parent repo: repo fill, hued connector, "worktree of <repo>".
- asked: 2026-10-02
- shipped: da987ee
- superseded-by: R-git-014

### R-git-003 · shipped
The git sheet pulls and syncs, not only pushes: Pull fetches then fast-forwards (or replays local commits on a clean tree, undone on conflict), Sync pulls then pushes what is still ahead.
- asked: 2026-10-08
- shipped: 93ad51bf
### R-git-004 · shipped
In the diff view, changed images, GIFs and videos show both the old and new versions visually instead of raw binary content.
- asked: 2026-10-05
- shipped: 695f6ed6

### R-git-005 · superseded
Worktrees with no session are shown with a clear explanation of why they exist, and can be deleted with one button, with confidence that nothing is left behind.
- asked: 2026-10-05
- shipped: 7416cbd5
- superseded-by: R-git-014

### R-git-006 · shipped
The diff view can switch to show either document in full, not only the changes, and offers a side-by-side view on desktop that stays out of the way on mobile.
- asked: 2026-10-06
- shipped: d140f23f

### R-git-007 · shipped
The git view is always reachable from the repo header, so the user can push without committing first.
- asked: 2026-10-07
- shipped: 52414153

### R-git-008 · shipped
The main view shows how many commits are pending outgoing and how many incoming.
- asked: 2026-10-07
- shipped: 52414153

### R-git-009 · shipped
A failed push or pull can be handed to a new session with its log and context, or copied to the clipboard; nothing is sent by the tap.
- asked: 2026-10-09, 2026-10-09
- shipped: caf4f006, 352c0b17

### R-git-010 · shipped
The git view shows local unpushed commits alongside incoming remote commits, each count opening the commits it counts.
- asked: 2026-10-10
- shipped: d80152e5


### R-git-011 · shipped
A new session can start from a remote: the New sheet clones an https or ssh URL into a fresh folder under the root and opens a session there, without changing the cloned project.
- asked: 2026-10-16
- shipped: 8a57e6f7
### R-git-012 · shipped
Repos without a remote origin are marked as such.
- asked: 2026-10-12
- shipped: 210a702

### R-git-013 · shipped
Git availability is detected by whether a usable git runs, not by a fixed path check, and a folder git refuses is explained with the real cause.
- asked: 2026-10-21, 2026-10-21
- shipped: 74c7719e, a362d9ce, e335f4a6

### R-git-014 · requested
Work trees are not offered anywhere in the product; the work-tree feature is removed.
- asked: 2026-10-22


### R-git-015 · shipped
A failed git pull or push of a repo raises a *needs you* notification naming the verb and the repo. A tap on it, from the push, the tray or the feed, opens that repo's git view showing the full error with the fix and copy buttons, also after a desktop restart and on another device. A push that succeeds is information; a pull that succeeds raises nothing.
- asked: 2026-10-25 — "Failed git pull or push also needs a red indicator and notification and tapping it for details must lead to the right place. Note that we have it per repo"
- shipped: 52910130

### R-git-016 · shipped
While a repo's last pull or push failed and nobody has handled it, its git button carries a red worded chip ("push failed" / "pull failed"). It goes away, saying so, when the next pull or push of that verb succeeds or the person taps done.
- asked: 2026-10-25
- shipped: 52910130

### R-git-017 · shipped
The git sheet's Explain button has the desktop explain, in plain words, what a push would send and a pull would bring (fetching first), under focus boxes that are all ticked by default: security, what changes for users, whether a deploy is needed and of which components (e.g. web app only, functions only, an app needing a store release), data and migrations, breaking changes, dependencies and cost, surprises the commit messages do not mention, and what to check by hand — plus an optional focus in the person's own words. It reads only; nothing is pushed or pulled by it.
- asked: 2026-10-26 — "have another button to let ai explain the summary of the changes that are about to be pushed and if there are ones to pull also what is there to pull"
- shipped: cd22d678
### R-git-018 · shipped
Protected main branches are supported by the WP UI workflows: a push a branch rule refused says so in words with the remote's rules, and an unprotected default branch can get standard rulesets in one tap.
- asked: 2026-10-26
- shipped: 04d4ac10, b384fdbf

### R-git-019 · requested
The default workflow needs no manual branch or PR handling, while users who need branches or PRs remain supported.
- asked: 2026-10-26


### R-git-020 · requested
PR mode switches on only from the remote's own rules (a pull-request, required-checks or required-review rule on the default branch, read via `gh`); a repo with no rules, or only force-push/deletion blocked, or one whose rules cannot be read, stays in direct mode with the push button and screens unchanged.
- asked: 2026-10-26

### R-git-021 · requested
In a repo whose rules demand a PR (PR mode), the push button is "push & open PR": commits ahead on the default branch go to a new `wp/<slug>` branch (pushed through the same streamed push, local-CI hook included), a PR is opened, and only then local default moves back to `origin/<default>` — no commit or uncommitted edit is ever lost. On another branch it pushes and opens or updates that branch's PR. The result says "opened PR #N" or "updated PR #N" with the URL; any failure stops with one sentence naming where the commits are. A push refused by a branch rule in direct mode forgets the rules reading and says the repo now takes changes through a PR. Direct mode is unchanged.
- asked: 2026-10-26

### R-git-022 · requested
While the git screen holds a lease on a repo (it renews about every 30 s and lapses after 60 s), the host lists the person's own open pull requests (`gh pr list --author @me --state open`) every ~20 s (`WATERPLANE_PRS_POLL_MS`) and serves the latest reading from a cache; nothing polls when no screen is looking, and a request never waits on `gh`. Each PR carries its checks (running / passed / failed / skipped, with a link), review decision, mergeability, whether auto-merge is on, and one sentence for why it cannot merge yet ("waiting for 1 approval", "check local-ci failed", "checks still running"), worded in one shared function. When `gh` is missing or fails the list is absent with a sentence, never an empty list.
- asked: 2026-10-26

### R-git-023 · requested
Merging, switching auto-merge on or off, and closing a pull request are each one explicit tap (a POST, never automatic). Merge uses the method the person chose, else the first the repo allows, and refuses a method the repo does not allow. Auto-merge on is refused in words when the repo does not allow it. After a merge the host pulls the base branch if it is checked out and the tree allows it, deletes the head branch locally (never forced) and on origin, and answers with a receipt that says what was done and what was not (for example "did not pull main (this checkout is on wp/x)").
- asked: 2026-10-26

### R-git-024 · requested
A failing check can be read from the phone: the host returns the last 80 lines of the failed Actions run's log, or, when the check is not an Actions run, the check's own page to open in the browser.
- asked: 2026-10-26

### R-git-025 · requested
While the PR list is being polled, a check that newly fails, a review that asks for changes, and a PR that was merged or closed somewhere else each raise one notification through the git notification path, so the push preferences decide whether it is delivered. A first reading and a PR the phone itself just merged or closed raise nothing.
- asked: 2026-10-26

### R-git-026 · requested
In a repo whose remote demands pull requests (`pr` or `pr-checks`), the phone's git screen shows a PR card above the history: each open PR with its branch, checks (running / passed / failed; a failing check opens its log or page in one tap), review state, and a merge button that stays tappable and says the host's one reason ("waiting for 1 approval") in text when it cannot merge. The merge method is the first the repo allows, with a choice when several are; "Merge when green" appears only where the repo allows auto-merge; close asks to be confirmed; "Open on GitHub" opens the PR. The push button reads "Push & open PR". The card holds the host's lease only while it is on screen. In a direct repo, or one whose rules are unread, the screen, the push label and the traffic are exactly what they were: no card, no lease.
- asked: 2026-10-26

### R-git-027 · requested
A driven agent learns, through the repo skill (`reposkilltext.ts`), what to do when a push to the default branch is refused as a protected branch or rule violation: never bypass it, commit on `wp/<slug>`, push with `-u`, open the PR with `gh pr create --fill`, and tell the person the URL; the PR then shows on the phone's PR card. It never merges a PR or switches auto-merge on unless the person asked in words. The host adds no merge or push path of its own for backlog or fan-out sessions: those agents do their own git in the PTY. The text is the same for every repo (a short body paragraph, not the skill description).
- asked: 2026-10-26

### R-git-028 · requested
When a repo's rules require a `local-ci` status and the person switched on the opt-in "Report local checks to GitHub" (git config `waterplane.localCiStatus`), a push from the phone's push button in PR mode, after the pre-push hook let it through, posts one `success` status with context `local-ci` for the commit that was PUSHED (never HEAD afterwards), before the PR is opened. Nothing is posted for an up-to-date push, a skipped hook, a missing or non-executable hook, or any ref but the PR branch; a failed post never fails the push and the receipt says so. With the switch off, or in a direct repo, the push and its text are exactly what they were. The card says it is the honor system and does not cover pushes an agent or a terminal makes.
- asked: 2026-10-28 (branch & PR workflow, P5)
