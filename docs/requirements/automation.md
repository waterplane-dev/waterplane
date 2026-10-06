# automation

### R-automation-001 · shipped
Deployment scripts are triggered via buttons, no AI needed.
- asked: a8b8c807
- shipped: 7aaee35

### R-automation-002 · requested
Garmin repo buttons build and ship apps in beta and prod variants.
- asked: a8b8c807

### R-automation-003 · shipped
Artifact-generating repos have buttons that build new artifact versions; build results/APKs appear in the outbox and are downloadable directly after the build, including newly deployed APKs.
- asked: a8b8c807, 1d445efe, ff27b0ad, d4be17c7
- shipped: 7aaee35, 3f7c7bc

### R-automation-004 · shipped
Setup screen offers predefined prompt triggers.
- asked: 28f08c93
- shipped: d620752

### R-automation-005 · shipped
AI setup button executes its prompt, with AI assistance available in dialogue setup.
- asked: ff27b0ad, d8d58b55
- shipped: b87535a

### R-automation-006 · requested
Scheduler provides simple date/time selection, not a complex interface, including calendar week navigation, a 5-minute time option, and a 'later' dialog whose confirm button is relabelled save for the chosen date/time.
- asked: ec4932bb, 60aeda7b, b7853032, 2026-09-11 (session 8c2bc4c6)

### R-automation-007 · shipped
Scheduling supports relative times based on session-reset and weekly-window boundaries, with conditional (percentage-headroom) execution and notifications when conditions aren't met.
- asked: 48be8bda
- shipped: 6a63d3b, 13081a8, fa9158e, 8dffa3f, 9efbe6e

### R-automation-008 · shipped
Commands/sessions scheduled for a due time execute automatically, and a 'run now' button can start them immediately.
- asked: 3ddd15db, 3ddd15db
- shipped: c6b9713, bc8770d

### R-automation-009 · shipped
Repo rows show a chip summarizing what is scheduled to run soon (e.g. counts per upcoming time window).
- asked: 48be8bda
- shipped: 00d1dc0

### R-automation-010 · shipped
Checking (health/status) and starting (sessions) occur automatically when appropriate, without manual triggering.
- asked: 5eba6f6f
- shipped: fc9f913, a05c881

### R-automation-011 · shipped
Scheduling options are expanded and made more powerful (flexible clock/usage-window/condition combinations).
- asked: 2026-09-17 (session e8dac5bb)
- shipped: 58066b0, 6a63d3b, 6beef0b

### R-automation-012 · shipped
Each backlog item executes in its own independent session rather than all items running in a single session.
- asked: 2026-09-17 (session e8dac5bb)
- shipped: f7caebb

### R-automation-013 · shipped
Backlog smart-pick option evaluates all remaining items when the next item is picked.
- asked: 2026-09-17 (session e8dac5bb)
- shipped: f7caebb

### R-automation-014 · shipped
Scheduled tasks and backlog items stay synchronized as one list.
- asked: 2026-09-18 (session e8dac5bb)
- shipped: 58066b0

### R-automation-015 · requested
System tracks which scheduled items for today were worked on.
- asked: 2026-09-17 (session e8dac5bb)

### R-automation-016 · requested
Backlog displays items from all repos, including Garmin.
- asked: 2026-09-18 (session e8dac5bb)

### R-automation-017 · requested
Smart picker button is visible and functional for already-shipped scheduled items.
- asked: 2026-09-18 (session e8dac5bb)

### R-automation-018 · shipped
Once and recurring scheduling options work independently from usage-window settings.
- asked: 2026-09-15 (session cb2d9e19)
- shipped: 6beef0b

### R-automation-019 · shipped
Usage-window scheduling is offered as a prominent primary alternative to absolute time selection.
- asked: 2026-09-15 (session cb2d9e19)
- shipped: 3e87feb

### R-automation-020 · shipped
Default scheduling mode is 'once'.
- asked: 2026-09-15 (session cb2d9e19)
- shipped: 3e87feb

### R-automation-021 · shipped
The 'when it's free' option is a checkbox that can be combined with other scheduling options rather than an exclusive alternative.
- asked: 2026-09-16 (session b1446323)
- shipped: 6beef0b

