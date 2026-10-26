# automation

### R-automation-001 · shipped
Deployment scripts are triggered via buttons, no AI needed.
- shipped: 7aaee35

### R-automation-002 · requested
Garmin repo buttons build and ship apps in beta and prod variants.

### R-automation-003 · shipped
Artifact-generating repos have buttons that build new artifact versions; build results/APKs appear in the outbox and are downloadable directly after the build, including newly deployed APKs.
- shipped: 7aaee35, 3f7c7bc

### R-automation-004 · shipped
Setup screen offers predefined prompt triggers.
- shipped: d620752

### R-automation-005 · shipped
AI setup button executes its prompt, with AI assistance available in dialogue setup.
- shipped: b87535a

### R-automation-006 · requested
Scheduler provides simple date/time selection, not a complex interface, including calendar week navigation, a 5-minute time option, and a 'later' dialog whose confirm button is relabelled save for the chosen date/time.
- asked: 2026-09-11

### R-automation-007 · shipped
Scheduling supports relative times based on session-reset and weekly-window boundaries, with conditional (percentage-headroom) execution and notifications when conditions aren't met.
- shipped: 6a63d3b, 13081a8, fa9158e, 8dffa3f, 9efbe6e

### R-automation-008 · shipped
Commands/sessions scheduled for a due time execute automatically, and a 'run now' button can start them immediately.
- shipped: c6b9713, bc8770d

### R-automation-009 · shipped
Repo rows show a chip summarizing what is scheduled to run soon (e.g. counts per upcoming time window).
- shipped: 00d1dc0

### R-automation-010 · shipped
Checking (health/status) and starting (sessions) occur automatically when appropriate, without manual triggering.
- shipped: fc9f913, a05c881

### R-automation-011 · shipped
Scheduling options are expanded and made more powerful (flexible clock/usage-window/condition combinations).
- asked: 2026-09-17
- shipped: 58066b0, 6a63d3b, 6beef0b

### R-automation-012 · shipped
Each backlog item executes in its own independent session rather than all items running in a single session.
- asked: 2026-09-17
- shipped: f7caebb

### R-automation-013 · dropped
Backlog smart-pick option evaluates all remaining items when the next item is picked.
- asked: 2026-09-17
- shipped: f7caebb
- dropped: 2026-10-16 — smart pick removed: ~26 real passes, 0 merges, 2 reorders.

### R-automation-014 · shipped
Scheduled tasks and backlog items stay synchronized as one list.
- asked: 2026-09-18
- shipped: 58066b0

### R-automation-015 · requested
System tracks which scheduled items for today were worked on.
- asked: 2026-09-17

### R-automation-016 · requested
Backlog displays items from all repos, including Garmin.
- asked: 2026-09-18

### R-automation-017 · dropped
Smart picker button is visible and functional for already-shipped scheduled items.
- asked: 2026-09-18
- dropped: 2026-10-16 — smart pick removed (see R-automation-013).

### R-automation-018 · shipped
Once and recurring scheduling options work independently from usage-window settings.
- asked: 2026-09-15
- shipped: 6beef0b

### R-automation-019 · shipped
Usage-window scheduling is offered as a prominent primary alternative to absolute time selection.
- asked: 2026-09-15
- shipped: 3e87feb

### R-automation-020 · shipped
Default scheduling mode is 'once'.
- asked: 2026-09-15
- shipped: 3e87feb

### R-automation-021 · shipped
The 'when it's free' option is a checkbox that can be combined with other scheduling options rather than an exclusive alternative.
- asked: 2026-09-16
- shipped: 6beef0b

### R-automation-022 · shipped
Scheduled tasks can optionally switch between open-code, Claude, and model implementations.
- asked: 2026-09-17
- shipped: 9dea53c

### R-automation-023 · shipped
Build screen displays an AI-assistance button for setting up new build entries, which can accept runtime parameters and requests user input before starting the CLI session.
- asked: 2026-09-19
- shipped: b87535a

