/**
 * The BILLING PROFILE - which kind of account this desktop's `claude` bills to.
 *
 * Everything usage-shaped here began as a subscription: two rolling windows
 * scraped off `/usage`. An API-key or cloud account has neither, and showing it
 * `?` chips and an empty weekly card is a lie by omission. The profile says which
 * model of "budget" applies.
 *
 * The probe itself (env, `~/.claude/settings.json`, `claude auth status`) is the
 * HOST's; this module is the pure classification both ends can test. **Ambiguous
 * or silent input is `unknown`, never a guess** - and `unknown` shows nothing.
 * Local / endpoint backends are not the account profile and are not asked here.
 */

export type BillingProfile = "subscription" | "api" | "cloud" | "unknown";
export type BillingSource = "probe" | "setting";

export interface BillingStatus {
  profile: BillingProfile;
  /** `setting`: the person said so and it wins. `probe`: detected. */
  source: BillingSource;
}

/** What the host managed to read. Every field optional; absent = "could not tell". */
export interface BillingProbe {
  /** `ANTHROPIC_API_KEY` (or auth token) is set in the claude process env. */
  apiKeyEnv?: boolean;
  /** claude settings carry an `apiKeyHelper`. */
  apiKeyHelper?: boolean;
  /** `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` truthy. */
  cloudEnv?: boolean;
  /** Raw output of `claude auth status`, if it ran. */
  authStatus?: string | null;
}

const SUB = /claude\.ai|claude\s+(?:pro|max|team|enterprise)\b|\b(?:pro|max)\s+(?:plan|account|subscription)\b|\bsubscription\b/i;
const API = /\bapi[\s_-]?key\b|anthropic\s+console|\bconsole\b/i;

/** What an auth-status text names: `subscription`, `api`, both (`conflict`) or nothing. */
export function authStatusKind(text: string | null | undefined): "subscription" | "api" | "conflict" | null {
  if (!text) return null;
  const s = SUB.test(text);
  const a = API.test(text);
  return s && a ? "conflict" : s ? "subscription" : a ? "api" : null;
}

/**
 * Classify one probe. Cloud env wins over a key (the CLI routes to the cloud
 * whatever else is set) but not over a claude.ai login (a conflict: unknown).
 * A key/helper alongside a claude.ai login is also unknown - which one the CLI
 * bills depends on state we did not read.
 */
export function classifyBilling(p: BillingProbe | null | undefined): BillingProfile {
  if (!p) return "unknown";
  const auth = authStatusKind(p.authStatus);
  if (auth === "conflict") return "unknown";
  const key = p.apiKeyEnv === true || p.apiKeyHelper === true;
  if (p.cloudEnv === true) return auth === "subscription" ? "unknown" : "cloud";
  // A key beside a probe that RAN and said nothing (`authStatus: null`: timed out, spawn failed) could be
  // sitting next to a claude.ai login - which one is billed was not read, so it is not guessed.
  if (key) return auth === "subscription" || p.authStatus === null ? "unknown" : "api";
  if (auth === "subscription") return "subscription";
  if (auth === "api") return "api";
  return "unknown";
}

export function isBillingProfile(v: unknown): v is BillingProfile {
  return v === "subscription" || v === "api" || v === "cloud" || v === "unknown";
}

/** A stored override, read strictly: a real profile other than `unknown`, else null. */
export function cleanBillingSetting(v: unknown): Exclude<BillingProfile, "unknown"> | null {
  return v === "subscription" || v === "api" || v === "cloud" ? v : null;
}

/** The status the host reports: a setting wins; otherwise the probe. */
export function resolveBilling(setting: unknown, probe: BillingProbe | null | undefined): BillingStatus {
  const s = cleanBillingSetting(setting);
  return s ? { profile: s, source: "setting" } : { profile: classifyBilling(probe), source: "probe" };
}

/** Does this profile have the scraped session/weekly windows? `unknown` is
 *  treated as yes: today's behaviour is the fallback, never a new guess. */
export const hasScrapedWindows = (p: BillingProfile | null | undefined): boolean => p == null || p === "subscription" || p === "unknown";
