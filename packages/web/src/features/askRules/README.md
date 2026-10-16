# askRules

The phone half of **ask rules** (docs/plans/agent-authority.md §2): a desktop-wide list of Claude
Code permission rules (`Bash(git push * main)`) that the host hands to every **claude** launch as
`permissions.ask`, so claude stops and draws its own box naming the exact command.

**Owns**

- Settings row `ask-rules` (Sessions → *ask before*, `AskRulesSettings.tsx`): every rule on its own
  row with its `remove` (a `ConfirmButton`) and, where it is switched off, one chip per repo — a tap
  on the chip asks in that repo again. A typed add is checked with `addRefusal` and refused in
  words. When the list lacks suggested rules, ONE control *add the suggested rules (n)* adds exactly
  the missing ones; the fold lists them first. Nothing is ever added without that tap.

**Reads** `GET/PUT /api/askrules` through `useAskRules()` in the top-level `AskRulesHere.tsx`,
which also draws the per-repo half inside Repo readings (`SetupSheet.tsx`): one on/off per rule for
that repo, written as `offIn` with `repo.worktreePath` (kept in that spelling; the host resolves
each entry by realpath at launch, since a linked worktree's path is not always resolved). Both halves live outside this
folder because a feature may not import another feature and `SetupSheet` is not one. Pure logic:
`askRules.ts` + `askRules.test.mjs`.

**Rules that apply**: a PUT sends the whole list with the `rev` + one-shot `confirm` of the reply
it was edited from, and adopts the fresh pair its reply carries; every save toasts `savedReceipt` —
a running session keeps the rules it launched with; a refusal (403 without a browser Origin or a
live confirm, 409 changed elsewhere, 400, 500, 503) is the host's sentence verbatim, and a 403/409
re-reads the list so the next tap is current. Other backends take no rule, and the row says so in its one line.
It stops the accident, not a wrapper script — said in the fold, never as a wall.