### R-automation-024 · requested
Default build options apply as parameters across all builds.
- asked: 2026-09-22

### R-automation-025 · shipped
Scheduled tasks view can be filtered by repository, and tapping a repo's schedule chip opens the view pre-filtered to that repository.
- asked: 2026-09-23, 2026-09-23
- shipped: 00d1dc0

### R-automation-026 · shipped
User can define the execution order for multiple tasks scheduled for the same instant, by manual sorting in the backlog and by asking for it in a scheduling prompt without using the UI.
- asked: 2026-09-23, 2026-10-15
- shipped: c6b9713

### R-automation-027 · shipped
Waiting sessions that have a scheduled response display an indicator.
- asked: 2026-09-23
- shipped: 4ddcefe

### R-automation-028 · shipped
Headroom (percentage) scheduling conditions accept a custom user-entered value, not just presets, and remember the last input.
- asked: 2026-09-24
- shipped: 6a63d3b

### R-automation-029 · shipped
Multiple queued or scheduled items can be multi-selected and rescheduled to a new execution time in one action, using the full When editor (not just a time), from both the Automation sheet's clock list and per-repository lists.
- asked: 2026-09-24
- shipped: 6e339d7, be32b89, 6beef0b

### R-automation-030 · shipped
Usage-threshold scheduling triggers not met on one reset stay armed and retry at the next reset instead of failing.
- asked: 2026-09-24
- shipped: 13081a8

### R-automation-031 · shipped
Scheduled items due before a weekly usage-limit reset execute as planned instead of being blocked by budget near the boundary.
- asked: 2026-09-24
- shipped: bdd2968, 8cc4f68, 9efbe6e, 8dffa3f

### R-automation-032 · shipped
Queued items can be explicitly run past usage-budget limits when waived, executing one at a time in turn (not fired all at once), still honoring serial 'keep till free' constraints.
- asked: 2026-09-24, 2026-09-24, 2026-09-24
- shipped: bc8770d, fa9158e

### R-automation-033 · shipped
Budget status is shown via an icon or visual indicator on a repo's queue chip.
- asked: 2026-09-24
- shipped: b62891f

### R-automation-034 · shipped
Prompts rescheduled to immediate ('now') execution run successfully and do not disappear from view.
- asked: 2026-09-24
- shipped: 58ca68a, b62891f


### R-automation-035 · shipped
An agent working in a waterplane-driven repo can post a prompt for later — at a time, a set lead before the session or weekly usage window resets, after another item finishes, or now — into a new session or a named live one, once per key however often it retries; the answer says when it fires, the row is marked on the phone as posted by an agent, and the person can edit, re-time or delete it like any other; the agent can list and call off only the rows it posted.
- asked: 2026-09-30
- shipped: 0a95879

### R-automation-036 · shipped
An agent working in a waterplane-driven repo can add a prompt to the repo's backlog, once per key however often it retries; the item is marked on the phone as posted by an agent and never starts by itself — not even with auto on — until the person fires it.
- asked: 2026-09-30
- shipped: 9f716f6

