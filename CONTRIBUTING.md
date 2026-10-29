# Contributing

Thanks for your interest. waterplane is a TypeScript monorepo (npm workspaces).
Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## How to contribute

**waterplane is open source, not open contribution.** You can read, fork and run all of
it. What it does not take is feature code from outside. Instead you send an **intent
request**: what hurts, what should be true afterwards, and how anyone would check that
it is. If it is accepted, the owner builds it.

### Why

- **The daemon runs `claude` on the owner's machine** — arbitrary code execution by
  design (see [SECURITY.md](SECURITY.md)). Code from outside is a supply-chain risk,
  and reviewing it line by line costs more than writing it.
- **Most code is now written by agents**, and the owner will not review agent-written
  code from strangers at volume. A clear intent is the scarce part; the build is not.
- **A request is untrusted input too.** It is never fed to an agent verbatim: the
  owner reads it and rewrites it into their own brief. Example code in a request is
  read, not pasted.

None of this is a judgement on you or your code. A good intent request is the most
useful contribution this project can get.

### The flow

1. **Run the `feature-request` skill** in a clone of this repo: start `claude` there
   and ask it to draft a feature request. It interviews you (problem, intent,
   acceptance criteria, non-goals), checks the idea against this repo's rules and
   existing requirements in [`docs/requirements/`](docs/requirements/README.md),
   estimates the size, looks for duplicates and writes the issue body. It runs on your
   machine with your tokens, and never posts without your explicit yes.
2. **Post it** with the *Intent request* issue form (or `gh issue create` from the
   skill). Paste the skill's feasibility verdict unedited.
3. **Triage.** The owner labels it `accepted`, asks a question, or closes it with the
   reason.
4. **Build.** The owner builds an accepted request with their own setup, fresh.
5. **Credit.** The commit carries a `Requested-by: @your-handle` trailer and the
   CHANGELOG names you.

### Pull requests

Exactly two kinds of code PR are merged:

- **A failing test that reproduces a bug** — the test only, no fix. It is the most
  precise bug report there is; the owner writes the fix.
- **A docs or typo fix.**

Any other PR is closed with a pointer back to this section. Bugs without a test are
welcome as issues (the *Bug report* form). Security problems go through
[SECURITY.md](SECURITY.md), never a public issue.

## Forks

Fork freely; to keep pulling upstream, customise **from outside the core**:

- **Plugins** for behaviour — a folder under `~/.config/waterplane/plugins/` or a path in
  `~/.config/waterplane/plugin-paths.json`, built against the generated reference
  [docs/plugins-api.md](docs/plugins-api.md). The API is semver: a plugin declaring
  `apiVersion` `1.x` loads on any host speaking `1.y` with `y ≥ x`. Start from
  [examples/plugin-template/](examples/plugin-template/); when you publish yours, **tag its repo with
  the `waterplane-plugin` topic** so it is [findable](https://github.com/topics/waterplane-plugin),
  and see [docs/plugins.md](docs/plugins.md) for how to get it listed.
- **Config overlays** in the same config dir for wording and data: `prompts/<name>.md`
  (the unattended prompts), `models.json` (the model catalogue) and `theme.json` — the
  look, the name and the icons:

  ```json
  { "displayName": "acme remote",
    "colors":   { "dark": { "--accent": "#ff7a00" }, "light": { "--accent": "#b34d00" } },
    "terminal": { "dark": { "background": "#101214", "foreground": "#e6e6e6" } },
    "icons":    { "favicon": "icons/mark.svg", "192": "icons/192.png", "512": "icons/512.png" } }
  ```

  `colors` overrides the CSS custom properties on `:root` in `packages/web/src/styles/00-tokens.css`
  (hex, `rgb()`, `hsl()`); `terminal` is the grid's background/foreground, which the host
  also tells tmux; `displayName` is what the running UI and the install manifest call
  themselves; `icons` (slots `favicon`, `apple-touch`, `192`, `512`, `maskable`) are PNG or
  SVG files **inside the config dir** — a path that resolves outside it, symlinks included,
  is refused — which the served page and manifest link instead of the built-in ones.
  Every key is optional, unknown keys are ignored, and no file is today's app.
  `<slug> doctor`'s `overlays` row lists what is active and names anything it refused.
- **Never edit core** to customise. A new feature talks over the generic
  `plugin.call` / `plugin.push` messages, never a new wire message type. HTTP routes
  for plugins (`api.route()`) arrive with the host's `api.ts` split.

### What a fork can and cannot override

| | how | can change | cannot change |
|---|---|---|---|
| **theme** | `<config dir>/theme.json` | colour tokens, the terminal's background/foreground, the display name, the icons (files inside the config dir) | layout, components, the build-time brand (`shared/brand.ts`, the APK's name, launcher icon and package id) |
| **promptText** | `<config dir>/prompts/<name>.md` | the WORDS of the unattended model calls: `session-title`, `session-title-system`, `session-rename` (the tab title), `tab-name` (backlog-row names), `assess-guidance`, `commit-message`, `review-check`, `review-check-diff`, `review-validate`, `review-validate-diff` | the flags, model, engine route, timeouts and trust check of those calls, and the JSON contracts their parsers read — those stay in code |
| **models** | `<config dir>/models.json` | add model ids/aliases to the picker, hide some | how a model is launched |
| **plugins** | `<config dir>/plugins/<id>/` or `plugin-paths.json` | host behaviour through the versioned API: commands, backends, screen/store readers, an answer to a box (through `answergate.ts`), declared UI (settings, actions, badges, status lines) | the wire (no new message types; use `plugin.call`/`plugin.push`), the send queue, the path guards. **Plugin UI code runs on the phone only as an in-repo extension compiled into the bundle** (`packages/extensions/<id>/web/`) — never loaded from a plugin dir at run time |
| **env knobs** | `.env` / `<config dir>/.env`, listed in full in [`.env.example`](.env.example) | ports, root, bind host, allowed hosts/origins, models, timeouts, sidecar routing | the security boundary: no knob binds a public interface without `WATERPLANE_ALLOW_PUBLIC=1` and its password gate, and none loosens the origin or path checks |
| **core** | — | nothing: a fork that edits `packages/*/src` carries a patch on every pull. A change the API cannot express is a request for an API minor bump, upstream | — |

