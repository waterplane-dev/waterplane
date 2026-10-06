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
- **Secrets are written from the phone**, into a gitignored \`.env\` in this repo
  (or the host's own env file). You never see the value and must never ask for
  it in chat; ask the person to set KEY via the phone's secret sheet instead.

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

\`${D}/builds.json\` is the list of build buttons the phone shows for this
repo. A tap runs the command in a plain shell here — no \`claude\` session, no
tokens — which is how the person still gets an APK while rate-limited. You may
add or fix entries when asked; keep every other entry as it is. Shape:

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

## Everything else under ${D}/

\`${D}/\` is ${N}'s per-repo state. The files above are the ones you may edit
when asked. Leave the rest alone — including \`${D}/plan.md\` and
\`${D}/assess-*.json\`, which belong to the phone's assessment run.
`;
}
