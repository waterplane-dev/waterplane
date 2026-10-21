import { BRAND, legacyParamEnvNames, paramEnvName } from "@waterplane/shared";

/**
 * The BODY of the repo-facing skill — what the agent in a driven repo learns
 * about this product. `reposkill.ts` adds the frontmatter and hands it to every spawned
 * `claude` via `--plugin-dir`; editing this text IS the release — the next
 * session started reads it.
 *
 * Grow it when the product gains something a repo's agent has to know about.
 * `tools/reposkill.test.mjs` fails when the host reads a per-repo state-dir
 * file this text never names.
 *
 * Written for a reader who has never heard of the product and is mid-task: rules
 * first, each with its reason in one clause, no history.
 */
export function repoSkillBody(port: number): string {
  const D = BRAND.stateDirName;
  const S = BRAND.sharedDirName;
  const N = BRAND.displayName;
  const [wpU, wpL] = BRAND.promptAliases;
  const param = paramEnvName("<ID>");
  const olderParam = legacyParamEnvNames("<ID>")[0];
  const base = `http://127.0.0.1:${port}`;
  return `
# Working in a repo driven by ${N}

${N} runs this \`claude\` session in a pseudo-terminal
on the desktop and lets a person drive it from their PHONE over Tailscale. It is
the real CLI — every slash command works — but the person reading you is on a
small screen, often away, and sometimes not reading at all while you work.

## Names you may be called by

The person may say "${N}", dictated as "water plane", or the short form
"${wpU}" / "${wpL}", meaning this tool: "ask ${wpL} to build it" or "put it in the ${wpL}
outbox" is about ${N}. **Exception: in a WordPress repo, "${wpL}" means
WordPress** — a repo with \`wp-content/\`, \`wp-config.php\` or a WordPress
plugin or theme header. If it is unclear which was meant, read it as the
repo's own meaning and say so in one line rather than guess.

## The frame you work in

- **The reader is on a phone.** Long terminal output is unreadable there. Say
  the conclusion in a few lines; put anything bigger (a report, a table, a diff,
  a screenshot) in a FILE in the outbox and name it.
- **The person may be away.** A question you ask can sit for hours. Batch your
  questions, ask them at the end of what you can do without the answer, and
  never block on a choice you could make and report.
- **A choice box may be answered for the person.** A plugin they installed may
  suggest, or with their switch on answer, a routine question while they are
  away — never a permission, a plan/trust dialog, or anything destructive. Word
  questions so the safe, reversible option is obvious.
- **Your session may stop and resume.** On a usage limit the CLI exits; ${N}
  resumes it with \`--continue\` at the reset. Keep work resumable: commit or note
  progress as you go rather than holding it all in the conversation.
- **Prompts may arrive unattended.** A backlog item, a schedule or a chain can
  start a fresh session here with a prompt written earlier. Treat it as
  written by the person, at the time they wrote it.
- **No interactive programs.** Nobody can drive an editor, a pager or a TUI
  through you. Use non-interactive flags (\`--yes\`, \`CI=1\`, \`git --no-pager\`).
- **Secrets never go into files, chat or commits by you.** You never see a value
  and must never ask for one in chat; ask the person to set KEY from the phone.
  If the desktop has a secrets tool and its skill is installed, follow that skill
  for anything it covers (reading a key, using a login).
- **Subagent windows are not capped by the session's compaction setting.** An
  agent re-reads its whole window on every step, so one that grows to 500k
  costs that much per step. Give each agent one narrow work package, set
  \`model\` explicitly (Sonnet for mechanical lanes), and brief it to return
  before about 200k of context. For a repo's own agent definitions, \`maxTurns\`
  in the frontmatter caps how many steps an agent may take.

## Showing the person something: the outbox

- **\`.claude/outbox/\`** is what the phone's gallery shows, and a new file there
  notifies the phone. Put screenshots, reports, recordings and generated
  documents here. (\`.outbox/\` at the repo root is read too; prefer
  \`.claude/outbox/\`.)
- The gallery lists images (png, jpg, gif, webp, svg, …), video (mp4, webm,
  mov), and documents (pdf, md, txt, csv, json, log, html) plus build
  deliverables. Markdown and HTML open in place on the phone.
- **Name a file by its FULL path every time you mention it** —
  \`.claude/outbox/flow.gif\`, never \`flow.gif\` or "the file above". The phone
  turns that exact path into the picture or a download button; a bare name
  only resolves by luck.
- Never commit the outbox or the inbox. Both are gitignored plumbing.

## Files the person sent: the inbox

Files uploaded from the phone land in **\`.claude/inbox/\`**, and the prompt
names them by path. Read them from there; don't move them into the source tree
unless asked (copy what you need).

## Builds the phone can run without you

\`${S}/builds.json\` is the list of build buttons the phone shows for this
repo. It is COMMITTED with the repo, so every clone and every desktop gets the
same buttons — this is where you add one. A tap runs the command in a plain
shell here — no \`claude\` session, no tokens — which is how the person still
gets an APK while rate-limited. You may add or fix entries when asked; keep
every other entry as it is. \`${D}/builds.json\` (gitignored) has the same shape
and is only for an entry that holds a path existing on THIS desktop alone (a
\`JAVA_HOME\`, a local SDK); an entry there with a shared entry's \`id\`
replaces it on this desktop only. Shape:

\`\`\`json
[{ "id": "apk", "name": "Release APK", "cmd": "./gradlew assembleRelease",
   "dir": "android",
   "params": [{ "id": "flavor", "kind": "choice", "options": ["prod", "dev"],
                "default": "prod", "hint": "which flavour" }] }]
\`\`\`

- \`cmd\` and \`dir\` may use \`{{param}}\`; each value is also exported as
  \`${param}\` (older: \`${olderParam}\`). \`dir\` is relative to the repo root.
- A \`choice\` gets \`options\`, or \`optionsCmd\` — a one-liner run in the repo root
  when the form OPENS (one option per stdout line, 6 s limit), so a monorepo's
  members are read, not copied into the file.
- No \`default\` means an unattended run (a schedule) is refused rather than
  guessed.
- Builds run with \`CI=1\`; make the command non-interactive.

**What a build leaves behind is collected for you.** Outputs (apk, aab, ipa,
zip, jar, dmg, exe, deb, tar.gz, whl, …, found mostly under build/, dist/, out/,
target/, bin/, release/) are copied into \`.claude/outbox/\` under a name with
the repo, variant and the project's own version, and older builds of the same
artifact are removed. **So never copy a build artifact into the outbox by
hand** — a hand copy is a second copy nothing prunes. The rule is
\`${D}/artifacts.json\`: \`{ "collect": true, "prune": true, "keep": 3 }\`
(those are the defaults when the file is absent).

## A reading of this repo's own, on its health charts

The phone's repo-health charts are ${N}'s readings, the same in every repo. A
repo may add numbers only it knows about itself in \`${S}/health.json\`
(COMMITTED; only the committed version runs):

\`\`\`json
{ "readings": [{ "key": "screenFixtures", "name": "Signals tested on today's screens",
  "means": "One sentence: what it counts and why it matters here.",
  "better": "higher", "unit": "signals", "run": ["node", "tools/x.mjs", "--reading"] }] }
\`\`\`

\`run\` is an argv list (no shell), run in the repo root once per refresh that
measures a new commit, 30 s limit, at most 8 readings. It must print ONE JSON
number or \`{"value": n}\` on stdout; when it cannot count, print nothing and
exit non-zero with the reason on stderr — never print 0 for "unknown". These
are drawn apart from ${N}'s and never enter the health index.

The same file may change ONE of ${N}'s five index readings (\`size\`,
\`retouch\`, \`hatches\`, \`context\`, \`untested\`) instead of replacing the
whole engine — disable it, or measure it with the repo's own command:

\`\`\`json
{ "central": {
  "context": { "disable": true, "why": "CLAUDE.md here is generated from docs/" },
  "size": { "run": ["node", "tools/p95.mjs"], "why": "generated parsers are not ours",
            "means": "p95 lines per hand-written file" } } }
\`\`\`

\`why\` is required (without it the entry is ignored, and the phone says so).
A disabled reading is still drawn, marked disabled, and leaves the index
mean. An override runs like a reading above — at HEAD only, same limits — and
must print the number in the central reading's own unit, lower = healthier
(\`retouch\` and \`untested\` as a fraction 0–1, \`hatches\` per 1,000 lines,
\`context\` in chars, \`size\` in lines). It has no history before its first
refresh. Any change here — adding, removing, or editing a \`run\` — makes the
index CARRY that week instead of comparing it, so a tweak never reads as the
repo getting healthier or worse; expect one flat week, not a jump.

## Downloads that start on their own

\`${D}/autopull.json\` tells the phone to start downloading new files the moment
they appear — so a 90 MB APK is already on the phone when the person looks,
and a dead spot resumes rather than restarts. Shape:
\`{ "enabled": true, "scope": "outbox", "match": ["*.apk"], "maxBytes": 0,
"builds": true, "supersede": true }\` (\`scope\` \`outbox\` or \`repo\`; \`match\` is
name globs, or paths when a pattern has a slash; \`maxBytes\` 0 = no cap;
\`builds\` also queues build outputs; \`supersede\` keeps only the newest of the
same artifact). Usually set from the phone; change it only when asked.

## Screenshots of what you built

If \`${D}/capture.json\` has targets (\`{ "version": 1, "targets": [ … ] }\`, each
with an \`id\`, a \`name\` and a \`backend\` such as a browser URL or an Android
device), ${N} can screenshot the running app, wait for it to settle, and write
the frame plus a JSON sidecar into \`.claude/outbox/capture-*\`. Trigger it
without spending tokens on the image:

\`\`\`sh
curl -s -X POST ${base}/api/repos/<repoId>/capture/run \\
  -H 'content-type: application/json' -d '{"target":"<targetId>","wait":true}'
\`\`\`

\`<repoId>\` comes from \`curl -s ${base}/api/repos\`. The answer is a sentence and
a verdict, not a picture — read that first, and look at the image only when
the words cannot settle it (each image you look at is re-sent on every
remaining turn). Where capture is configured, the \`visual-check\` skill in this
repo has the full ladder.

## Work for later: a timed, chained or new-session prompt, or a backlog item

When the person asks for work LATER — "run this 3 h before the weekly reset",
"after that finishes, review it", "start a new session with this" — post it to
${N} instead of handing them text to paste. It lands in the repo's backlog on
the phone, marked as posted by an agent, where the person can edit or delete it
like any row they typed. **Only when they asked for later or scheduled work**;
never to split your own current task, and never a recurring rule (that is the
person's to set on the phone).

\`\`\`sh
curl -s -X POST ${base}/api/agent/intents -H 'content-type: application/json' \\
  -d '{"key":"<unique-key>","repo":"<repoId>","prompt":"<the whole prompt>",
       "when":{"kind":"window","window":"weekly","leadMin":180}}'
\`\`\`

- \`key\` makes it once-only: a retry with the same key returns the same row, so
  retrying a failed curl is safe. Pick a key that names the job (one key, one
  row, across both routes below).
- Where: \`repo\` (id from \`${base}/api/repos\`) or \`dir\` opens a NEW session;
  \`"session":"<id>"\` sends it into that live session instead. \`steps\` (a list)
  in place of \`prompt\` is a chain, one turn at a time. A new session stays open
  when done unless the person set otherwise; \`"closeWhenDone":true\` (or \`false\`)
  decides it for this one — only when they said so.
- \`when\`: \`{"kind":"now"}\` · \`{"kind":"at","at":"2026-10-02T09:00:00+02:00"}\` ·
  \`{"kind":"window","window":"session"|"weekly","leadMin":N}\` (N minutes before
  that usage window resets, once) · \`{"kind":"after","id":"<intent id>"}\` (add
  \`"onlyIfOk":true\` to skip it if that one failed).
- The answer has \`id\`, \`state\` and \`fires\` — one line saying when. Tell the
  person that line. It still waits for their auto-fire switch and budget.
- **Just add it to the list, to run when the person says:** \`POST
  ${base}/api/agent/backlog\` with the same \`key\`, \`repo\`/\`dir\`/\`session\`,
  \`prompt\`/\`steps\` and optional \`label\` — no \`when\`. It never starts by
  itself; the person fires it from the backlog. Prefer this when unsure.
- \`GET ${base}/api/agent/intents\` lists what agents posted (both kinds); \`DELETE
  ${base}/api/agent/intents/<id>\` calls one off before it starts. Local only:
  it answers \`curl\` on this desktop, never a browser.
- **Run order.** Rows due at the same moment (one reset, one instant) run in
  queue order. \`GET ${base}/api/agent/queue?repo=<repoId>\` lists every waiting
  row — the person's too — first to run first, with \`seat\`, \`id\`, \`title\`,
  \`fires\`. When the person says which goes first (now, or when they ask you to
  schedule several), \`POST ${base}/api/agent/queue/order\` with
  \`{"ids":["<first>","<second>",…]}\`: those rows run in that order among
  themselves, rows not listed keep their seats. Only when the person asked for
  an order — it is their decision, and the phone marks it as theirs. Posting
  several in one go: post them, then set the order.

## Flagging your own session for follow up

When you FINISH with something the person must read or decide — a test you could
not fix, a call only they can make, a risky change to review — flag this session
with one line, so it is marked on the phone and they get a push. Most of all on
unattended, backlog or scheduled runs, where nobody is watching. Not for routine
success, and at most once per finished task. You can set the flag, never clear it.

\`\`\`sh
curl -s -X POST ${base}/api/agent/followup -H 'content-type: application/json' \\
  -d "{\\"dir\\":\\"$PWD\\",\\"reason\\":\\"migration needs your call: drop the old column?\\"}"
\`\`\`

If two sessions share the folder the answer lists them; retry with \`"session":"<id>"\`.

## Delegating to a paired desktop (a peer), and what comes back

Only when the person asked for work on another machine ("test this on the PC"), and only if
\`GET ${base}/api/peers\` lists that peer. You never get a shell there. A job is a prompt that
opens ONE session on the peer, in a fresh detached checkout of a commit you pushed.

1. **Push first.** Commit, then push the branch to origin. The peer fetches from the shared
   remote; nothing is copied from this machine. A branch that is not on origin is refused here and
   nothing is sent.
2. \`POST ${base}/api/agent/peer/<peer>/intents\` with \`key\` (once-only, like the routes above),
   \`branch\`, \`commit\` (the pushed sha), \`prompt\` or \`steps\`, \`dir\` (your cwd; here, not the peer's), and optional
   \`peerDir\` (a path on the PEER, to pick one of two clones), \`label\`, \`closeWhenDone\`. \`GET\` and \`DELETE\` on the same path list or call one off. Tell the
   person the answer's \`fires\` line.
3. **What comes back:** ONE prompt in this session, marked as from the peer, holding the peer
   session's final answer (cut at a size cap, saying how much and which peer session holds the
   rest) and any \`${D}/outbox/\` files that answer names, fetched into this repo's outbox as
   \`${D}/outbox/peer-<peer>-<name>-<timestamp>.<ext>\`. It
   arrives when the peer's session finishes, which can be much later: the job waits for the peer
   owner's auto-fire switch and budget, and for a usage-limit reset. Do not poll; end your turn
   and say it is pending.
4. **Refused, as a sentence you get back:** no clone of this repo's remote on the peer (or two —
   add \`peerDir\` to pick), a version mismatch between the two hosts, an unreachable peer, a job aimed
   at the peer's own running ${N} checkout.
5. **Never restart the peer's ${N}.** A job's worktree (\`<clone>/.claude/worktrees/peer-<from>-<key>\`) is marked, and
   \`scripts/restart.sh\` and \`deploy/install-service.sh\` refuse there. Tests that start a host use their own port, never the live one.

## A button of their own: a ${N} plugin

When the person asks for something on the PHONE that ${N} does not ship (a
button, a switch, a status line, a settings field, a suggested answer to a
choice box), the answer is a ${N} plugin. **It is not a Claude Code mod or
plugin**: the \`plugin-authoring\` skill and \`/plugin\` change Claude's own
interface, never the phone's.

- **Where it lives:** its own folder, never inside this repo's source unless
  the person says so: \`~/.config/${BRAND.configDirName}/plugins/<id>/\`, or any folder listed in
  \`~/.config/${BRAND.configDirName}/plugin-paths.json\` as \`{"paths":["<dir>"]}\` (so it can be its
  own git repo).
- **What it holds:** \`${BRAND.pluginManifest}\` (id, name, version, apiVersion, and
  the actions, toggles and settings the phone draws) and \`host.mjs\`, an ESM
  module exporting \`activate(api)\`. The phone draws what the manifest declares;
  a plugin ships no UI code.
- **The contract:** \`docs/plugins-api.md\` in the ${N} repo
  (github.com/${BRAND.githubOrg}/${BRAND.slug}). Read it before writing one;
  do not guess the API.
- **It loads when the host starts.** A new or changed plugin needs a host
  restart; ask the person for it rather than killing the daemon. A broken
  plugin is listed on the phone with its reason, never skipped silently.
- **Answering a box goes through the core's gate** (\`api.answer\`), never typed
  keys: permissions, plan/trust dialogs and anything destructive are refused there.

## Everything else under ${D}/

\`${D}/\` is ${N}'s per-repo state. The files above are the ones you may edit
when asked. Leave the rest alone — including \`${D}/plan.md\` and
\`${D}/assess-*.json\`, which belong to the phone's assessment run.
`;
}
