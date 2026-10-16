/**
 * Copilot's quota, read through `gh api /copilot_internal/user` — the parse is pure and
 * exported for its test; the fetch is one `gh` with a time bound and no shell.
 *
 * The endpoint is INTERNAL (no official doc; third-party meters read it too), so every field this
 * reads is named here and a shape it does not recognise is NULL — the source is then absent, never
 * a guessed number:
 *
 *   quota_reset_date_utc            "2026-11-01T00:00:00Z" → every window's resetAt (null if absent/NaN)
 *   quota_snapshots.chat            → window "chat"    (always, when it has a usable quota)
 *   quota_snapshots.premium_interactions → window "premium" only when has_quota && !unlimited && entitlement > 0
 *   quota_snapshots.completions     → skipped: IDE autocomplete, not what a CLI session spends
 *
 * Each snapshot: `{ has_quota, unlimited, entitlement, remaining, credits_used, percent_remaining }`.
 * `pct` = round(100 − percent_remaining) only when that is finite in 0..100; the count form
 * (`credits_used` / `entitlement`, "credits") rides beside it when both are finite. `unlimited`
 * ⇒ the window is absent (a percentage of no limit is not a number). `copilot_internal/v2/token`
 * answers 403 and is never asked.
 */
import { execFile } from "node:child_process";
import type { UsageReading, UsageWindow } from "@waterplane/shared";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

interface Snapshot {
  has_quota?: unknown; unlimited?: unknown; entitlement?: unknown;
  credits_used?: unknown; percent_remaining?: unknown;
}

function windowOf(id: string, s: unknown, resetAt: number | null, strict: boolean): UsageWindow | null {
  if (!s || typeof s !== "object") return null;
  const q = s as Snapshot;
  if (q.unlimited === true) return null;
  if (strict && (q.has_quota !== true || !finite(q.entitlement) || q.entitlement <= 0)) return null;
  if (q.has_quota === false) return null;
  const rem = q.percent_remaining;
  const pct = finite(rem) && rem >= 0 && rem <= 100 ? Math.round(100 - rem) : null;
  const w: UsageWindow = { id, unit: "mo", pct, resetAt };
  if (finite(q.credits_used) && finite(q.entitlement) && q.credits_used >= 0 && q.entitlement > 0) {
    w.used = q.credits_used; w.limit = q.entitlement; w.unitName = "credits";
  }
  // Neither a percentage nor a count: nothing to say about this window.
  return pct != null || w.limit != null ? w : null;
}

/**
 * The endpoint's body as a reading, or null (absent). `json` is the parsed body or its text.
 */
export function parseCopilotQuota(json: unknown, now: number = Date.now()): UsageReading | null {
  let body: unknown = json;
  if (typeof json === "string") { try { body = JSON.parse(json); } catch { return null; } }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as { quota_reset_date_utc?: unknown; quota_snapshots?: unknown };
  const snaps = o.quota_snapshots;
  if (!snaps || typeof snaps !== "object") return null;
  const parsed = typeof o.quota_reset_date_utc === "string" ? Date.parse(o.quota_reset_date_utc) : NaN;
  const resetAt = Number.isFinite(parsed) ? parsed : null;
  const s = snaps as Record<string, unknown>;
  const windows = [
    windowOf("chat", s.chat, resetAt, false),
    windowOf("premium", s.premium_interactions, resetAt, true),
  ].filter((w): w is UsageWindow => !!w);
  if (!windows.length) return null;
  return { source: "copilot", label: "Copilot", checkedAt: now, windows };
}

/** Why the last fetch said nothing, in words — for the one log line per cause. */
export type GhMiss = "gh-missing" | "gh-failed" | "not-json";

/**
 * Run `gh api /copilot_internal/user`. Null with the reason on anything but a parseable body: gh
 * missing (ENOENT), not signed in / non-2xx (gh exits non-zero), a timeout, or not JSON.
 */
export function fetchCopilotQuota(ghBin: string, timeoutMs = 8000): Promise<{ body: unknown } | { miss: GhMiss; detail: string }> {
  return new Promise((resolve) => {
    execFile(ghBin, ["api", "/copilot_internal/user"], { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        resolve(code === "ENOENT"
          ? { miss: "gh-missing", detail: `${ghBin} not found` }
          : { miss: "gh-failed", detail: String(stderr || err.message).trim().split("\n")[0]!.slice(0, 200) });
        return;
      }
      try { resolve({ body: JSON.parse(String(stdout)) }); }
      catch { resolve({ miss: "not-json", detail: "gh answered something that is not JSON" }); }
    });
  });
}
