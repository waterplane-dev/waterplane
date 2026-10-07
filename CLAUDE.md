# CLAUDE.md

Guidance for Claude Code in this repo. **This file is the ALWAYS-ON part: orientation, the security
boundary, and the rules that are dangerous not to know before you act.** Everything else — the
module indexes, the protocol detail, the heuristics, the test map — is a SKILL, loaded when you are
actually in that code, and the reasoning behind all of it is in [`docs/notes/`](docs/notes/README.md).

**Why the split:** this file is re-read on every turn of every session and subagent. It reached 148k
chars once — 21% of a week's tokens. A rule that can cause harm must be here (a skill not invoked is
a rule that does not exist); a reference you only need while editing `packages/web` must not be.
`tools/claudemd.test.mjs` (in `npm run test:unit`) holds this file to 12k chars, one line per
subsystem, and "every module named is described in `docs/notes/`". Raising the cap is a decision
about cost, not a way to make the check pass.
[Why a check and not a paragraph.](docs/notes/testing-and-ops.md#claudemd-has-a-budget-because-it-had-a-sentence)

## What this is

waterplane remote-drives the real `claude` CLI on a desktop from a phone over
Tailscale. Phone = React PWA (xterm.js); desktop = Node daemon spawning `claude` in a PTY, bridged
by one WebSocket per tab.

Central design choice: **drive the actual binary in a PTY, never re-implement it** — so every slash
command, the context meter and plan/trust prompts work natively.

Three workspaces, one deliberate non-workspace:

- **`packages/shared`** — wire types + the pure logic both ends must agree on. `shared/dist` is
  node-runnable so e2e can pin it. **Build before host/web.** ⇒ skill `shared`
- **`packages/host`** — Node daemon (ESM, `tsx` dev, `tsc` → `dist/`). PTYs, repo discovery, git,
  push; serves `packages/web/dist`. ⇒ skill `host`
- **`packages/web`** — React 18 PWA, xterm.js; Vite dev proxies `/api` + `/ws` to :8770.
  ⇒ skill `web`
- **`packages/app`** — Android shell: **Capacitor, explicitly not Ionic Framework.** Ships the same
  Vite bundle in an APK so *the app shell is never on the network*. Kept out of root `workspaces` so
  Capacitor deps stay out of every `npm install`. **The UI updates over the air** — only
  Java/manifest/icon changes need a new APK. See `packages/app/README.md`.

Demo mode + fake host: `docs/notes/testing-and-ops.md`.

## The phone↔repo transport

- **Artifacts a person should see go in `.claude/outbox/`** — that is what the phone's gallery and
  the repo badge read. Files uploaded FROM the phone arrive in `.claude/inbox/`.
- Both are gitignored plumbing, never source. Never commit their contents.
- **Name a transport file by its FULL path every time you mention it** —
  `.claude/outbox/flow.gif`, not the dir once and bare filenames under it. That path is what the
  reader turns into the picture itself; a bare name only resolves when the repo's listing holds
  exactly one media file by that name, and never in prose.

Here and not in a skill, deliberately: it applies whenever anything is written for a person to look
at, which is not confined to one area of the code — and a convention only loaded while editing
`packages/host` is one the agent will not know about while writing a report.

## Plugins, and what a repo is told — two things, kept apart

- **A waterplane plugin extends waterplane from outside this repo** (`~/.config/waterplane/plugins/`, or paths in
  `plugin-paths.json`): `waterplane-plugin.json` + `host.mjs`. Contract `shared/plugin.ts`, why
  [plugins.md](docs/notes/plugins.md). Plugin UI runs on the phone only as in-repo extensions in the
  bundle — never lazy, never outside the SDK (`local/extension-boundary`). **Anything answering a box without a tap goes through
  `answergate.ts`.**
- **What a driven repo's agent learns about waterplane is core, never a plugin:** `reposkilltext.ts`,
  handed to every spawned `claude` via `--plugin-dir` (`reposkill.ts`). A new repo-facing
  capability is a paragraph there.

- **Peer desktops** (`docs/notes/host.md`, `peers/`): a paired host runs a job and
  reports back as one prompt. A peer token unlocks only `/api/peer/*` (never a device token); a job
  never restarts the peer's live daemon.

## Which skill to load

Load the skill BEFORE reading or editing the code it covers — it carries the rules that area's
modules hold, and most of them exist because of a measured failure.

`host` and `web` are ROUTERS: small on purpose, they name the one sub-skill that
holds your module's rules. Load the router, then that sub-skill — never the whole set.

| working on | load |
|---|---|
| `packages/host/src` | `host` → `host-core`, `host-work`, `host-spenders`, `host-ledgers`, `host-machine` |
| `packages/web/src` | `web` → `web-chrome`, `web-send`, `web-term`, `web-work`, `web-files`, `web-config`, `web-numbers` |
| a wire DTO, the queue, intents, token/context/budget maths | `shared` |
| adding a message, an ack/retry path, `PROTOCOL_VERSION`, tmux | `protocol` |
| `prompt.ts` / `question.ts` / `limit.ts` / `context.ts` / `clihealth.ts` | `heuristics` |
| writing or changing a test | `testing` |
| docs gifs, demo scenarios, diagrams | `docs-media` |
| splitting a big file | `refactoring` |

## Commands

```bash
npm ci               # .npmrc: no install scripts, 7-day release age (supply chain)
npm run build:shared # must precede host/web type-check against @waterplane/shared
npm run dev          # host :8770 + vite dev (proxies /api + /ws)
npm run build        # shared → host → web; web/dist served by host on :8770
npm run restart      # ALWAYS restart with this — never `pkill; node …`
npm run doctor       # preflight only (claude login, Tailscale, secure context)
npm test             # lint, test:unit, test:host, then run-e2e.mjs — needs `npm run build` first
```

- **`npm run restart` is mandatory.** It builds first (failing loudly without taking the host down),
  then `launchctl kickstart -k`s the launchd service if installed, else kills + waits for :8770 to
  free + starts detached. Hand-killing races launchd's KeepAlive. **Host/shared edits
  reach the running service only via this.**
- **`.env.example` is the complete list of env knobs — keep it current when adding one.** Most-used:
  `WATERPLANE_ROOT` (~/dev), `WATERPLANE_PORT` (8770), `WATERPLANE_HOST`, `WATERPLANE_ALLOW_PUBLIC`,
  `WATERPLANE_PREFLIGHT`, `GEMINI_API_KEY`. Full table:
  [testing-and-ops.md](docs/notes/testing-and-ops.md).
- Tests: `npm run test:unit` (pure logic, no host) · `npm run test:host` (regex heuristics,
  no daemon) · `node scripts/run-e2e.mjs <filter>`. Details ⇒ skill `testing`.

## Never do these

Short on purpose: each has caused a real failure here and is invisible in review unless you know it.

- **Never bind a public interface, and never reintroduce `access-control-allow-origin: *`.** The
  daemon spawns `claude`. See the security model below — it is the one section that is never a skill.
- **Never add a second WebSocket.** One socket per tab carries everything (`local/no-second-socket`).
- **Never add a send path that bypasses the queue, and never retry without an ackId.**
- **Never fork `deliver.ts`.** It is the one implementation of "type into a live session and
  confirm". Same for `download.ts` (one download button; never another `<a download>`),
  `PromptComposer.tsx` (one prompt textarea) and `render.ts` (one headless VT replay).
- **Never put usage-limit banner phrases in strings or comments repo-wide** — printing one on screen
  false-positives the detector.
- **Never grey out a button to mean "not clickable".** Say why in text (`Unavailable.tsx`); a
  `title` is invisible on a phone.
- **A count on a control is a filter.** A tap on "2 within the hour" opens exactly those two, never
  the unfiltered list for the reader to re-derive them from. The filtered view then SAYS what it is
  hiding, "n of N", with a clear button — one bucketing function feeding both the number and the cut,
  never two copies of the edge.
- **Never use `window.confirm`** — a native modal blocks the WebView's event loop (`Confirm.tsx`).
- **Never use emoji as UI icons.** `lucide-react` only.
- **Never loosen the path containment guards** (`paths.ts`, `containRepoDir`, `scaffold.inRoot`).
- **Never overwrite typed words with words nobody typed.** A draft, a note, a queued prompt is the
  last copy; seeding over one is a delete (`seedSheetDraft`, `local/no-draft-clobber`). Rescue first,
  and say so.
- **Nothing applies itself.** An assessment, a review verdict or a cost reading produces sentences a
  person acts on — never a mutation, never a refusal.
- **Heuristics degrade to null or absent, never to a wrong number.**

## Working in a session here (token discipline)

Measured on this desktop: 124 conversations out of 8,968 in a fortnight grew past 200k of context,
and those 124 were **76% of every token spent**. Turns at index 80+ were 54% of the total at an
average of 312k per turn, and a 1M window never compacts itself.

- **Every turn re-sends the whole conversation**, so the next turn's price is the size of what is
  already there, not of what you are about to ask. `shared/sessioncost.ts` is that arithmetic and the
  UI says it out loud.
- **Don't batch unrelated work into a long session.** A one-off question is cheaper where the cache
  is warm; past ~3 turns that don't need the window, a fresh session wins.
- **Prefer a subagent for fan-out reading** — it burns the dumps in its own window and returns the
  conclusion. Not for a known-file lookup: a fresh baseline costs more than a `grep`.
- **A repo's always-on weight is checked, not remembered.** The repo-setup sheet's `context-weight`
  row measures `CLAUDE.md` + skill descriptions and warns past `WATERPLANE_CONTEXT_WARN_CHARS`; skill
  BODIES are on-demand and never count. The line is per repo (the row's *thresholds* control, over
  env, over the default) — a setting, not a restart. It never edits anything: the *groom CLAUDE.md*
  preset is the fix.
- **The automatic spenders are cheap on purpose and must stay so.** `sessions/record.ts`'s tab-name call
  (`nameTab`, once per session, off the first prompt only) runs on `SUMMARY_MODEL` with
  `--setting-sources user --tools ""` and its own system prompt (83k tokens → 1.9k), and its result
  is persisted so a restart re-derives nothing. Any new
  unattended `claude -p` starts from those flags and justifies every one it drops.

## Security model

- **Tailscale network identity is the boundary.** The daemon spawns `claude` (arbitrary code
  execution) — never bind a public interface. `WATERPLANE_HOST` defaults to Tailscale IP then loopback.
  Keep `SECURITY.md` in sync.
- **Network identity does not cover browsers** (`origin.ts`): a WebSocket ignores the same-origin
  policy. Every `/api/*` request and WS upgrade is checked on `Origin` *and* `Host` (DNS rebinding),
  with `Sec-Fetch-Site` as the backstop for `Origin`-less cross-origin GETs. Missing `Origin` is
  allowed (curl, e2e, hook sink). **Never reintroduce `access-control-allow-origin: *`**, never
  widen `*.ts.net` past the MagicDNS fallback, never reinstate `*.local`. Side-effecting endpoints
  must not be GET (`/api/host/screenshot` is POST for this). That backstop exempts exactly two
  read-only routes (`OPAQUE_READ_ROUTES`: artifact + inbox file, safe methods only) because the
  Android shell loads them as `<img src>`/`<a download>` — no `Origin`, `Sec-Fetch-Site:
  cross-site` — and refusing them killed every thumbnail and every download in the APK. Widen that
  list only for another route that is loaded outside a transport, i.e. one `api.ts` builds with
  `abs()`.
- Path containment guards in `files.ts` / `git.ts` / `scaffold.ts` are asserted by e2e — don't
  loosen. `scaffold.inRoot()` compares **realpath-resolved** paths (`/var` → `/private/var`).
- `POST /api/hook` is **loopback-only** and no-ops on unknown sessions.
- LAN password gate (`auth.ts`) when `WATERPLANE_ALLOW_PUBLIC=1`: loopback always trusted, tailscale
  trusted unless gated, lan/other always need a token. **Deny-until-set**, and **LAN can never set
  the password**. Changing it rotates all tokens.

### Secure context

Plain `http://100.x` is not a secure context ⇒ no service worker, no push, no install, no clipboard
— and **any navigation while the tunnel is down loses the whole app** (no cached shell). Hence the
insecure-origin banner with a one-tap switch, snoozed a week not dismissed, and the double health
probe before the watchdog reload. Fix: `tailscale serve --bg --https=443
http://127.0.0.1:8770`. **The serve port is discovered, never assumed** (`serveHttpsUrl` matches the
proxy target); a front door on another port needs `WATERPLANE_ALLOWED_HOSTS`/`_ORIGINS` *with* the port.