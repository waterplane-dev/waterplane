# vault

### R-vault-001 · shipped
Plaintext credentials such as the gcloud login, Gemini API keys and dashboard session cookies are stored encrypted and released on demand only after fingerprint confirmation on the phone.
- asked: 2026-10-05
- shipped: 36b98edb, de056f3a, acee58dd

### R-vault-002 · shipped
Access to a vault secret can be granted in advance for a defined purpose and time window so unattended jobs can use it; a bounded grant lasts at most 24 hours and has a use cap; a standing grant (R-vault-052) is the one kind with no end until revoked.
- asked: 2026-10-05
- shipped: b1b78ee4

### R-vault-003 · shipped
Writing or deleting a vault secret requires phone approval that shows who is asking and which version gets replaced.
- asked: 2026-10-05
- shipped: c1f15e0c

### R-vault-004 · shipped
The recovery key is shown only on the phone sheet, never on the desktop's stdout; the user must retype one group to confirm they saved it.
- asked: 2026-10-10, 2026-10-11
- shipped: c3328ebb

### R-vault-005 · shipped
The vault is driven by buttons in the phone UI, including create and recover, with no need for the CLI. The sheet opens by itself when setup is needed, and a button moves between it and one desktop shell and back.
- asked: 2026-10-10, 2026-10-11
- shipped: d90771dd, 6b2b2674, d7a72bc7

### R-vault-006 · shipped
Existing secrets are found and migrated into the vault from vault UI components: the user picks individual secrets, stores and tries the vault copy, then purges the original or moves it back; an original is removed only after the vault copy is verified.
- asked: 2026-10-10, 2026-10-11
- shipped: 8548f748, 677bd4f6, 07829d62, 759de8ed

### R-vault-007 · shipped
The vault exports to a password-protected file or copy-pasteable text in kdbx, Bitwarden, OpenSSL and plain formats; the generated export password is shown on the phone, and the dialog says the export is only a copy and the vault stays encrypted and usable.
- asked: 2026-10-10, 2026-10-11, 2026-10-11
- shipped: 80b5f0d3, 677bd4f6, 9e42608a
- note: the Bitwarden file is proved against Bitwarden's own importer code on a fixture (27d23e69, test/export-bitwarden-importer.test.mjs, skips unless the bundle is built). A live import into an account has not been done; the server's field limits were read, not run, and only notes are checked against them.

### R-vault-008 · shipped
The vault screen has a lock-now button that ends everything open.
- asked: 2026-10-11
- shipped: 9e42608a

### R-vault-009 · shipped
The vault's key exchange and sealing are quantum safe, using hybrid ECDH-P256 with ML-KEM-768.
- asked: 2026-10-10, 2026-10-11
- shipped: 50bfda54, c3328ebb

### R-vault-010 · shipped
The vault can be reset with `wp-secret reset` to start empty again.
- asked: 2026-10-11
- shipped: c3328ebb

### R-vault-011 · shipped
Each migrated secret gets a plain-language note, drafted by AI at migration time from value-free repo context, saying which actions need it and how long it stays in use.
- asked: 2026-10-11
- shipped: 9e8ad0d8, 089cda52

### R-vault-012 · shipped
A practice project with a short-lived practice key lets the user try the full vault workflow end to end.
- asked: 2026-10-11
- shipped: 07829d62, 759de8ed

### R-vault-013 · requested
The phone warns when the daemon, its binary or relevant code looks tampered with, based on checksums.
- asked: 2026-10-11

### R-vault-014 · shipped
Vault documentation lives in the repo and can later ship as an experimental public feature once the vault is trusted.
- asked: 2026-10-11
- shipped: a360ff1e

### R-vault-015 · shipped
Secret values never reach the AI model, including in later describe-again passes after the value is no longer at hand.
- asked: 2026-10-12
- shipped: 77b12dd5, ec147f72

### R-vault-016 · shipped
Secrets moved in by the scan are released only to the repos they were found in, by default: a copy found in a global place (a shell rc, `~/.npmrc`, `~/dev-secrets`) stays usable anywhere. The person sees that list on each row before moving and can widen it or set it to "anywhere"; an explicit empty list means anywhere, an absent one keeps what a replaced secret already had, and `wp-secret migrate` / `migrate-env` take `--repo` and `--any-repo`.
- asked: 2026-10-12 (owner: "different projects might need different Gemini API keys")
- shipped: 5f1ff3cb

### R-vault-017 · shipped
When two different values would get the same secret id, the ids carry the project name instead of a counter (`ledger-app.gemini_api_key`, `billing.gemini_api_key`); a numeric suffix is the last resort.
- asked: 2026-10-12 (owner: "different projects might need different Gemini API keys")
- shipped: 5f1ff3cb

### R-vault-018 · shipped
A secret shared by several projects can be split from the phone: one project gets its own key (a new value typed on the phone), that repo's `.env` references are rewritten to the new id, and the old key stops releasing to that repo — after one confirm and one fingerprint, with every path named on the card. The old key is narrowed only when every line was rewritten, and never to an empty list (it is then left unchanged and the card says so); the old key's leases and grants end. The new key does not inherit the old key's purpose note. Phone only for now. A repo whose file still holds the old key's original in plain text is refused in words (remove the original first); the split never rewrites a plaintext line.
- asked: 2026-10-12 (owner: "different projects might need different Gemini API keys")
- shipped: 5f1ff3cb

