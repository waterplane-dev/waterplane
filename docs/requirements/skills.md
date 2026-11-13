# skills

### R-skills-001 · shipped
A person can switch each Claude skill between on, name only, slash only and off from the phone, without editing a settings file on the desktop.
- asked: 2026-11-12 (owner)
- plan: docs/analysis/skills-switch/PLAN.md
- shipped: 3c37ae7e

### R-skills-002 · shipped
A person can switch a whole Claude plugin on or off from the phone, claude.ai-synced plugins included; a plugin's own skills follow the plugin and are not offered a switch of their own.
- asked: 2026-11-12 (owner)
- note: Measured on claude 2.1.322: skillOverrides is ignored for plugin skills, so the plugin switch is the only lever there.
- shipped: 3c37ae7e

### R-skills-003 · shipped
Every switch is made at one of two levels: for all repos on this desktop, or for one repo. The screen shows which level a row's state comes from and which wins.
- asked: 2026-11-12 (owner)
- shipped: 3c37ae7e

### R-skills-004 · shipped
The per-repo switch writes the repo's gitignored local settings file by default, and writes the shared project settings file only when the person chooses that on the save bar.
- asked: 2026-11-12 (owner)
- note: 2026-11-13 owner found the old top-of-screen link confusing: the choice is a two-way "just me, this desktop / everyone with the repo" on the save bar (and beside Apply), with a line saying what the chosen file means.
- shipped: 1191f778

### R-skills-005 · shipped
Nothing is written until the person taps save; the save bar names the exact file it will write and says what it will change.
- asked: 2026-11-12 (owner)
- shipped: 3c37ae7e

### R-skills-006 · shipped
Saving merges into the existing settings file: every other key is kept, and a file that cannot be parsed, or that changed on disk since the screen read it, is left exactly as it is with a sentence saying why.
- asked: 2026-11-12 (owner)
- shipped: 1191f778

### R-skills-007 · shipped
The screen says that a change reaches new sessions only, not the sessions already running.
- asked: 2026-11-12 (owner)
- shipped: 3c37ae7e

### R-skills-008 · shipped
Each skill and plugin shows its weight on every turn (characters and about how many tokens) and how often it was used in this repo, in the last 30 days and all time, counted from the Claude conversation logs on this desktop.
- asked: 2026-11-12 (owner)
- note: A weight the desktop cannot measure (a bundled skill, an unreadable plugin) is said to be unmeasured, never shown as 0.
- shipped: 3c37ae7e

### R-skills-009 · shipped
A "suggest" button makes one cheap unattended call that weighs size, use in this repo (overall and recently) and what CLAUDE.md and the repo's skills mention, and returns suggestions the person ticks and approves; nothing is applied by the suggestion itself.
- asked: 2026-11-12 (owner)

### R-skills-010 · shipped
A skill or plugin that CLAUDE.md or a repo skill refers to is never suggested for switching off.
- asked: 2026-11-12 (owner)
- shipped: f17e9a7d

### R-skills-011 · shipped
The screen opens from the set-up sheet's agent-context-weight row and from the skill listing in "What every turn carries".
- asked: 2026-11-12 (owner)
- shipped: 3c37ae7e

### R-skills-012 · shipped
For a backend that is not Claude Code the screen says in text that this is not available for this backend; it shows no switches.
- asked: 2026-11-12 (owner)
- shipped: 3c37ae7e

### R-skills-013 · shipped
The screen works from whatever skills and plugins the desktop's owner has installed; no skill or plugin name is built into the app.
- asked: 2026-11-12 (owner)
- shipped: 3c37ae7e

### R-skills-014 · shipped
A passive (kids') device cannot read or change the skill switches.
- asked: 2026-11-12 (plan decision; no owner ask)
- shipped: 1191f778

### R-skills-015 · shipped
The All repos view shows the value set for all repos, not the value this repo ends up with; a row this repo overrides says so and opens This repo.
- asked: 2026-11-13 (owner)

### R-skills-016 · shipped
In This repo, a row follows the All repos setting (an unsaved All-repos choice included) until the person picks a different value there; each row says whether it follows All repos or is set for this repo, with one tap to follow again or to keep the value for this repo.
- asked: 2026-11-13 (owner)

### R-skills-017 · shipped
The skills screen and Repo readings open each other: the readings' agents region opens the skills screen, and the skills screen opens what every turn of the repo carries.
- asked: 2026-11-13 (owner)

### R-skills-018 · shipped
Every suggestion shows its reason as its own first line, and says in plain words what each state it moves something to means (names only, slash only, off), so the words need no lookup.
- asked: 2026-11-13 (owner)

### R-skills-019 · shipped
One suggestion run sets both levers at once: each item says what All repos becomes and what this repo ends up with (its own value, kept against the All-repos change, or following it), weighed on uses in this repo and across every repo on this desktop; one Apply writes both files. All repos is never raised by a suggestion, and an item this repo's files name is kept here.
- asked: 2026-11-13 (owner)
