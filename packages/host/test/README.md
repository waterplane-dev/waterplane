# Host unit tests

The pure decision cores of the daemon, run against `packages/host/dist` with
`node --test`. No PTY, no daemon, no tmux.

Everything under test here is described in `CLAUDE.md` as a **regex heuristic
over TUI output** — "fragile to upstream changes, pinned by e2e". The e2e
scripts do pin them, but they pin them through a whole booted host and a stub
binary, so the failure they report is "the session never published a prompt"
rather than "this line no longer matches". When the upstream CLI changes its
wording, the second sentence is the one worth having.

So these are fixture tests: a screen goes in, a verdict comes out. A captured
screen that stops parsing shows up here as a one-line diff instead of a timeout.

`limit.test.mjs` contains real banner phrases. That is the same carve-out
`scripts/claude-stub-limit.mjs` already takes — the repo-wide rule is about the
daemon PRINTING one onto a session's screen, where it would false-positive its
own detector. A test fixture is never rendered into a terminal.

`headlesslimit.test.mjs` takes that carve-out too, and for a run with no screen
at all: `claude -p --output-format json`, refused by the account, exits non-zero
with the banner in the envelope's `result` and nothing on stderr, so every
headless caller reported `Command failed: claude -p …` — a sentence naming no
fact. The fixtures are the real envelope shape around a real banner line.