### R-vault-019 · shipped
A "projects & credentials" screen shows which projects reference which vault credentials (from the desktop's own scan of `.env` references), which ones each credential is allowed for and when it was last used from there; every listed secret always carries its uses (an empty list means never used). Mismatches are flagged: a file names a secret this repo cannot get, a reference names no secret, or a credential is allowed here but never referenced or used.
- asked: 2026-10-12 (owner: "Allow me to see which projects use which credentials")
- shipped: 5f1ff3cb

### R-vault-020 · shipped
After a secret is moved in with its originals kept, the person can see which programs read those originals (a script that sources the `.env`, a dotenv loader, a compose `env_file`, a package script, a launchd / systemd / cron starter) and which of them start by themselves and so cannot wait for a fingerprint. The list is found by names and paths only and never holds a value; when nothing is found it says to check by hand, never "none".
- asked: 2026-10-12 (owner: after "remove original", my-service's `run.sh` would export the literal reference)
- shipped: 022320ee

### R-vault-021 · shipped
A reader can be rewired from the phone: the tap opens the Send sheet on one prompt, aimed at a new session in that reader's repo, and the person sends it (or not) — never through the backlog, and the row says "with a session" only once it was sent. The prompt asks it to start the program under `wp-secret exec`, commit only that file and report back. Nothing changes until that session commits; the prompt carries no secret value; the report is checked against git and a report from another repo is refused.
- asked: 2026-10-12 (owner); 2026-10-16 (owner: "not sent to the backlog but to a new session where the prompt is pre-populated and the user can hit send" — the backlog rows had run and gone, so nothing showed there)
- shipped: 022320ee

### R-vault-022 · shipped
A reader that starts by itself gets an explicit choice: keep plaintext (the default; "remove original" skips that line and says so on its card) or a long lease (an 8 h lease, asked once per restart on the phone; with no answer in 90 s the service does not start). The daemon's own key is one such reader.
- asked: 2026-10-12 (owner)
- shipped: 022320ee

### R-vault-023 · shipped
A rewire can be undone per reader or for the whole secret, by the same route (a prompt to that repo's session, then its report). "Move back" is refused, in words with the undo offered, while any rewire stands, so no program is left reading a vault copy that no longer exists. The "remove original" card names rewired readers first, then readers not yet rewired (and what they will receive instead of the key), then places kept in plaintext, and never refuses. From four places the card leads with the places that need work, says "no reader found" once, and keeps every place one tap away in the same order; a place that needs work is never folded.
- asked: 2026-10-12 (owner)
- shipped: 022320ee

### R-vault-024 · shipped
A stored secret's repos ("where it may be released") can be changed from the phone, on the secret's card: one fingerprint card says before → after, is loud when the change lets a repo get it that could not before, and names the leases and grants made from repos no longer allowed, which end. An empty list means any repo. A history row records it.
- asked: 2026-10-12 (owner: could not find the per-project features on the secret card)
- shipped: 5b78defa

### R-vault-025 · shipped
A secret whose original still sits in a project's file counts as used by that project (the file's git root), in "projects & credentials" and on the secret card ("used by …", "still holds the original" vs "references it"), with or without a scan. The secret card opens "projects & credentials" cut to it and offers "give <repo> its own key" per project when two or more use it, or says why not.
- asked: 2026-10-12 (owner: "see which projects use which credentials")
- shipped: 5b78defa

### R-vault-026 · shipped
A program can ask the vault for a secret at the point of use through a one-file client (Python, Node) that keeps the value in process memory only; the phone card names the requester and its stated purpose; a denial, silence or a missing daemon is a typed error the program turns into a feature-level message, never a failed boot.
- asked: 2026-10-12 (owner: ask at the point of use, per-reader advice)
- shipped: c2171799 f430779c 2723cb65 887e6d05 2b6b079d

### R-vault-027 · shipped
A reader can be rewired to "fetch on use" from the phone like the other rewires (the Send sheet on one prompt, trailer, receipt verified against git including the vendored client file, undo by revert); move back refuses while it stands.
- asked: 2026-10-12 (owner: ask at the point of use, per-reader advice)
- shipped: c2171799 f430779c 2723cb65 887e6d05 2b6b079d

### R-vault-028 · shipped
Per reader the phone recommends ONE treatment with a one-sentence, value-free reason derived from how the code uses the key; without a recommendation nothing is guessed; a recommendation from before the code changed says so; the owner taps, nothing applies itself.
- asked: 2026-10-12 (owner: ask at the point of use, per-reader advice)
- shipped: c2171799 f430779c 2723cb65 887e6d05 2b6b079d

### R-vault-029 · shipped
Every treatment (ask at start, ask on use, 8 h lease, keep plaintext, allow in advance) is one tap away on the reader and says in one line what it means for the owner, in plain words; "allow in advance" is the existing grant, made from the reader, with its scope, cap and end on the card.
- asked: 2026-10-12 (owner: ask at the point of use, per-reader advice)
- shipped: c2171799 f430779c 2723cb65 887e6d05 2b6b079d

### R-vault-030 · shipped
A fetch nobody answers tells the program after 90 s that its card stays (R-vault-080); a card nobody answers is counted as denied (an ask a person started, R-vault-058, waits longer); "not now" on the card holds that request for a chosen time without further cards or notifications; repeated silence backs off; holds and backoffs are visible, liftable and in the decision log; simultaneous requests for one secret from one program make one card.
- asked: 2026-10-12 (owner: ask at the point of use, per-reader advice)
- shipped: c2171799 f430779c 2723cb65 887e6d05 2b6b079d

### R-vault-031 · shipped
A reference that names no secret in the vault can be pointed, from its flag on "projects & credentials", at a secret that is (ranked suggestion with the reason, e.g. a label naming the same env key), or the person is taken to store a key under that id; the line changes only after one fingerprint card naming the exact file, line and both ids, and only if the line still reads what the card showed.
- asked: 2026-10-12 (owner: "assign keys to projects that don't have one yet, e.g. the first service's Gemini key also to the tutor app")
- shipped: 8eff44eb 8150e74f e7aa1fb1 23c0f64f e83c3881

### R-vault-032 · shipped
From a secret's card, "use in another project" adds `KEY=wp-secret://<id>` to a `.env` file of a repo the desktop knows (key defaulted from the label, file default `.env`), after one card; when the secret's repos list excludes that repo the same card widens it and is loud about it; a key already holding a value or another reference is refused in words (migrate, or repoint); only `.env`-family files inside the repo, never a link, never `.envrc` or an example file; a tracked or un-ignored target is written but said.
- asked: 2026-10-12 (owner: same)
- shipped: 8eff44eb 8150e74f e7aa1fb1 23c0f64f e83c3881

### R-vault-033 · shipped
After a reference exists, the phone says in words whether a program in that project resolves it (calls `wp-secret`, carries the client, parses the reference, or starts under `wp-secret exec`), or only loads the file as text (then the no-code route `wp-secret exec --env-file` is named), or that nothing was found — never a false "it works"; the words say what was found, never that it works.
- asked: 2026-10-12 (owner: same)
- shipped: 8eff44eb 8150e74f e7aa1fb1 e83c3881

### R-vault-034 · shipped
An added or repointed reference has a one-tap undo while the line still reads what the desktop wrote (and the widening is narrowed back when the list is still as written); every card, refusal and undo is a decision/history row; `wp-secret use`, `repoint`, `use-undo` do the same from the desktop (`use` names the repo by path; core resolves it by realpath against the repos it lists, and a path it does not list is refused in words); pinned by `e2e/e2e-vault.mjs` 13b.
- asked: 2026-10-12 (owner: same)
- shipped: 8eff44eb e7aa1fb1 23c0f64f e83c3881

### R-vault-035 · shipped
A person who tried the vault out can put the desktop back as it was from the phone's keys & backup screen ("start over"): first a value-free list of what goes back where (every secret to the places it came from, every line the vault added put back), then ONE fingerprint card naming all of it; after it every secret is moved back (all or nothing across secrets — one place failing leaves every file and the vault as they were). **No stored secret is lost on the way:** after every write, every place of every secret is read again and compared with the vault's own value (one miss undoes every write and the vault stays whole); vault.json is then moved aside still encrypted, never deleted, and the phone keeps its key so that copy still opens; the phone asks for a current backup first (or an explicit "go on without a backup" tick); a secret with no known origin is deleted only when ticked AND the last backup holds it as it is now, and is named on the card. A standing rewire or a line edited since is a block in words and nothing is asked. An empty vault keeps the plain reset.
- asked: 2026-10-13 (owner: "a reset to before button … reset the whole vault finding and migration to how it was before"; then "this must guarantee that none of the stored secrets is accidentally lost on the way")
- shipped: db60343e

### R-vault-036 · shipped
An agent can create and keep a catalog of accounts: one record per account (service, role, username, password, url, notes, tags), the password sealed and the catalog readable on the phone without a tap. `wp-secret account ls` answers which logins exist by id and kind, like `ls` (owner decision 2026-11-05 (a)); which is admin, which is dead and when each was last used is `account ls --full --why TEXT`, one fingerprint card naming who asked and why (R-vault-098). The phone's account rows say when each was last used — "never" only when the use ledger is complete for that account's life, nothing when it cannot vouch.
- asked: 2026-10-14 (owner decisions, accounts plan); 2026-10-15 (last use on ls); 2026-11-05 (`account ls` narrows to ids and kinds)
- shipped: f5e0ae11 e15feefd b9eb457d 928c4de3 988da262

### R-vault-037 · shipped
An agent creates an account with one fingerprint (password from stdin or a no-echo prompt, never a flag), edits its catalog (note, tags, role, retire, revive) with none but journaled with who and what, and a note an agent adds never replaces one a person wrote; owner and exposure change only through the fingerprinted policy ask. Adding an account never replaces one: the add is create-only, refused in words by the desktop if the id exists at the card or at the commit. A username the credential scrub refuses stays refused, and the refusal names the way to keep it sealed.
- asked: 2026-10-14 (owner decisions, accounts plan); 2026-10-15 (create-only put, strict scrub)
- shipped: f5e0ae11 e15feefd b9eb457d 928c4de3 71b33c3c c8dcd3d7

### R-vault-038 · shipped
An agent uses an account only through a program: `exec --as ID` hands the program the username, password and url, never the agent's context; `get` of a program-only login is refused in words; a login marked as the owner's own is never auto-included in a repo window.
- asked: 2026-10-14 (owner decisions, accounts plan)
- shipped: f5e0ae11 e15feefd b9eb457d 928c4de3

### R-vault-039 · shipped
The owner exports every login as a real login item to KeePass (KDBX, with the otp field) or Bitwarden (type 1), reads the account catalog on the phone, and shows any login there after one fingerprint (program-only included: exposure guards only the agent's context) with copy in the app, wiped after a minute.
- asked: 2026-10-14 (owner decisions, accounts plan); 2026-10-15 (show releases any login)
- shipped: f5e0ae11 e15feefd b9eb457d 928c4de3 53350038 31285a6f b0959256 6c9e8005
- note: show + copy is untested on a device (the APK's clipboard read-back and clear above all).

### R-vault-040 · shipped
A "step by step" screen lists every secret a migration concerns — each stored secret with an origin, and each row of the last scan not yet in the vault — under to do, waiting for a session, done and set aside, each with the step it is at in one line. Opening one shows its five steps (move it in, find who reads it, decide each program, try the vault copy, remove the plain-text original) with the button for the current one; the step is derived from what the desktop reports, so leaving at any step and coming back resumes there. Programs are decided before the original is removed, and an original already removed while a program still reads it is listed first and says so. "Set aside" moves a secret to its own list (kept on the desktop, ids only, a history row each time), from which "bring back" returns it; a set-aside secret is not the home's next step.
- asked: 2026-10-16 (owner: "a per secret stepped setup wizard … resume per secret and see it easily at a glance where every secret stands and if it is in scope for such a migration or by user set to the other list from which it can also be removed again")
- shipped: 343f8254
- note: R-vault-101 makes it six steps (the sixth, "finish the removal", comes after removing the original).

### R-vault-041 · shipped
Adding a secret is one tap from the vault home, in every state where a put is possible (the desktop connected, the vault made, no enrol running), on the phone and in a laptop's browser; when it is not possible the home says why in words.
- asked: 2026-10-17 (owner: "that MUST be super easy for the user!!!")
- shipped: adac8cc4

### R-vault-042 · shipped
For the known kinds (npm token, GitHub token, environment variable, file) the add-a-secret screen fills the id, kind and label, so the person types a name and a value. An npm token also offers the `~/.npmrc` `${NPM_TOKEN}` line on the SAME fingerprint card, which names every file change; a line already holding another literal token is refused in words.
- asked: 2026-10-17 (owner: "that MUST be super easy for the user!!!")
- shipped: adac8cc4 f26ac238

### R-vault-043 · shipped
A value typed in another client's browser (a laptop's, or the desktop's own) travels to the desktop over the one WebSocket, waits in memory only until the phone approves, and is dropped on deny, timeout or restart. The phone's card names the paired device it came from (or a browser that is not a paired device) and its route; the desktop's own browser behind `tailscale serve` reads as Tailscale, loopback only at plain http://127.0.0.1. A device that is not the phone can at most propose a put: it cannot read or release anything.
- asked: 2026-10-17 (owner: "that MUST be super easy for the user!!!")
- shipped: a5a6d749 f26ac238 adac8cc4

### R-vault-044 · shipped
A project has one repo view in the vault, reached from the project's own "⋯" menu, from a "vault" count chip on its row (the count = what needs a person there, and the tap opens exactly those) and from the vault home's projects list: its links, its secrets by phase, its logins, and what is missing. Reading it needs no fingerprint of its own, only the phone's list being unlocked (R-vault-097); every reveal or use is the one existing fingerprint card.
- asked: 2026-10-17 (owner: "some kind of consolidated repo view.. where I have the link to the deployed thing, secrets relevant for dev, in prod at runtime, for deployment... And the accounts")
- plan: docs/analysis/vault/REPO-VIEW-PLAN.md §3
- shipped: 42d3d866 a1e321ba

### R-vault-045 · shipped
The repo view lists where the project is served and deployed, each link with where it was read from (`tailscale serve` matched to a port the repo declares, a URL named in the repo's own config or docs with file:line, or a link a person or agent typed), and an "open" on each; a link that was never probed says "not checked", never a status it does not know.
- asked: 2026-10-17 (owner: "the link to the deployed thing")
- plan: REPO-VIEW-PLAN.md §3.3
- shipped: 817d3ed8 42d3d866

### R-vault-046 · shipped
Each of a project's secrets sits under dev, runtime or deploy — stored when a person or agent set it, guessed from where it is referenced and its name when not, and "not sorted yet" when the guess would be a coin toss (never a wrong phase); the chips are filters over one list. Keys the project names that the vault lacks are listed as missing with a one-tap add; public-by-design names are counted apart, not listed as missing.
- asked: 2026-10-17 (owner: "secrets relevant for dev, in prod at runtime, for deployment")
- plan: REPO-VIEW-PLAN.md §3.4
- shipped: de1c70bb 817d3ed8 42d3d866

### R-vault-047 · shipped
"Find logins" in a project proposes login candidates from seed scripts, fixtures, `.env*`, compose files, README and docs — role, username, email and the file:line of each, never a password, length or digest — and the ticked ones are stored with ONE fingerprint, create-only, bound to that project, the desktop reading each password from its file itself so no model, transcript, push or plan output ever carries it. The same from the CLI (`wp-secret find-logins --store`). Originals are not removed; the follow-up (let the seed read it from the vault) is offered as a sentence a person hands to the project's agent.
- asked: 2026-10-17 (owner: "a button that helps to find and store … user login credentials … for this locally hosted page")
- plan: REPO-VIEW-PLAN.md §4
- shipped: 3802cdd0 817d3ed8 5adaecd8 5649140a

### R-vault-048 · shipped
A login has an email beside its username, end to end: the record (unsealed by default, sealable like the username), `account add --email`, `exec --as` handing the program `ID_EMAIL` (and `ID_USERNAME` falling back to the email when no username exists), the phone's form, list and shown login, and both export formats.
- asked: 2026-10-17 (owner: "accounts with usernames and passwords and email")
- plan: REPO-VIEW-PLAN.md §3.7
- shipped: de1c70bb e97d3aa4 a1e321ba

### R-vault-049 · shipped
The accounts row is on the vault home in every state (not enrolled: it says "pair the phone first" and opens keys & backup); "+ login" is reachable from the accounts screen whenever a put is possible; the home and `wp-secret status` say whether agents have the vault rule (`~/.claude/skills/wp-secret`) and install it from the phone with one tap and no fingerprint, never over a file wp-secret did not write; a project's setup checklist carries the same row.
- asked: 2026-10-17 (owner: "I don't see such a button yet and have no idea how to use it")
- plan: REPO-VIEW-PLAN.md §5
- shipped: 817d3ed8 e97d3aa4 a1e321ba

### R-vault-050 · shipped
Using a login on demand without autofill: on the phone, show (one fingerprint) gives email, username, password and "open <the project's link>" so copy → open → paste is the whole path, and the repo view names `wp-secret exec --as <this id>` per login for a terminal; no second fingerprint is asked on the same tap, and a login is never leased or windowed by the show.
- asked: 2026-10-17 (owner: "on demand switch [and with a] fingerprint show user login credentials"; "probably with an additional fingerprint to see or use a secret")
- plan: REPO-VIEW-PLAN.md §3.5–3.6
- shipped: e97d3aa4 42d3d866

### R-vault-051 · shipped
The vault's screens share one row grammar and the app's theme tokens: a fact is said once per screen, no pill per row, chips are tinted filters, one solid verb per screen or card, cards say what/to whom/until when with the rest folded, the fingerprint button is labelled with its verb, a card that was answered becomes its receipt in place, empties are one sentence with one verb, mono only for ids, keys, paths and commands, icons mapped once. While a card waits, the home has no headline of its own: the request sits under "waiting for you", and the kept line stands apart from it. - plan: REPO-VIEW-PLAN.md §10
- asked: 2026-10-17 (owner: "if you have good ideas on How to make the vault UI more intuitive and sexy. Do it!")
- asked: 2026-11-03 (owner: "wrong /confusing wording. The release request is in the section below")
- shipped: 2fb07096, 08842d9d, 55291043, 6a2a7447, 6bde8c54

### R-vault-052 · shipped
A standing grant: "until I revoke" is the last entry of every release card's picker (never the default), also reachable from the CLI and the project window. It has no end until revoked from the phone or CLI; only its scope (never a value) is kept on disk, so after a desktop restart it is dormant and ONE re-arm card re-arms every dormant grant with one fingerprint. Every scope is visible and removable on that card before the fingerprint; a declined re-arm goes quiet (15 min) and the next request asks with an ordinary card; "lock now" ends standing grants for good. A secret that reaches the whole account or more is never held this way (R-vault-099).
- asked: 2026-10-18 (owner: the ledger-app service rang the phone 22 times in one morning)
- plan: STANDING-GRANT-PLAN.md
- shipped: 4d60c3f3 8b1eb9d9 a5d8ae71 6e69beb2 d3bd292a 6064f010

### R-vault-053 · shipped
One fingerprint for a whole project: a standing repo window over every secret the project uses (known readers, `wp-secret://` refs in its `.env` files, `allowRepos`), re-widened at each re-arm; a program not listed asks once and offers to join. A fetch release card with no known readers offers a one-program window. A secret that reaches the whole account or more is not put into a window by the rules (R-vault-099).
- asked: 2026-10-18 (owner decision 7)
- plan: STANDING-GRANT-PLAN.md §3.4
- shipped: a5d8ae71 d3bd292a 6064f010

### R-vault-054 · shipped
Boot unlock without the phone: per secret, opt-in, off by default, macOS only. A desktop-held copy of that secret alone, sealed under a key in the Keychain readable only by the vault's helper, lets a standing grant whose secrets are enabled re-arms (in part, per secret, R-vault-055) at boot with no card; the vault key is never on the desktop; the card states what is given up; a rebuilt helper never raises a dialog (boot unlock is off until switched on again). Boot unlock is refused, in words, for a secret that reaches the whole account or more (R-vault-099).
- asked: 2026-10-18 (owner decision 6)
- plan: STANDING-GRANT-PLAN.md §5
- shipped: 8b1eb9d9 3a741821 d3bd292a 6064f010

### R-vault-055 · shipped
A standing grant is armed per secret: at boot the boot-unlocked secrets of a dormant scope re-arm without the phone, the rest wait for the card, which lists only the waiting ones and says how many are already armed ("3 of 10 armed at boot"); one row, one fate — revoking any part ends the whole standing grant.
- asked: 2026-10-18 (owner: the ledger-app morning, follow-ups lesson 1)
- plan: FOLLOWUPS-PLAN.md §1
- shipped: 695184f7 cb01edb3 9ad5cc3f fbc2a492

### R-vault-056 · shipped
`npm run restart` does not drop armed standing grants: they cross it in memory through a short-lived, detached courier process (never a file, never the Keychain, never argv or the environment), taken by the new host once, ≤ 120 s, judged per secret against `standing.json`, and armed with no card and one decision row. A reboot, a crash, a missed window or `WP_VAULT_NO_HANDOFF=1` forgets them and the re-arm card asks; a refusal is said in words. Bounded grants and fetch leases are not handed over.
- asked: 2026-10-18 (owner: the ledger-app morning, follow-ups lesson 2)
- plan: FOLLOWUPS-PLAN.md §2
- shipped: 695184f7 cb01edb3

### R-vault-057 · shipped
A program started with `python -m X` is the program `X` (`uvicorn`, `backend`), not `__main__.py`: the vendored Python client (v2) reports the real module and the host names a `__main__.py` by its package directory. A stored `__main__.py` window entry is rewritten to its one reader's module name or dropped, said in words on the next card.
- asked: 2026-10-18 (owner: the ledger-app morning, follow-ups lesson 3)
- plan: FOLLOWUPS-PLAN.md §3
- shipped: 2ae10fea 695184f7 cb01edb3

### R-vault-058 · shipped
An ask a person started (`wp-secret grant`, boot unlock, re-arm, a login shown on the phone, and since 2026-10-25 every change typed at the desktop: store, remove, export, policy, assign, purge, restore, reset, practice) waits until answered or cancelled (24 h cap), not 90 s; its card says "waiting for you · since 10:12" with no countdown and how it ends; Ctrl-C in the CLI withdraws it as "cancelled from the desktop" and exits 130, and the CLI prints the host's "still waiting" lines. A program's ask keeps 90 s for the program (R-vault-080) and the backoff ladder.
- asked: 2026-10-18 (owner: the ledger-app morning, follow-ups lesson 4)
- plan: FOLLOWUPS-PLAN.md §4
- shipped: eab7d1d3 db8b2e05 cb01edb3 fbc2a492

### R-vault-059 · shipped
Once per host start, if a standing grant is still dormant after the hand-over and boot unlock, the host raises ONE re-arm card (a person wait, one notification) that says why it came (reboot, hand-over missed, partly armed); `wp-secret rearm` does it on request, joins a card already on the phone, and says "nothing is dormant" when there is none. Declined goes quiet as before.
- asked: 2026-10-18 (owner: the ledger-app morning, follow-ups lesson 5)
- plan: FOLLOWUPS-PLAN.md §5
- shipped: db8b2e05 cb01edb3 fbc2a492

### R-vault-060 · shipped
When the same secrets, project and program have asked three or more times in 24 h and the card offers "until I revoke", the card says so in one line with a verb that only picks that entry; nothing is ticked or approved by it. Known gap: the repo view's "asked N× today" line has no host field yet.
- asked: 2026-10-18 (owner: the ledger-app morning, follow-ups lesson 6)
- plan: FOLLOWUPS-PLAN.md §6
- shipped: cb01edb3 9ad5cc3f fbc2a492

### R-vault-061 · shipped
One Android notification per scope: a plugin's `notify({tag})` replaces an earlier notification with the same tag (namespaced per plugin); the vault tags release asks by secret set, project and program, so 22 asks from one program are one notification. A settled card does not clear its notification yet.
- asked: 2026-10-18 (owner: 22 notifications in one morning)
- plan: FOLLOWUPS-PLAN.md §7
- shipped: eab7d1d3 4c7dc432 cb01edb3

### R-vault-062 · shipped
Demo mode shows the vault: a fixture of value-free cards (release with advice, grant, re-arm incl. a partly armed scope, boot unlock) and standing rows, whose verbs say "demo: nothing is released here" instead of pretending to work.
- asked: 2026-10-18 (owner: follow-ups lesson 8)
- plan: FOLLOWUPS-PLAN.md §8
- shipped: eab7d1d3 c5f90c0f 9f5988f6
### R-vault-063 · requested
All items nested beneath a repo in the vault plugin can be collapsed and expanded, as in the main view.
- asked: 2026-10-15

### R-vault-064 · requested
When an app needs a vault secret whose original was already removed, the phone prompts the user to release the key instead of the app failing silently.
- asked: 2026-10-16

### R-vault-065 · shipped
Each secret in the vault's list shows its migration step and its last use, and tapping the status line opens its steps.
- asked: 2026-10-16
- shipped: 084d2c55, 805a35f6

### R-vault-066 · requested
Vault approval can use Windows Hello, Touch ID, Face ID, WebAuthn security keys or a native Mac app as approvers, beside the Android Keystore, never syncing keys between devices, working over localhost and plain LAN without Tailscale, and for any user's setup.
- asked: 2026-10-17, 2026-10-24, 2026-10-24

### R-vault-067 · shipped
The vault can hold an old developer key protected by an additional password, usable to publish and release artifacts.
- asked: 2026-10-17
- shipped: 3fc7cb4d

### R-vault-068 · shipped
The secrets scanner detects names ending in SALT (e.g. IP_HASH_SALT) as secrets, but not SALT_ROUNDS.
- asked: 2026-10-17
- shipped: 0f5eb13b

### R-vault-069 · shipped
The secrets scanner ignores .example template files.
- asked: 2026-10-17
- shipped: 8548f74

### R-vault-070 · shipped
On the vault's find-and-move-in screen each secret row shows its id and one line per source, with the facts and what changes folded, so it reads at a glance.
- asked: 2026-10-17
- shipped: b5d577d3

### R-vault-071 · shipped
The fingerprint confirm popup never sits at '0 waiting' after a confirm; it shows only while at least one card waits.
- asked: 2026-10-17
- shipped: e4300056

### R-vault-072 · shipped
Grant and re-arm cards show why each secret is requested, per secret.
- asked: 2026-10-18
- shipped: c85d0bd3, 26211dff

### R-vault-073 · requested
On the vault's step-by-step board the person can move all remaining secrets forward in one action instead of handling each one.
- asked: 2026-10-19
- note: Today only a per-place 'rewire all n' exists.

### R-vault-074 · shipped
On a device that did not approve a vault export, the backup card says in words that the generated password is only on the approving device and where to copy it; the password is never shown on the desktop.
- asked: 2026-10-19
- shipped: 13eab6dd
- note: The desktop never holds the password by design.

### R-vault-075 · shipped
The exported KDBX file opens correctly in a KeePass-compatible password manager.
- asked: 2026-10-19
- shipped: 80b5f0d3, e8ed1139, 27d23e69
- note: keepassxc-cli 2.8.0 opens a fixture file at the default KDF and shows a login's fields, its otp field and a correct TOTP code (test/export-kdbx-keepassxc.test.mjs). A real export has not been opened, and nobody has opened one in the KeePassXC window.


### R-vault-076 · shipped
A password asked on a shell's screen can be filled from a stored login: the masked field offers "from vault" (and, once a login filled that prompt on this desktop, "fill with <that login>" in one tap), only logins are offered, the logins the prompt names come first, one fingerprint card says what is filled and for which login, and the password lands only in the masked field — typed when the person taps Send, dropped if the prompt has gone. The masked value is never stored as a draft, in history or in the outbox, and sending it offline is refused.
- asked: 2026-10-20, 2026-10-20
- shipped: 97e0ee27, 094ee9dd

### R-vault-077 · shipped
On the live desktop, the protected typing box can be filled from a stored vault login (one fingerprint), and the password is never kept as a draft.
- asked: 2026-10-20, 2026-10-20
- shipped: f006c44b

### R-vault-078 · shipped
The vault refuses to release a secret when the grant has expired, the repo or purpose does not match, the vault is locked, or the standing grant was revoked, and tests cover each refusal.
- asked: 2026-10-21
- shipped: 30ff6133

### R-vault-079 · requested
gcloud CLI credentials are stored in the vault, and no unvaulted copy remains on the machine.
- asked: 2026-10-22

### R-vault-080 · shipped
A program's release card (`exec`/`fetch`) outlives the program's 90 s wait: the program hears that the card stays and to run again after approving; the card stays on the phone 90 min, a rerun meanwhile joins it with no new card or notification, and an approval after the program stopped waiting is kept 15 min for its next run (then its own lease time, or none for a secret released once).
- asked: 2026-10-25 (owner: "many secret approvals only wait 90 seconds … I don't look at the phone sometimes")
- shipped: de7b2650

### R-vault-081 · shipped
`npm run restart` does not drop live bounded grants and leases (late approvals waiting for their run included): they cross in the same memory-only courier as standing grants, each with its end and spent uses, and are restored only when a value-free check file written by the old process (HMAC under a key that exists only in the courier) vouches for them; anything else is refused in words in one decision row; a reboot or crash still drops them
- asked: 2026-10-26 (owner: "go ahead with item 1, design the check first")
- plan: docs/analysis/vault/FOLLOWUPS-PLAN.md §2.4
- shipped: bd3619f6 fc5f651c
### R-vault-082 · requested
Exposure watch reads Play vitals through a narrow Play service account key kept in the vault, usable only by the collector and not unlocked at boot; when its standing grant is dormant the row shows as absent with re-arm instructions instead of waiting. Every secret the watch uses is accessed through the vault.
- asked: 2026-10-26


### R-vault-083 · shipped
An approval card says which coding session on this desktop asked (its tab, repo and the person's own last prompt, matched by the desktop rather than reported), the agent's reason, and how often this scope was approved before; a request from a matched session that gives no reason is refused before any card, in words that tell the agent how to give one.
- asked: 2026-10-28 (owner decision 2026-10-29, vault-card-transparency P1–P3)
- shipped: b1639096 20b5938c 44b76f47

### R-vault-084 · shipped
An approval made from a matched coding session holds for that command in that session across its folders and worktrees until the session ends or the chosen time; a linked worktree counts as its main repo for grants and offers only when git's own back-link confirms it, and a temporary folder or worktree is never offered "until I revoke", with the reason on the card.
- asked: 2026-10-29 (owner decision, vault-card-transparency P5)
- shipped: 6fb0e9df 33e50899 44b76f47

### R-vault-085 · shipped
A program that is not a coding session (a launchd job, a cron line, a server, a script) can be registered with what it does, when it runs, its command, its folder, the secrets it takes and why; registering and removing from the command line each take one fingerprint on the phone, a tap on the phone removes one, and a registration allows nothing by itself.
- asked: 2026-10-29 (owner decision "build all", vault-card-transparency P8)
- plan: docs/analysis/vault/CONSUMERS-PLAN.md
- shipped: 07b52bcc

### R-vault-086 · shipped
A release card no coding session asked for names the registered program it matches (by command and folder, worktrees included) with its stated reason, or says loudly that the program is unregistered; an unregistered program is never offered "until I revoke", and the card says how to register it.
- asked: 2026-10-29 (vault-card-transparency P8)
- plan: docs/analysis/vault/CONSUMERS-PLAN.md
- shipped: 07b52bcc

### R-vault-087 · shipped
A card no coding session asked for shows what the desktop itself knows about the request: what launched it (launchd with its reported label, cron, a terminal shell, a tmux pane, another program), that it came minutes after the computer or the waterplane host restarted, that it is outside the scope's usual hour, and how many days since it last asked; each fact is left out when it cannot be told.
- asked: 2026-10-29 (vault-card-transparency P8)
- plan: docs/analysis/vault/CONSUMERS-PLAN.md
- shipped: 07b52bcc

### R-vault-088 · shipped
A repeated ask for the same secrets and command from the same matched coding session, made from another folder or worktree while its card is still open, waits on that card instead of raising a second one.
- asked: 2026-10-28 (vault-card-transparency P5, review 1 L2)
- shipped: 07b52bcc

### R-vault-089 · shipped
The vault has one "who uses my secrets" screen listing every coding session holding values, every registered program, every standing and timed grant, and every unregistered program that asked in the last 14 days, grouped by kind; each row says who, the reason given, which secrets, the last recorded use and how many times it asked this week, and carries its own revoke or remove (confirmed once); an unregistered program says in words why it has nothing to revoke.
- asked: 2026-10-29 ("better and more ui … a review of all current users", vault-card-transparency P9)
- plan: docs/analysis/vault/CONSUMERS-PLAN.md
- shipped: 7a89c2a0

### R-vault-090 · shipped
That screen marks, as offers it never acts on, a user unused for 14 days (said only when the desktop's use record reaches back that far), a registered program whose reason is older than 30 days ("confirm or remove"), and a user with no reason; each mark is a filter chip above the list whose count is exactly the rows it shows, with "n of N" and a clear. A program's "confirm reason" is one tap that records the confirmation.
- asked: 2026-10-29 (vault-card-transparency P9)
- plan: docs/analysis/vault/CONSUMERS-PLAN.md
- shipped: 7a89c2a0

### R-vault-091 · shipped
The screen is reached from the vault home ("who uses my secrets" with its count) and from every release card's fold ("see everyone using this secret"), which opens it cut to that secret.
- asked: 2026-10-29 (vault-card-transparency P9)
- shipped: 7a89c2a0
### R-vault-092 · shipped
The vault approval key also appears inside the session that needs approval, not only in the main view.
- asked: 2026-10-30
- shipped: 0fd3168e

### R-vault-093 · requested
Secrets are stored only in the vault and do not appear in other places in the vault plugin.
- asked: 2026-11-02


### R-vault-094 · shipped
Each vault's key on a phone is its own: one phone can hold the keys of several desktops' vaults, and a second desktop's vault never replaces or deletes another vault's key. Keys of vaults made before this keep working with no re-enrol and are never deleted automatically.
- asked: 2026-11-03
- shipped: d974977a

### R-vault-095 · shipped
A vault approval does not need Tailscale: it works on the desktop itself (localhost) and from a phone on the same Wi-Fi. On the Wi-Fi the app allows the fingerprint only over a route that proves it reaches the paired desktop (the pinned encrypted link, R-connection-032); over plain Wi-Fi it refuses in words (R-security-021). The optional browser route (the desktop's own certificate from a local CA) is still a separate, unfinished step.
- asked: 2026-10-24 (owner: the vault must work without Tailscale, on localhost and LAN)
- shipped: ce1e392c, 1da2c03a, db775c2b
- note: MULTI-DEVICE-PLAN.md WP4 says what is done and what stays optional. Not tried on a phone.

### R-vault-096 · shipped
`wp-secret ls`, the one door an agent on the desktop can ask without a tap, answers ids and kinds only: no label, note, repo path, purpose, lease policy, assigns, original or reach. The phone's list is unchanged and still has all of them. A command that needs one more fact asks for it by name: `account ls` the logins by id and kind (the columns are `account ls --full`, R-vault-098), `readers`, `advise`, `rm` and `purge-original` the kept original of the one id named, and `use-undo ASSIGN_ID` lets the desktop find the secret. R-vault-036 follows: `account ls` is narrow too (owner decision 2026-11-05 (a)). `repo show` is narrow too: a repo's logins by id and the `exec --as` line, no catalog column (service, role, username, email, owner, state, tags are `repo show --full --why TEXT`, R-vault-098).
- asked: 2026-11-04 (owner decision 1 of the exposure challenge: narrow the socket `ls`; "ids and kinds only" 2026-11-05)
- shipped: 23c6d1d4
- note: `host/sockview.mts` is the one place the views are cut (`ls`, `accounts`, `origin`, and `repoView`, which takes any directory the caller names and so would hand every referenced secret's label back: no secret label, window labels or why, a login by id only, its columns being `fullRepoViewFor` behind a fingerprint); the `origin` read is per id, so a sweep over ids can still read the original of a secret that has one.

### R-vault-097 · shipped
The vault's list is hidden on a phone until it is unlocked with a fingerprint, and the desktop enforces it, not the app: while a phone's window is closed, `vault.list` answers only the cards waiting, the enrol, the recovery key and the export file offer; the history, users, consumers, day ledgers, a project's repo view, a scan's rows and a migration's report are refused with one sentence; and the lease push carries no rows (a content-free tick, sent only while some window is open). The unlock is a fresh single-use nonce from the desktop, one fingerprint on the phone, and an HMAC under the host-binding key as the only thing sent back (the vault key is zeroed on the phone and never leaves it). The window is per paired device, stays open while the app is in front (a beat every 15 s), and closes a minute after the app goes to the background or after "lock"; a restart closes every window. Waiting cards, the enrol and the recovery key are never behind it, so a closed window never blocks an approval. The lock says what is hidden and what is not, never "safe"; a phone that cannot do a fingerprint says why in a sentence. It does not stop a program of the same user on the desktop (it holds the binding key, and `wp-secret ls` is its own rule, R-vault-096) and it is not a second lock on approving: that stays one fingerprint per card.
- asked: 2026-11-04 (exposure challenge F2); owner built it in full 2026-11-05 despite the replan's suggestion to cut it
- shipped: aff45d98
- note: `shared/wire/view.mts` is the contract and holds the one list of which method is gated, cut or open (`test/vaultviewgate.test.mjs` fails for a new method until it is placed). Phone seam: `web/viewprove.ts` takes any "unwrap under a fingerprint" function; Android passes the shell's existing `unwrap`, so no new APK, and iOS passes its own. Open question for the owner: should `wp-secret` on the desktop get more data (labels, history) after a phone fingerprint of its own? Not built; the window is keyed by device, so a command-line slot would be one more key, with the same proof. Gated too: the id-keyed edits and reads whose answer comes from the catalog (`vault.accountUpdate`, `setPurpose`, `rewireDraft`, `rewirePrompt`, `rewireMark`, `rewireSent`, `keepPlace`, `setAside`, `setPhase`, `repoLink`, `repoUnlink`, `consumerConfirm`). A caller with no device id is keyed by `kind`, so a loopback tab is not the tailnet phone's window; two same-kind callers with no id still share one. The phone locks itself `VIEW_WINDOW_MS` after the last answer that said open (`web/viewlogic.ts`), keeps a scan's and a migration's ids through a lock and re-reads them on unlock, and the head's list lock (`hide` glyph, "lock list") is a different verb and glyph from the kept rows' "lock now".
- note: not yet tried on a real phone.

### R-vault-098 · shipped
An agent that needs more than ids and kinds can ask for it once: `wp-secret ls --full --why TEXT`, `wp-secret account ls --full --why TEXT` and `wp-secret repo show [ROOT] --full --why TEXT` (the logins one named folder uses) raise one fingerprint card that names the asking session, the folder and the agent's own words, and says what the one command would print (labels, notes, policy, reach, assigns, the login columns, the folder it names for `repo show`; never a value). Without `--why` nothing is sent (the CLI and the socket both refuse it in words). On approval that one command prints the full read once. Nothing is kept: no lease, no window, no state, so the next `ls` is ids and kinds again; a denial or silence prints nothing and is exit 77. The approval is a history row ("catalog", drawn as an approval in History, naming the session, folder and why), and the card is a person's to answer, never an automatic one (`PERSON_PURPOSES`). It does not stop a program of the same user on the desktop from reading `vault.json`: it makes the agent's route to labels a visible, one-time ask.
- asked: 2026-11-05 (owner decision (b) on plan package 6b); 2026-11-06 (`repo show` is the same door: its logins are ids, the columns are `--full --why`)
- shipped: aff45d98
- note: the socket op is `catalog { scope: "ls" | "accounts", reason }` (`host/catalog.mts`; the cut per scope is `fullLs` / `fullAccounts` in `host/sockview.mts`, an allow-list). The card is purpose `catalog` (`AskCard.catalogFull`); words in `shared/circumstance.mts` (`catalogQuestion`, `catalogWords`, `catalogVerb`).
- note: not yet tried on a real phone.

### R-vault-099 · shipped
A secret that reaches the whole account or everything, said by a person's or a measurement's rating or by its kind (never by a model's estimate, never because nobody rated it), is released per use or by a grant of at most 24 h: its release card offers no "until I revoke" and says why, a standing grant for it is refused in words, boot unlock for it is refused in words, and the rules never put it into a project window. A standing scope that already holds one loses it at the next start (or at a re-arm, for a secret no armed grant holds), and the re-arm card names the drop before the fingerprint when one is raised; nothing already armed, nor its row, is cut until the next start. The secrets list has a filter chip for those whose value is dated over 90 days (the date is `vault.json`'s and unsealed, so it says "dated"), its number exactly its rows. A live standing window that holds one is not offered a new program ("add to the window"); a timed window is. On by default; `WP_VAULT_TOP_REACH=off` in the host's environment turns the refusals off.
- asked: 2026-11-04 (owner: exposure plan package 5; decision 4, default on)
- shipped: f98a3d44
- note: Unrated secrets are not blocked.
- note: not yet tried on a real phone.

### R-vault-100 · shipped
The vault's catalog file (`vault.json`, format 4) is sealed: the secrets' labels, notes, kinds, policies and ratings are no longer readable in it. A key held outside the vault's data folder (a 0600 key file, the Keychain, the Secret Service or DPAPI) opens it, and the recovery key can put that key back. A plain vault is sealed by the first approval that opens the vault key, never at start; the key is stored and read back before the file is replaced, and older copies beside the file that still hold a readable catalog are counted and the setup sheet says so. This stops a copy of `vault.json` alone from showing what the vault holds, who it is for and how far each key reaches. The six files beside it that held labels, repos and commands (`CATALOG_SIDE_FILES`: history, consumers, standing, found, uses, repos) are sealed under the same key: each is read and moved at the same first-approval step that holds the vault key (once per process, atomically, opened again and compared before the readable copy is replaced, also for a vault an older release already sealed), written sealed from then on, and a locked catalog leaves them untouched (their rows stay in memory, the log says so); `scripts/unseal-catalog.mjs` writes them plain again for a rollback. A copy of the whole data folder still shows the day ledgers, `aside.json` and `boot.json` (`CATALOG_PLAIN_FILES`): secret ids, days, counts and times, no label, repo, command or value. It does not stop a program running as the owner on this desktop: it can read the key from the same store the daemon does. Without the key the desktop answers every read with one sentence ("sealed and this desktop has no key", with the way back) instead of "no vault yet" or "no secrets stored", and refuses every write.
- asked: 2026-11-05 (owner: exposure plan package 7, the sealed catalog)
- shipped: 29a1a3b4
- note: `host/catalogseal.mts`, `host/catalogkeys.mts`, `host/catalogmove.mts` (the first-approval migration, vault.json and `sealSiblingsWith`), `host/sidefiles.mts` (the six files' one mechanism), `shared/format/catalog.mts` (the phone's reader); tests `test/vaultcatalog.test.mjs`, `test/vaultsidefiles.test.mjs`, `test/webcatalogsealed.test.mjs`. The file's vault id, the phone's key wrap, the recovery wraps and its size stay readable.
- note: not yet tried on a real phone.

### R-vault-101 · shipped
Removing a kept original is a hold, not an instant deletion. The originals leave their places exactly as before, but each removed place is held for 1, 3 or 7 days (picked at removal, default 1; the CLI takes 1..30), with a sealed copy in the vault wherever the recorded recipe cannot restore the file exactly. During the hold, "put back" (one card) writes every held place of the picked secrets out again and the vault copy stays, with its leases, grants and uses; "move back" is the different verb that deletes it. When the hold ends the desktop looks at each held place without reading any value (as the vault left it, a file back, uses since) and sends one reminder with those value-free facts. "Finish" (one card) runs, after the fingerprint, a value scan of the places, shell history, git and snapshots; a place that still holds the value stays held and says so, the others lose their sealed copies and count as removed. Nothing finishes by itself. The phone says "hold n originals away — one card", shows an "n held" chip that filters the list, and the step by step screen has a sixth step. A hold is not secure erasure (APFS and Time Machine snapshots may keep the bytes), a scan cannot see a program that failed quietly, and a one-day hold will not catch a weekly job. `wp-secret migrate` without keep-original and `wp-secret migrate-env` hold too: two fingerprints, one to store, one to hold away, through the desktop (a denied second card removes nothing and everything stays stored with its original kept). The phone migration's remove-now holds too, with its sealed copies saved before any file changes, on its one fingerprint.
- asked: 2026-11-06 (owner: "move all secrets to a temporary location before wiping them … another scan and maybe a day or so until a reminder fires to finally remove them")
- shipped: 5e032830, 596289ae, a9b7b41a, 505fe62f
- note: plan `docs/analysis/vault/HOLD-PLAN.md`; `host/slices/holding.mts`, `host/holdwatch.mts`, `shared/format/hold.mts`; phone `web/holdlogic.ts`.

### R-vault-102 · shipped
Every login carries "copy password" and "show password" on its own row, on the accounts screen and a project's page, each one fingerprint every time. Copy puts the password on the clipboard without drawing it, its card says the clipboard, and the app clears it after a minute, or on coming back after that when the app was behind another; when the phone refuses that write, the shown login opens instead with its copy button. Every list in the vault draws each row as its own card; a list inside a card keeps hairlines. An account card opens on a tap, and a list of one is open.
- asked: 2026-11-06 (owner: "a copy password button with required fingerprint and auto wipe after 1 min accessible on that screen already"; "hard to see if many items are listed, where which item starts or ends")
- shipped: 55afb6a3
- note: not yet tried on a real phone.

### R-vault-103 · shipped
Each group on "who uses my secrets" carries a closed explanation of what that group may do without a card and what ends it. A registered program's says the registration is a name, not a permission or proof; an unregistered program's says its row is a record of asks, that its cards never offer "until I revoke", and how to register it. A row never claims nothing is kept for a program, because a lease or timed grant can be.
- asked: 2026-11-06 (owner: "ui need to explain the categories better"; "what's the effective difference for me as user and for the security?")
- note: not yet tried on a real phone.
### R-vault-104 · shipped
The vault home shows a big beta notice linking the README's status and limitations section.
- asked: 2026-11-03
- shipped: a3dfd3b5
- note: not yet tried on a real phone.

### R-vault-105 · shipped
Each host keeps its own vault key and secrets are not shared between hosts, so differing secret sets never conflict.
- asked: 2026-11-03
- shipped: d974977a

### R-vault-106 · shipped
The vault wording says which release request is waiting for fingerprint approval; the home has no headline of its own while a card waits.
- asked: 2026-11-03
- shipped: 9019509e

### R-vault-107 · shipped
The approval card shows how far a secret reaches, so a broad admin login is clearly marked as far higher risk than a narrow key; ratings are presented as fallible, never as safe, and the vault home shows an exposure screen with day-by-day series, opened behind the fingerprint view gate.
- asked: 2026-11-04, 2026-11-05
- shipped: 7638140e, 23c6d1d4, 700ae53e, aff45d98

### R-vault-108 · shipped
A private downscoping helper mints narrower credentials from a broad login, for one secret or a list, and stays private to the owner.
- asked: 2026-11-04, 2026-11-05
- shipped: 8b47cee3

### R-vault-109 · requested
The vault's secret handling works on Windows, Linux and Android, and later on iPhone, not only the macOS Keychain.
- asked: 2026-11-04, 2026-11-05

### R-vault-110 · shipped
The vault's Try it action produces an approval card and runs as seeded.
- asked: 2026-11-06
- shipped: e3503db1, 12601f21

### R-vault-111 · shipped
Secrets not yet rated can be rated by AI from the scan through a Describe button that works a batch at a time.
- asked: 2026-11-06
- shipped: c5c2fec6

### R-vault-112 · shipped
A credential that unattended apps and agents rely on can live in the vault under a standing grant, so they keep working as today while the vault can revoke it; a secret that reaches a whole account stays under R-vault-099's 24-hour limit instead.
- asked: 2026-11-06, 2026-11-06
- shipped: 8b1eb9d9, f98a3d44

### R-vault-113 · shipped
Vault dialogs use the full available width on a desktop screen instead of a narrow column.
- asked: 2026-11-06
- shipped: 2527495d

### R-vault-114 · shipped
Vault access grants cover apps' API keys on the developer machine and on-demand secrets for agents, not only coding agents.
- asked: 2026-11-06
- shipped: 07b52bcc, c84caaa2


### R-vault-115 · built
An agent can ask for several vault changes at once (store values, allow a program, switch on boot unlock, revoke) as one card and one fingerprint, with the steps drawn on the phone; a sequence that stops says which steps ran, and `wp-secret sequence` takes a plan file with no values in it and the values on stdin.
- asked: 2026-11-06
- plan: docs/analysis/vault/SEQUENCE-CARD-PLAN.md (built and reviewed 2026-11-06)

### R-vault-116 · built
A value `wp-secret exec` released is replaced by `[secret]` in piped output, raw and in common encodings, so a run does not put a key into an agent's transcript by accident; a terminal run is unchanged.
- asked: 2026-11-06
- plan: docs/analysis/vault/BROKER-PLAN.md
- shipped: bec04d4f
- not yet tried on a real phone: the card line for a run with raw output

### R-vault-117 · built
A key stored as proxied is never handed to a program: the program gets a local URL and a throwaway token, the daemon adds the real key and forwards only to that provider's fixed host, and every other way out of the daemon refuses it in words, except a backup.
- asked: 2026-11-06
- plan: docs/analysis/vault/BROKER-PLAN.md (built and reviewed 2026-11-06 by AI agents only; one provider, Gemini; not yet tried on a real phone or against the real provider)

### R-vault-121 · built
A service that asks the vault when a feature runs can use a proxied key: a brokered fetch gets a local URL and a throwaway token, lives the same life as an exec (under a lease, a grant, once, and across a restart, which ends the token and keeps the lease), and a plain fetch of a proxied key is refused in words naming `proxied()`. The broker keeps itself bounded (dead runs swept every 60 s, 3 tokens per run, 64 overall, a full broker refusing before anything is committed). The one-file client is version 3 (`proxied()`, `callProxied()`; a plain key answers with the value so a program can change before the key flips), a proxied key can be stored from a laptop browser as from the phone, "Who uses my secrets" counts the calls that went through the broker per secret, and a recover ends a re-arm card made for the old phone's key. A rewired program that carries an older client, and the older vault.json copies still readable, are named in words, never removed.
- asked: 2026-11-07
- plan: docs/analysis/vault/SERVICE-BROKER-PLAN.md (built and reviewed 2026-11-07 by AI agents only; not yet tried on a real phone or against the real provider)
- shipped: ddc51404, 7fbf9c76, 7335063a, 82cab601, 352e2546, d96fdf27, 357a7d60, c4c15986

### R-vault-118 · shipped
A rewire reaches the code that really reads the key, not just the line that loads the file: the advice is read from real reads in that program before a sibling program's or an error message's mention of the name, a fetch names those files and may change them (an uncommitted one records them for its undo), a key needed at boot is reported as such rather than forced, and a "not done" row goes once nothing there reads the file any more.
- asked: 2026-11-06 (owner: a screenshot of two red rows, "the root cause behind red need to be addressed")

### R-vault-119 · shipped
A card that would keep a secret open with no end or for a reboot says when that secret is not rated, that it is therefore outside the safeguard that stops the widest secrets being kept open, and where to rate it. Words only: nothing is refused for being unrated.
- asked: 2026-11-06 (owner: close the gaps from the vault comparison)
- shipped: 8bac6859, 88b1f43a
- note: refusing until rated is an open owner decision. Not tried on a phone; the card journey fails at HEAD for other reasons, so the rendered cards are unchecked.

### R-vault-120 · shipped
Many secrets can be rated from their estimates with one fingerprint, from the not-rated list on the phone only. Wide estimates that end nothing start ticked; narrow ones and any row that would lose a standing grant or a boot unlock start unticked and say what ends. The card lists every row, a row that changed since the card is refused in words while the others are rated, and each rating records that it came from an estimate in a batch. No program or agent can start it.
- asked: 2026-11-07
- shipped: 5e15707c, 516ca2e7, 90fa3707

### R-vault-122 · shipped
The vault home has a search box that finds secrets, logins and projects as you type, by name, note, account details or allowed project, every typed word having to appear, never by value and never with a call to the desktop. A hit opens that one item, and Back lands on the same hits. A lock clears the box. Each secret's row in "reach over time" opens that secret too, except a secret no longer in the vault.
- asked: 2026-11-07

### R-vault-124 · shipped
Every secret's own card has "show value", "copy value" and "change value". Show and copy cost one fingerprint each and behave as a login's do: drawn for a minute or put on the clipboard and cleared after a minute. A value that is not text says so and points to a backup. A proxied key is never shown or copied, and its card says why; it can still be changed. "Change value" opens a form with the one value box, titled "change <name>", that keeps the secret's name, projects and how long it's kept. "Use it through the broker" appears only on a key whose name fits a host the broker knows, and opens the same form.
- asked: 2026-11-07 (owner: "I miss functionality to see, edit, copy the secret and I do find the marked button and the screen it opens extremely confusing")
- shipped: f4ed225a

### R-vault-123 · shipped
While a card is waiting, the locked vault's lock is one line ("list locked", an unlock button and a `?` that opens the sentences), so the card is at the top of the screen. With nothing waiting it is the full box. A warning or a reason the phone cannot unlock is still said in text under the line.
- asked: 2026-11-07
- shipped: f4728145
