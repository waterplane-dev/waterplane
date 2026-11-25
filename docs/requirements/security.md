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
Exposure findings appear on the phone as compliance check rows counting toward the setup badge (the Setup check's cut shows exactly them; watch rows open the watch region by their row). The owner can accept a finding with a reason and expiry (version, date or reading hash); accepted findings stop being reported and stay visible under 'Accepted (n)'.
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

### R-security-012 · shipped
The exposure watch can be switched on for a repo from an opt-in card, and the empty watch tab links to that card.
- asked: 2026-10-26
- shipped: 41b4a401

### R-security-013 · shipped
The project runs on a supported Node.js release (not end-of-life Node 20), with the critical Capacitor advisory and the @azure/msal-node advisory fixed by upgrades.
- asked: 2026-10-26, 2026-10-26
- shipped: 9da77f95, 6e9e21ff, 061e5051

### R-security-014 · shipped
The project has no known vulnerable dependencies; any advisory that cannot apply is documented with a reason in an osv-scanner config.
- asked: 2026-10-29
- shipped: 62ceb852, f90544c3

### R-security-015 · shipped
The project has an OpenSSF best-practices entry that the maintainer creates and fills in, so the CII-Best-Practices check can pass.
- asked: 2026-10-29
- shipped: e6db687a, ca26b5fd

### R-security-016 · shipped
Artifact listing never follows a symlink that escapes the repository, and every artifact walk applies the same containment rule.
- asked: 2026-10-30
- shipped: de6ad2be

### R-security-017 · shipped
The public OpenSSF Scorecard for waterplane shows no vulnerability finding: known advisories in dependencies are fixed, or documented with a reason in an osv-scanner config where they cannot apply.
- asked: 2026-10-30
- shipped: 62ceb852, f90544c3


### R-security-018 · shipped
The exposure watch lists a repo's open code-scanning security alerts (CodeQL and other tools, never Scorecard's own uploads or code-quality notes) as one row per rule with its count and locations; high and critical, or one open over 14 days, are alerts, the rest are to consider. A repo with no code scanning is said as a setting, never as a gap, and a repo that loses code scanning is reported. The findings-only cut of the readings says how many rows to consider it hides.
- asked: 2026-11-02

