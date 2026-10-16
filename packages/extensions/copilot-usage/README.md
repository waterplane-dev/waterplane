# copilot-usage — Copilot's quota on the usage meter

A host-only extension (no `web/`): it contributes one **usage probe** (`api.usageProbe`, plugin
API 1.7) so the phone's usage chip draws a `Copilot 5% mo` segment beside Claude's. The core owns
everything else — the registry (`packages/host/src/usagesources.ts`), the kept history
(`usagesourcelog.ts`, `GET /api/usagelog/copilot`), the `usage.status` frame's `readings` list.

**When it reads anything.** Only on a desktop with a `copilot` executable on `PATH` (looked up once
at activation, nothing spawned). Elsewhere it registers nothing, so `gh` is never run and the chip
is exactly Claude's.

**What it reads.** `gh api /copilot_internal/user` with gh's own keyring sign-in — no new
credential, no PTY, no model call (so the halt latch is not asked). The endpoint is internal and
undocumented; `host/ghquota.mts` names every field it reads:

| field | becomes |
|---|---|
| `quota_snapshots.chat` | window `chat`, unit `mo`: `pct = round(100 − percent_remaining)`, `credits_used / entitlement` credits |
| `quota_snapshots.premium_interactions` | window `premium`, only when `has_quota && !unlimited && entitlement > 0` |
| `quota_snapshots.completions` | skipped — IDE autocomplete, not a CLI's spend |
| `quota_reset_date_utc` | every window's reset (null when absent or unparseable) |

`unlimited` drops a window; no window left, gh missing, not signed in, a non-2xx, or a body that is
not that shape ⇒ **null, the segment is absent** — never a guessed number. One log line per cause
until it recovers. `copilot_internal/v2/token` answers 403 and is never asked. The chat
entitlement matches the Copilot CLI's own `/usage` screen (`0 / 200 AIC`): its credits and this
endpoint's are one unit.

**When it is asked.** Every 15 minutes while the host polls usage at all (something gates on it —
the same predicate claude's `/usage` poll uses), and when a phone asks for a fresh figure, behind
claude's TTL. A failed ask is not retried for a minute.

**Knob.** `WATERPLANE_GH_BIN` — the gh binary (default `gh` on `PATH`); the e2e points it at a stub.

Test: `node --test packages/extensions/copilot-usage/test/ghquota.test.mjs` (after the host build).