### R-automation-037 · shipped
A session budget can be set when launching a session, on a backlog item, on a fan-out (each target's session) and on a scheduled prompt; the session that work opens starts with it, and re-timing the item keeps it. Scheduled work aimed at a session that is over its budget waits, saying why, until a person raises it, clears it or runs the item by hand.
- asked: 2026-10-01
- shipped: e4c2815, 4c8d686

### R-automation-038 · shipped
Jobs scheduled on the host start and run even when the phone is off; the phone is not needed for startup queries.
- asked: 2026-10-04, 2026-10-05
- shipped: b7fea804

### R-automation-039 · requested
A custom time input is available wherever a time has to be chosen.
- asked: 2026-10-08

### R-automation-040 · shipped
The Build sheet has an additional entry that generates everything in one action.
- asked: 2026-10-12
- shipped: build entry "Docs media: everything" (named in b8e9b5e7) — first in the untracked `.waterplane/builds.json`; build entries now live in the committed `.waterplane-shared/builds.json`, where the shared-builds migration moves it


### R-automation-041 · superseded
Sessions that backlog or scheduled work opens stay open by default; closing them when done is a global setting with a per-item override, and while every automatic slot is held by an open session the next item waits until a person closes one.
- asked: 2026-10-01
- shipped: cd044878
- superseded-by: R-automation-042

### R-automation-042 · shipped
An automatic session holds one of the desktop's automatic-session slots only while it is working (a turn running, a question or permission box open, a background shell or agent still going). A finished, idle session left open holds none, so keeping sessions open never stops queued or scheduled work from starting; nothing is closed to make room.
- asked: 2026-10-14
- shipped: 67d048ac

### R-automation-043 · shipped
Work let past last week's budget (timed before the weekly reset, or waived past the weekly ceiling) that did not start before the reset runs in the new week only while the week's usage is under a separate leftover ceiling (default 20%, settable or off); a person letting it past the budget again lifts it.
- asked: 2026-10-14
- shipped: be8dc2e0

### R-automation-044 · shipped
A backlog item that is already queued — including one waiting on a clock — can have its session budget set, changed or cleared from its own row, as long as it opens a session of its own and has not started. A row aimed at a live session shows no budget (that session's budget is set on the session), and offline the row says the change needs the desktop.
- asked: 2026-10-15 — "add the option for scheduled items to set a budget", clarified as: change/clear on an already-queued item
- shipped: 5ff4bf7c

### R-automation-045 · shipped
Work timed to start at the weekly reset or right after it (within the new week's first five hours) is held by the same leftover ceiling as work let past last week's budget: it starts only while the new week is under that ceiling, and its row says so.
- asked: 2026-10-15 — "our new budget cap that we introduced for sessions that start right before should also affect these ones that start right after the session limit reset"
- shipped: cc11f1a5

### R-automation-046 · shipped
On a repo's backlog, every timed item waiting on the same clock can be picked in one tap and moved to one new time together (e.g. past the reset); the pick list is above the rows, including in a cut opened from elsewhere, and stays on screen while ticking.
- asked: 2026-10-15 — "Add a multi select option so I can reschedule any timed work items at the same time e.g. to move them past the session reset"
- shipped: 8feaea28

### R-automation-047 · shipped
A dollar cap on a period holds automatic work only once the period's spend reaches it; a prompt a person sends by hand never asks the cap. The hold says which period and releases by itself at the period's computed reset. With nothing measured, nothing is held.
- asked: 2026-10-12 (billing-periods plan)
- shipped: de9aef7d

### R-automation-048 · shipped
A schedule rule that follows the session window refuses a rolling-30-day period, in words, since it has no edge to follow; a calendar period is accepted and its reset reaches window rules.
- asked: 2026-10-12 (billing-periods plan)
- shipped: 413bfbd8, de9aef7d

### R-automation-049 · shipped
When an API account runs out of credit or hits a spend limit, the session counts as at a wall: its automatic work is held, and it makes one attempt to resume at a reset the CLI printed or at the active dollar calendar period's reset. With neither, it tells the person it needs them; no clock time is ever invented. Subscription banners behave as before.
- asked: 2026-10-12 (billing-periods plan)
- shipped: fd07bc44

### R-intent-local-001 · shipped
Automatic starts on a local model wait while the local-session cap is in use (one at a time by default) and the model is loaded on the runner before the item opens; a held row names the reason (the working local session, the model loading, Ollama unreachable, the model missing). A person's own start past the cap is told, never refused. The cap is a synced setting on the phone ("local model sessions at once", 1–3 or no limit).
- asked: 2026-10-13

### R-automation-050 · shipped
A desktop-wide list of "ask before" rules (Claude Code permission-rule strings such as `Bash(git push * main)`) makes a driven `claude` stop and show the person a box with the exact command, even in bypass-permissions mode. A fresh install has no rule active; a suggested list (force pushes, pushes to main/master, production deploys, releases, publishes, applies) is offered and never applied by itself. With no rule the launch is unchanged. Host side only: the list is stored on the desktop and read and changed over the host API.
- asked: 2026-10-13 (owner, agent-authority plan)
- shipped: 68f67124 83624d31 94a23918
- note: a rule matches the words typed, not git's state; it stops the accident, not a wrapper script or an agent that talks the person into Yes. docs/plans/agent-authority.md §2.

### R-automation-051 · shipped
On the phone, a desktop-wide "Ask before" settings section lists the rules (with the suggested list one tap to add) and a per-repo "off here" row turns a rule off for a repo where that action is the daily flow. It says at the moment of a change that running sessions keep the rules they were launched with, and that other backends (opencode, Copilot) take no such rule. - note: in progress; the host half is R-automation-050.
- asked: 2026-10-13 (owner, agent-authority plan)
- shipped: 39d7b1ec

### R-automation-052 · shipped
Changing the ask-rule list needs a browser origin: an agent's origin-less request cannot quietly delete a rule.
- asked: 2026-10-13 (owner, agent-authority plan)
- shipped: 83624d31

### R-automation-053 · requested
A per-repo Claude-dollar day ceiling, a third scope beside the account periods and session budgets, holds that repo's automatic work once reached ("4.10 $ of 5 today in <repo>") and releases through the existing past-budget waiver tap. Not built; waits on owner question 2 of docs/plans/agent-authority.md.
- asked: 2026-10-13 (owner, agent-authority plan)

### R-automation-054 · requested
A repo's own external-API spend (a key it holds in the vault) is shown as yesterday's number from the provider's usage API where one exists, never today's, never a refusal, and unknown rather than zero otherwise. Not built; waits on owner question 3 of docs/plans/agent-authority.md.
- asked: 2026-10-13 (owner, agent-authority plan)

### R-automation-055 · requested
Releasing a login that belongs to the owner (`mine`) to an agent requires a written reason, quoted on the release card with "whatever this program does, it does as you". Not built; waits on owner question 4 of docs/plans/agent-authority.md.
- asked: 2026-10-13 (owner, agent-authority plan)

### R-automation-056 · requested
When more than three tool boxes in a day were answered by the person, a sentence says the policy is wrong, not the person; words only, never a refusal. Not built; waits on owner question 7 of docs/plans/agent-authority.md.
- asked: 2026-10-13 (owner, agent-authority plan)

### R-automation-057 · shipped
When a timed item lands in a slot that already holds others (same usage-window reset, or the same instant), the person is asked whether to check them together — on the send receipt when they typed it, on the slot's group header (*check these N*, exactly those rows) when an agent posted it — and a per-repo switch turns the ask off. The check is the assessment scoped to that slot: it may propose merges (carrying the latest member's clock), an order within the slot, a split of one item into two (posted on the same clock, the original archived), and conflicts (words only, never resolved for the person); each change is approved one at a time and nothing applies itself. Replaces the smart pick (R-automation-013, R-automation-017).
- asked: 2026-10-16 (owner, .claude/outbox/schedule-check-plan.md)
- shipped: 23c317c4, 0d3cfdf4, 025374fc, 232e127c

### R-automation-058 · shipped
One build entry ships the docs media end to end: re-cuts every gif and the APK film, rebuilds the site page from the README (its gif sizes follow the new films), commits only those files, pushes, then publishes the public mirror and its media repo. Any failed step stops it before anything is committed or pushed.
- asked: 2026-10-18
- shipped: build entry "Docs media: ship" in `.waterplane-shared/builds.json`
### R-automation-059 · requested
Scheduled items with their own budget and no budget condition fire at their scheduled time even when the global budget limiter is nearly exhausted, consuming the remaining usage.
- asked: 2026-10-14

### R-automation-060 · requested
Agent authority (what an agent may cause, such as spending, deploying, pushing to main or sending mail) is a separate feature from vault secret protection, with its own UI and decisions, and never appears on vault approval cards.
- asked: 2026-10-15, 2026-10-15

### R-automation-061 · requested
A button lets the user re-trigger a run when nothing is running.
- asked: 2026-10-16

### R-automation-062 · shipped
While a build tool entry runs in a repo, its header button shows a busy indicator, like the git button during a push.
- asked: 2026-10-17
- shipped: c4e08626

### R-automation-063 · requested
Scheduled work items, including the midnight run, appear in the waterplane schedule.
- asked: 2026-10-18


### R-automation-064 · requested
Each week the person picks the repos for the week-end burn, and that pick is the approval: it covers only the week it was made for, a new week starts with no picks, and "repeat each week" only asks again (push and one-tap "same as last week"), never runs last week's repos by itself.
- asked: 2026-10-24

### R-automation-065 · requested
The week-end burn posts one small improvement package per picked repo at a time, the next only after the previous settles, up to a per-repo weekly cap. Each package makes one focused change, runs the repo's tests and commits only if they pass; the weekly budget cap is lifted for these rows only.
- asked: 2026-10-24

### R-automation-066 · requested
The week-end burn stops posting once the week reaches its stop line (default 95%) or the weekly reset is under 20 minutes away; rows already running finish. A missing or stale weekly reading posts nothing, and a non-subscription account is told the feature does not apply.
- asked: 2026-10-24

### R-automation-067 · requested
The week-end burn starts early enough, from the measured weekly points one 5-hour window can burn, to use the week's budget before the reset, never before now. With no measured full window it starts a day before the reset and says so in one sentence the phone and host both print.
- asked: 2026-10-24

### R-automation-068 · requested
When the person has not picked repos and is on pace to leave a large part of the week unused, one push per week offers the week-end burn and opens its sheet; a repeating burn gets the same push to pick the week's repos.
- asked: 2026-10-24

### R-automation-069 · requested
A weekly pass over the week-end burn rows, and only those, lifts the weekly and session budget caps for them until the weekly reset.
- asked: 2026-10-24

### R-automation-070 · shipped
The schedules sheet is called Automation. Its "Runs on its own, no clock" block, drawn above the cards (never as the list's tail, where it was missed and read as one more card), lists what else this desktop starts by itself — backlog auto with the rows it will start next, the repo's auto-download rule, the week-end burn, peer jobs waiting here — one sentence and one door each, to where that thing is managed; per repo when the sheet is cut to one repo. A count opens exactly those rows; a source the phone has not read draws no line.
- asked: 2026-10-25 (automation UI plan, section C)

### R-automation-071 · shipped
A schedule can run a build entry: each occurrence posts one ordinary build run (no agent, no tokens) that says which rule fired it. Parameter values are picked on the rule's form, seeded from the build's defaults; a missing value, an unknown build or a repo this desktop does not serve is refused on save in words, and a build deleted later fails that occurrence in words. On the build sheet an entry with rules wears a clock and one line ("every weekday 07:00 · next in 3h", "paused" said in text) whose tap opens Automation cut to exactly those rules; "run on a clock…" sits in the entry's editor.
- asked: 2026-10-25 (owner, dictated: "if build tool entries are automated they should link to it and have visual clues for that")

### R-automation-072 · shipped
The week-end burn sheet says, above its repo list, what ticking a repo does: unattended sessions from the start time to the stop line, one at a time, each one small fix committed on the current branch only if tests pass, nothing pushed.
- asked: 2026-10-26 (owner, on a screenshot: "this dialogue misses to tell what it will do if I select an item")
### R-automation-073 · requested
A daily scheduled check runs for a week; on a network/DNS outage it starts a Claude session to investigate and flags the finding in waterplane.
- asked: 2026-10-25

### R-automation-074 · shipped
The week-end burn sheet scrolls so every repo is reachable, and two clones with the same name are told apart by their path instead of showing one name twice.
- asked: 2026-10-25
- shipped: b5dbb527

