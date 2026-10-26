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