Why, and the details: [docs/notes/plugins.md](docs/notes/plugins.md#the-fork-contract).

## Dev

```bash
npm ci               # exact lockfile; .npmrc runs no install scripts (see below)
npm run doctor       # preflight: claude login, node-pty, Tailscale, HTTPS, port
npm run build        # shared → host → web
npm run dev          # host on :8770 + Vite web dev server
npm test             # lint, unit, host heuristics, then the full e2e suite
```

- `packages/shared` — wire protocol types and the pure logic both ends share
  (host ↔ web). Build it before the others type-check.
- `packages/host` — Node daemon: PTY sessions, WS bridge, repo/git, backlog.
- `packages/web` — React PWA.
- `packages/app` — the Android shell (Capacitor), outside the npm workspaces.

`CLAUDE.md` is the always-on orientation: the security boundary and the rules that are
dangerous not to know. The detail per area lives in `.claude/skills/`, and the
reasoning behind it in [`docs/notes/`](docs/notes/README.md). `CLAUDE.md` has a size
budget enforced by a test; `docs/notes/` deliberately does not.

Install with `npm ci`, not `npm install`. The repo's `.npmrc` turns dependency install scripts
off and refuses versions younger than seven days; please don't override either in a PR. If you add
a dependency, say why in the PR — every one is code that runs on someone's desktop next to a
process that can execute anything. Details: [supply chain](docs/notes/testing-and-ops.md#supply-chain).

## Tests

**Test policy:** every behaviour change and every bug fix lands with a test in the same
commit — a `tools/*.test.mjs` guard, a `packages/*/test` case or a `scripts/e2e-*.mjs`
script. A change without one is not merged.

Three layers, from cheapest to most expensive:

| layer | command | what it covers |
|---|---|---|
| unit | `npm run test:unit` | pure logic in `packages/shared` and `packages/web` (`node --test`, no host), plus the repo checks in `tools/*.test.mjs` |
| host | `npm run test:host` | the regex heuristics over the `claude` screen, in `packages/host/test/` — no daemon |
| e2e | `node scripts/run-e2e.mjs` | `scripts/e2e-*.mjs`: each spawns a real host against a throwaway root, drives it over the real wire protocol, and asserts. A stub shell plays `claude`, so no login or API access is needed |

`npm test` runs `npm run lint` and all three (e2e needs `npm run build` first).
`scripts/run-e2e.mjs` discovers every `e2e-*.mjs` — a new script is picked up
automatically, nothing to register.

```bash
node scripts/run-e2e.mjs git origin   # only scripts whose name contains these
```

Every host-spawning e2e script **must** pin preflight off and run its tmux in
a socket directory of its own, or it will interfere with the machine it runs on:

```js
import "./lib-tmuxiso.mjs";  // private TMUX_TMPDIR: never the shared tmux server, every server killed on exit
WATERPLANE_PREFLIGHT: "0",   // no boot preflight — it would probe the real claude binary
```

`bootHost()` (`scripts/lib-e2e.mjs`) does both, and `run-e2e.mjs` gives each
script its own socket directory too. Sessions always run inside tmux — there
is no direct-PTY mode to pin.

The gifs in the README and the guide are filmed by the maintainer's own UI journeys against the
demo; that tooling is not part of this repository.

## Ground rules

These apply to the owner's builds and to anything you propose; the feature-request
skill checks a request against them. The full list is *Never do these* in `CLAUDE.md`.

- Heuristics degrade to absent, never to a wrong number. This wraps the `claude` CLI's
  terminal, which shifts between versions: prefer robust detection
  (whitespace-insensitive, tail-of-screen) over brittle string matches.
- Nothing applies itself: an assessment or a review produces sentences a person acts
  on, never a mutation.
- Code style is enforced, not negotiated: `npm run lint` (ESLint plus the repo's own
  rules) and strict `tsc` must pass, and `.editorconfig` sets whitespace.
- A count on a control is a filter. Never grey out a button to mean "not clickable" —
  say why in text.
- One send path (the queue), one WebSocket per tab.
- **Security.** The daemon executes code and has no app auth on the trusted path.
  Nothing widens network exposure without an explicit opt-in and a loud warning, and
  the path-traversal and same-origin guards are never loosened — the e2e scripts
  assert both (`e2e-api.mjs`, `e2e-origin.mjs`). See [SECURITY.md](SECURITY.md).
- **No emoji as UI icons** in the web app — `lucide-react` only.
- Don't paste the rendered Claude usage-limit banner text into comments or strings
  anywhere in the repo: a session that prints it on screen would false-positive the
  limit detector.

## Reporting issues

Use the issue forms. A bug report wants your OS, `node --version`, `claude --version`,
how you installed it, how you reach the host (Tailscale / LAN / loopback), and host
logs (`~/Library/Logs/waterplane-host.*.log` if running under launchd) — and, best of
all, a failing test.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.