### R-security-019 · shipped
A regular expression that can backtrack super-linearly (the ReDoS class GitHub's CodeQL reports as polynomial-redos) fails lint at commit and push time, in private code too, before it reaches a release. The existing ones are a recorded baseline that may only shrink. The public copy of that baseline never names a private file.
- asked: 2026-11-02
### R-security-020 · shipped
The Waterplane repo has no open CodeQL code-scanning or Dependabot alerts.
- asked: 2026-11-02
- shipped: a61a4b4a, 97a78c02

### R-security-021 · shipped
On a route that is not protected the Android app refuses every vault fingerprint use, every over-the-air update and every app download or install, saying why in text, and an update resumes by itself on the next connection over a protected route. Protected means: this device; a Tailscale address or MagicDNS name (unless a newer app reports that the phone has no tailnet); a Wi-Fi address the phone holds a pin for (R-connection-032); or an https address the person typed themselves. An https address alone is not protected, and neither is a name that merely looks like a tailnet's.
- asked: 2026-11-03 (owner)
- shipped: bc678f19
- note: the rule is `isPlainRoute` in shared, mirrored by `ShellRoute.java`. The pin and the no-tailnet report need a newer app; an older app keeps the older answer (tailnet and HTTPS only). Not tried on a phone.

### R-security-022 · shipped
A route that is not protected (R-security-021) is warned about loudly: an unfolded warning in the address form and the health sheet, "LAN, not protected" (or "not protected" off the LAN) on the strip, a toast when the app moves onto it by itself, and a doctor warning on the desktop. The words say "not protected", not "not encrypted", because an https address can be unprotected too.
- asked: 2026-11-03 (owner)
- shipped: f3aeee6d
- note: not yet tried on a real phone.

### R-security-023 · shipped
A desktop that opts in to the LAN (`WATERPLANE_ALLOW_PUBLIC=1`) also answers on an encrypted port that the Android app pins, so the device token, the app's pages and downloads cross the Wi-Fi as ciphertext to that desktop and nothing else. Nothing listens there without the opt-in, the password gate is the same, and the port is not reachable from loopback or the tailnet. It is on by default with the opt-in (default port + 1, 8771), `WATERPLANE_TLS=0` turns it off, and a busy port is logged while the host carries on plain. The Wi-Fi owner can still stop the connection, and a person who gets into the desktop's files can read its keys: this protects the network path, not the desktop.
- asked: 2026-11-03 (owner)
- shipped: ce1e392c, 1da2c03a
- note: SECURITY.md lists what pinning does not defend. A browser on the LAN is not covered (its page arrives unprotected). Not tried on a phone.

### R-security-024 · requested
The project reaches the OpenSSF Best Practices Silver badge, so the CII-Best-Practices check rises from 5 to 7. The docs Silver asks for exist (governance, roles, roadmap, assurance case, how to verify a release by hand); the maintainer fills in the form, and statement coverage, continuity and repeatable builds are still open.
- asked: 2026-11-06 (owner)
### R-security-025 · shipped
The exposure report names this repository's own private origin as the scored repository when that is the origin, and shows the scored-repository line under the score at the top.
- asked: 2026-11-03
- shipped: 3b9c1573

### R-security-026 · shipped
Pairing and the encrypted link run between the phone and the desktop with no cloud service in between, and waterplane runs no cloud service of its own for updates: they come from the desktop or from the public GitHub and Google Play releases.
- asked: 2026-11-03
- shipped: db775c2b, 1da2c03a, c7661bd2

### R-security-027 · shipped
The documentation describes HTTPS and always-on encryption accurately, including that the Wi-Fi address is typed plain and the app encrypts it on the pinned TLS port.
- asked: 2026-11-10
- shipped: e442fbed

### R-security-028 · shipped
The phone-side passive mode for kids' devices only calls API routes that the host's passive allowlist permits.
- asked: 2026-11-10
- shipped: 7cdcc498


### R-security-029 · shipped
The Scorecard sheet shows the score over time: one point per Scorecard run on a fixed 0–10 axis, past public runs read back from the Scorecard API, and a drag naming a run's date, score, commit and which checks moved since the run before.
- asked: 2026-11-15
- shipped: 2c9c1f402

### R-security-030 · shipped
Each finding in the Setup check says when it was first seen.
- asked: 2026-11-22
- shipped: 33d753210

### R-security-031 · shipped
The LAN identity is sealed with its desktop's token and never stored as a plain key while the mode is on.
- asked: 2026-11-22
- shipped: 42be63aa8

### R-security-032 · requested
The Cloud Run service uses its own key, separate from the keys of other services.
- asked: 2026-11-22


### R-security-033 · shipped
A laptop's browser can open this desktop over plain Wi-Fi with real HTTPS, without Tailscale: one command on the desktop issues a certificate for one name the person chose, the person trusts it on the laptop by hand, and the desktop trusts that name only on its own encrypted port. The key that could sign another certificate is never kept, and a name the phone app dials is refused.
- asked: 2026-11-24 (owner: the vault must work over LAN without Tailscale, R-vault-066)
- shipped: 090dbe58a
- note: docs/install.md has the steps, SECURITY.md the rule. Not tried in a real Windows browser.

### R-security-034 · shipped
A web page under a name the local network answers for (this desktop's own `.local` or short name, an `ALLOWED_HOSTS` alias) gets nothing from this desktop without the password or a device token, from a browser on the desktop and from a Tailscale device alike, however it points the name. The name still works as a route with a sign-in, the sign-in screen says why it asks and what to open instead, and addresses, `localhost`, the full `*.ts.net` name, `tailscale serve`, a proxy whose https origin is listed, the apps and local processes are unchanged.
- asked: 2026-11-25 (owner: fix what the vault multi-device work found)
- shipped: bd09a8965
- note: the rule and its residuals are in SECURITY.md (Browser origins).

### R-security-035 · shipped
A password sign-in under a name the local network answers for ends by itself after 12 hours and works only under such a name, so whoever answers for the name cannot use its cookie for long, nor over the Wi-Fi door or Funnel. The sign-in card says so, and the paired-devices list names the name and when it ends. Sign-ins over the Wi-Fi door, the apps' device tokens and Tailscale are unchanged.
- asked: 2026-11-25 (owner: "Create backlog items for all remaining work", remainder of R-security-034)
- shipped: 08bc36a30

### R-security-036 · shipped
On loopback, this desktop's `*.ts.net` name is trusted only on a port a front door has (none, 80, 443, one `tailscale serve` hands to the daemon on, or one listed in `WATERPLANE_ALLOWED_ORIGINS`), so a hand-made forward on another port is not one. A `tailscale serve` port added while the daemon runs works without a restart.
- asked: 2026-11-25 (owner: "Create backlog items for all remaining work", remainder of R-security-034)
- shipped: 08bc36a30
- note: where the serve config was never readable any port still counts.
