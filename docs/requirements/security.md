# security

### R-security-001 · shipped
The repo has no committed credentials or tokens, no dependencies with known vulnerabilities, and no shell interpolation of user input, unvalidated paths or missing auth checks; all security findings are fixed.
- asked: 2026-10-21, 2026-10-21
- shipped: 2f0b812f, d3ccffef, 998d8b24, 2c95451e

### R-security-002 · shipped
The host never listens on a public network interface, and API responses never carry a wildcard CORS header.
- asked: 2026-10-22
- shipped: a459c66e

### R-security-003 · shipped
Repo-health tooling runs only after a one-time user approval, and approval is required again when its code changes.
- asked: 2026-10-22
- shipped: d29199d6

### R-security-004 · shipped
An exposure watch collects dependency, vulnerability and security findings per repo into a per-repo history file; each run reports nothing new, findings needing action, or a source that could not be reached. An unavailable source shows as absent with its reason, never a pass; one advisory from two sources is listed once by GHSA id; the first run lists everything currently exposed.
- asked: 2026-10-26
- shipped: 025ace37

### R-security-005 · shipped
The WP UI shows dependency, vulnerability and security measurements for every public repo, with thresholds the owner can review (fixed code defaults, no edit form; the node-pty pin finding is pre-accepted), and these checks run before each public release.
- asked: 2026-10-26, 2026-10-26
- shipped: 025ace37, 55a3a885

### R-security-006 · shipped
Public repos with code run CodeQL, and the OpenSSF Scorecard runs with its results published.
- asked: 2026-10-26
- shipped: 15c0ea03

### R-security-007 · shipped
Exposure findings appear on the phone as compliance check rows counting toward the setup badge, with a 'findings' focus showing exactly them. The owner can accept a finding with a reason and expiry (version, date or reading hash); accepted findings stop being reported and stay visible under 'Accepted (n)'.
- asked: 2026-10-26, 2026-10-26
- shipped: 55a3a885

### R-security-008 · shipped
Each exposure finding offers an Ask Claude action that produces a remedy.
- asked: 2026-10-26
- shipped: 55a3a885

### R-security-009 · shipped
Scorecard is an optional extension, off until enabled; it shows an OpenSSF Scorecard badge on the repo row and in the setup sheet for repos with a GitHub remote. It makes no model calls and needs no credentials; repos it cannot score show an absent state with the reason.
- asked: 2026-10-26, 2026-10-26
- shipped: 4dbc3703

### R-security-010 · shipped
Tapping the Scorecard badge shows exactly the failing checks (a count acts as a filter); each offers a remedy prompt or Accept-with-reason, and solo-unfixable checks (Code-Review, Contributors, Fuzzing) are pre-labelled.
- asked: 2026-10-26
- shipped: 4dbc3703

### R-security-011 · requested
Owner-specific identifiers, owner config and app ids never appear in the public repository tree or mirror.
- asked: 2026-10-26, 2026-10-26

