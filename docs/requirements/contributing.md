# contributing

### R-contributing-001 · shipped
Outside contributors ask for features as intent requests — an issue stating the problem, the
intended end state, testable acceptance criteria and non-goals, graded beforehand by a skill that
runs on the contributor's machine — and the owner builds accepted ones fresh, crediting the
requester with a `Requested-by:` commit trailer and a CHANGELOG mention.
- asked: 2026-10-01 (owner, open-source contribution policy)
- shipped: bcd117d

### R-contributing-002 · shipped
Code pull requests from outside are merged only when they add a failing test that reproduces a bug
or fix docs/typos; any other PR is closed with a pointer to the intent-request process.
- asked: 2026-10-01 (owner, open-source contribution policy)
- shipped: bcd117d

### R-contributing-003 · shipped
A contributor's request is never fed verbatim to an agent: the owner rewrites it into their own
brief, and example code in a request is read, never pasted.
- asked: 2026-10-01 (owner, open-source contribution policy)
- shipped: bcd117d
### R-contributing-004 · shipped
Users can fork and customize waterplane while still pulling upstream release updates; a fork is an upstream release plus a plugins directory and a config overlay, and never edits core.
- asked: 2026-10-04, 2026-10-05
- shipped: 30f44ff

### R-contributing-005 · requested
The project stays low-maintenance and easy for others to collaborate on.
- asked: 2026-10-08

### R-contributing-006 · shipped
Every module named in CLAUDE.md or a skill is described in docs/notes, so no entry is the only record of that module.
- asked: 2026-10-09
- shipped: 57829310

### R-contributing-007 · shipped
The README is a clear first touchpoint: a visitor understands the project and how to get started from its first screen.
- asked: 2026-10-11
- shipped: bbb4349c

### R-contributing-008 · shipped
Every source file in the extension host, shared and cli halves, and tools scripts stays under 900 lines, enforced by lint with no disable comment or higher cap.
- asked: 2026-10-21
- shipped: df9a900b, 49307dc3

### R-contributing-009 · shipped
A file at the line cap is split by subject, never by deleting its explanatory comments; echo.ts stays the proof a typed prompt reached the composer, split from composer.ts, each under about 750 lines, with its notes kept.
- asked: 2026-10-21, 2026-10-21
- shipped: d01ebdd4, 169d15ab

