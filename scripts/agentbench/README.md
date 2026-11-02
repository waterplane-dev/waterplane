# agentbench — the same small tasks, through a real host, on any backend

Opt-in, never part of `npm test`: it drives real CLIs (Copilot spends AI credits, `claude`
spends the account, local models need Ollama). Written 2026-10-31 to answer "why do Copilot and
local models do so badly here?"; the findings are in `docs/guide-other-agents.md`.

Each run copies a prepared clone, applies the task's setup (`bug` breaks `calday.ts` first),
boots that clone's OWN host on a free port with its own state, config and tmux socket dir,
creates ONE session with the prompt exactly as the phone would (`session.create` + `prompt`,
`permissionMode: bypassPermissions`), plays the person only where the phone cannot (a tool box
is answered "1"; Copilot's terminal-only trust dialog gets an Enter), waits for the turn to
end (Stop hook / `turnActive`, then 20 s quiet) or the timeout, grades the clone, reads the
CLI's own log for tool calls, and appends a row to `results.jsonl`.

```sh
export AGENTBENCH_WORK=/tmp/agentbench          # default: $TMPDIR/agentbench
node scripts/agentbench/prep.mjs before <commit> # clone + node_modules shim + shared/host built
node scripts/agentbench/prep.mjs after HEAD
node scripts/agentbench/run.mjs --src after --backend copilot --task ui
scripts/agentbench/queue.sh after after 20 claude-local:qwen3-coder:30b-64k copilot claude:sonnet
```

`run.mjs` flags: `--src <label>` (which prepared clone; its host is the one booted),
`--backend`, `--model`, `--task ui|bug|logic|locate|rule`, `--timeout-min`, `--label`,
`--plugins dir[,dir]` (default: `~/.config/waterplane/plugin-paths.json`), `--ollama <url>`,
`--env K=V[,K=V]` (host env, e.g. `WATERPLANE_CLAUDE_LOCAL_USER_SETTINGS=0`).
`proxy.mjs` (`PORT=… UPSTREAM=… LOG=… [FULL=1]`) logs every `/v1/messages` request a local
session makes — system size, tools, message chars — which is how "what reaches the model" was
measured: point `--ollama` at it.

The tasks (`tasks.mjs`) are this repo's: a UI position + colour tweak whose CSS lives in an
oddly named file, a bug from a pasted test failure, a logic change with a test, a "where is X"
question answered into a file, and a change that must follow a CLAUDE.md rule (`askConfirm`,
never `window.confirm`). Graders read the clone, never the agent's words.

Caveats: sessions run with your real `~/.claude` / `~/.copilot` (logins, user hooks, settings),
so they write conversation logs under `~/.claude/projects/<scratch path>` — remove those after.
