# Security assurance case

Why waterplane's security requirements are met. [SECURITY.md](../../SECURITY.md) states what a user
can and cannot expect and holds the detail; this note makes the argument and names the evidence. It
covers the host daemon, the phone client and the release path.

## The claim

Only a person who controls a device the operator has trusted can make the daemon act. Once such a
device is connected it can do anything the desktop account can: that is the product, and sandboxing
it is out of scope by design.

## Threat model

| Actor | Wants | Stopped by |
| --- | --- | --- |
| A stranger on the internet | To reach the daemon, which spawns `claude` and so runs code | No public interface is bound by default. Funnel traffic is classed `public` and always needs a token. |
| Someone on the same LAN | The same, when the owner opted into `WATERPLANE_ALLOW_PUBLIC=1` | Password or device token, deny until set. LAN can never set the password or manage auth. |
| A malicious web page in a browser on a trusted device | To drive the API or the WebSocket from that browser, including by DNS rebinding | `Origin` and `Host` checked on every `/api/*` request and WS upgrade, `Sec-Fetch-Site` as the backstop. |
| A local process or a repo the agent works in | To reach outside the repo root, or to forge a hook | Path containment guards. `POST /api/hook` is local-process-only and ignores unknown sessions. |
| A passive device, or a paired peer desktop | More than its grant | `passive.ts` is a default-deny allowlist. A peer token unlocks only `/api/peer/*`. |
| Someone tampering with a release in transit | To ship altered code | Ed25519 signatures checked by the installer and `update`, npm provenance, signed web bundles pinned by the phone. |

Out of scope, as SECURITY.md lists: anything an authorised caller does, an operator who exposes the
daemon to an untrusted network, and bugs in `claude`, Tailscale or other tools it invokes.

## Trust boundaries

1. **Network to daemon.** The main boundary: Tailscale identity by default, a password or token on
   LAN. `packages/host/src/net.ts` classes each peer; `auth.ts` gates it.
2. **Browser to daemon.** Network identity does not cover a browser, so `origin.ts` adds its own
   check.
3. **Daemon to filesystem.** Routes taking a path stay inside the repo root (`paths.ts`, `files.ts`,
   `git.ts`, `scaffold.ts`). `scaffold.inRoot()` compares realpath-resolved paths.
4. **Daemon to spawned CLI.** Trusted by design. Answers typed without a person's tap go through
   `answergate.ts`, which refuses permissions, plan and trust dialogs, and anything destructive.
5. **Host to a plugin.** Plugins are code the operator installs and run with the host's rights. The
   boundary is what the operator chooses to install.
6. **Publisher to user.** Releases are signed with a key that stays off the distribution sites
   ([verify one by hand](../install.md#verify-a-download-by-hand)).

## Secure design principles

The principles are Saltzer and Schroeder's, as the OpenSSF criteria name them.

- **Economy of mechanism.** One WebSocket per tab, one send path, one delivery implementation
  (`deliver.ts`). The repo's lint rules hold these (`local/no-second-socket`).
- **Fail-safe defaults.** Deny until a password is set. An unreadable `auth.json` keeps the gate shut
  and never opens it. A new route is refused to a passive token until it is added on purpose.
- **Complete mediation.** The origin check runs on every `/api/*` request and every WS upgrade, the
  token gate on every non-trusted peer.
- **Open design.** The source and the threat model are public, and no security property depends on a
  secret design.
- **Separation of privilege.** Loopback manages auth and LAN cannot. A peer token cannot act as a
  device token. Consent for a gated action comes from the phone and is checked on the host
  (`confirmgate.ts`).
- **Least privilege.** Passive devices and peers get narrow grants. State files holding secrets are
  written with restricted modes, and workflows use job-scoped tokens.
- **Least common mechanism.** Each desktop signs its own web bundles, so a phone pins per desktop.
- **Psychological acceptability.** A route that is not protected is warned about in words, and a
  refusal says why. Security that a person has to guess at gets switched off.

## Common weaknesses, and how each is countered

| Weakness | Counter | Evidence |
| --- | --- | --- |
| Path traversal (CWE-22) | Containment guards on every file and git route, realpath-resolved | `packages/host/src/paths.ts`, `scripts/e2e-api.mjs` |
| Cross-site requests and cross-site WebSocket hijacking (CWE-352, CWE-1385) | `Origin`, `Host` and `Sec-Fetch-Site` checks. Side-effecting routes are never GET. | `packages/host/src/origin.ts`, `scripts/e2e-origin.mjs` |
| DNS rebinding (CWE-350) | `Host` allowlist, `*.ts.net` never widened, `*.local` never a wildcard | same |
| Command injection (CWE-78) | Host processes start from argument lists rather than a shell; the Windows launcher's fixed commands are the exception. A shell metacharacter in a build parameter refuses the run. | `packages/host/src/builds.ts` |
| Cross-site scripting (CWE-79) | Agent-written Markdown renders as React nodes, never raw HTML. Served files carry `nosniff` and a CSP. | `packages/web/src/Markdown.tsx`, `packages/host/src/routes/apiio.ts` |
| Missing or broken authentication (CWE-306, CWE-287) | Token gate by peer kind, deny until set, tokens per paired device | `packages/host/src/auth.ts`, `scripts/e2e-lan.mjs`, `scripts/e2e-pair.mjs`, `scripts/e2e-passive.mjs`, `scripts/e2e-peer.mjs` |
| Password guessing (CWE-307) | Login is rate-limited per real client address | `packages/host/src/ratelimit.ts` |
| Weak password storage (CWE-916) | scrypt with a per-password salt, constant-time compare | `packages/host/src/auth.ts` |
| Weak or home-made cryptography (CWE-327) | Node's `crypto` and vetted libraries only | `packages/host/src/auth.ts`, `packages/web/src/pqKem.ts` |
| Regular-expression denial of service (CWE-1333) | Property-based fuzz tests over the parsers and heuristics, plus `eslint-plugin-regexp` | `packages/host/test/fuzz.test.js`, `packages/shared/test/fuzz.test.js` |
| Secrets in the repo (CWE-798) | gitleaks in the guards, and a default-private allow-list for what is published | `.gitleaks.toml`, `deploy/public-allowlist.txt` |
| Vulnerable or hostile dependencies (CWE-1395, CWE-506) | No install scripts, a 7-day release age, `npm run audit`, Dependabot, osv-scanner, CodeQL | `.npmrc`, `.github/dependabot.yml`, `osv-scanner.toml`, `.github/workflows/codeql.yml` |
| Tampered updates (CWE-494) | Signatures checked before a download is read | `deploy/release-pubkey.pem`, [distribution.md](distribution.md) |

## Keeping the case true

The e2e scripts named above run in the pre-push suite, so a change that breaks a guard fails before
it reaches `main`. Repeated security passes look for what the tests do not cover. A change to the
security model updates SECURITY.md, and this note when the argument changes.
