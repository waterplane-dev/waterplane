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