### R-automation-022 · requested
Scheduled tasks can optionally switch between open-code, Claude, and model implementations.
- asked: 2026-09-17 (session 09c906b3)

### R-automation-023 · shipped
Build screen displays an AI-assistance button for setting up new build entries, which can accept runtime parameters and requests user input before starting the CLI session.
- asked: 2026-09-19 (session 6676a1aa)
- shipped: b87535a

### R-automation-024 · requested
Default build options apply as parameters across all builds.
- asked: 2026-09-22 (session e1fe2486)

### R-automation-025 · shipped
Scheduled tasks view can be filtered by repository, and tapping a repo's schedule chip opens the view pre-filtered to that repository.
- asked: 2026-09-23 (session fa87699f), 2026-09-23 (session fa87699f)
- shipped: 00d1dc0

### R-automation-026 · shipped
User can define the execution order for multiple tasks scheduled for the same instant.
- asked: 2026-09-23 (session fa87699f)
- shipped: c6b9713

### R-automation-027 · shipped
Waiting sessions that have a scheduled response display an indicator.
- asked: 2026-09-23 (session cdd9962c)
- shipped: 4ddcefe

### R-automation-028 · shipped
Headroom (percentage) scheduling conditions accept a custom user-entered value, not just presets, and remember the last input.
- asked: 2026-09-24 (session 6aede51e)
- shipped: 6a63d3b

### R-automation-029 · shipped
Multiple queued or scheduled items can be multi-selected and rescheduled to a new execution time in one action, using the full When editor (not just a time), from both the global schedules list and per-repository lists.
- asked: 2026-09-24 (session 9f393ecc)
- shipped: 6e339d7, be32b89, 6beef0b

### R-automation-030 · shipped
Usage-threshold scheduling triggers not met on one reset stay armed and retry at the next reset instead of failing.
- asked: 2026-09-24 (session 9f393ecc)
- shipped: 13081a8

### R-automation-031 · shipped
Scheduled items due before a weekly usage-limit reset execute as planned instead of being blocked by budget near the boundary.
- asked: 2026-09-24 (session 68e6d7ec)
- shipped: bdd2968, 8cc4f68, 9efbe6e, 8dffa3f

### R-automation-032 · shipped
Queued items can be explicitly run past usage-budget limits when waived, executing one at a time in turn (not fired all at once), still honoring serial 'keep till free' constraints and smart-pick rules.
- asked: 2026-09-24 (session 9f393ecc), 2026-09-24 (session 9f393ecc), 2026-09-24 (session 9f393ecc)
- shipped: bc8770d, fa9158e

### R-automation-033 · shipped
Budget status is shown via an icon or visual indicator on a repo's queue chip.
- asked: 2026-09-24 (session 9f393ecc)
- shipped: b62891f

### R-automation-034 · shipped
Prompts rescheduled to immediate ('now') execution run successfully and do not disappear from view.
- asked: 2026-09-24 (session 9f393ecc)
- shipped: 58ca68a, b62891f


### R-automation-035 · shipped
An agent working in a waterplane-driven repo can post a prompt for later — at a time, a set lead before the session or weekly usage window resets, after another item finishes, or now — into a new session or a named live one, once per key however often it retries; the answer says when it fires, the row is marked on the phone as posted by an agent, and the person can edit, re-time or delete it like any other; the agent can list and call off only the rows it posted.
- asked: 2026-09-30 (session 0134gwVH)
- shipped: 0a95879

### R-automation-036 · shipped
An agent working in a waterplane-driven repo can add a prompt to the repo's backlog, once per key however often it retries; the item is marked on the phone as posted by an agent and never starts by itself — not even with auto on — until the person fires it.
- asked: 2026-09-30 (session 0134gwVH)
- shipped: 9f716f6

### R-automation-037 · shipped
A session budget can be set when launching a session, on a backlog item, on a fan-out (each target's session) and on a scheduled prompt; the session that work opens starts with it, and re-timing the item keeps it. Scheduled work aimed at a session that is over its budget waits, saying why, until a person raises it, clears it or runs the item by hand.
- asked: 2026-10-01
- shipped: e4c2815, 4c8d686

