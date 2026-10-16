/**
 * The billing profile, host-side: which kind of account this desktop's `claude`
 * bills to (`@waterplane/shared`'s `billing.ts` is the pure classification).
 *
 * This half owns the three things the rule cannot: READING the facts (the
 * environment, `apiKeyHelper` in claude's settings, `claude auth status`), the
 * person's override on disk, and the broadcast when the answer moves.
 *
 * The probe is cheap and cached. The environment and the settings file are read
 * on every `refresh()`; `claude auth status` spawns the CLI, so it runs once at
 * startup, on demand (`billing.get` with nothing probed yet, or a stale answer
 * the caller asks to redo) and never per request. It has a timeout, and a
 * failure is `authStatus: null` - the classifier then decides from the rest, or
 * says `unknown`. **Until the first probe has finished the answer is `unknown`**:
 * a key in the environment beside a claude.ai login is `unknown` too, and
 * guessing `api` for the seconds before we know would stop the `/usage` poll a
 * subscription needs.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanBillingSetting, resolveBilling, type BillingProbe, type BillingStatus } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { claudeConfigDir } from "./claudeconfig.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** `claude auth status` may take a moment (it can touch the keychain); past this it is "could not tell". */
export const AUTH_STATUS_TIMEOUT_MS = 8_000;
/** A probed answer is believed this long before a caller that asks may redo it. */
export const PROBE_TTL_MS = 6 * 3_600_000;
/** A probe that read NO auth text (timeout, spawn failure) is redone after this, when a caller asks. */
export const PROBE_RETRY_MS = 5 * 60_000;

const truthy = (v: string | undefined): boolean => !!v && !/^(0|false|no|off)$/i.test(v.trim());

/** The environment's half of the probe. Pure over `env`, so a test hands it one. */
export function envFacts(env: NodeJS.ProcessEnv): Pick<BillingProbe, "apiKeyEnv" | "cloudEnv"> {
  return {
    apiKeyEnv: !!(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()),
    cloudEnv: truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) || truthy(env.CLAUDE_CODE_USE_FOUNDRY),
  };
}

/** Does claude's user settings (either file) carry an `apiKeyHelper`? An unreadable file is "no". */
export function apiKeyHelperIn(dir: string): boolean {
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (typeof j.apiKeyHelper === "string" && j.apiKeyHelper.trim()) return true;
    } catch { /* absent or unparsable: not a signal */ }
  }
  return false;
}

export interface BillingDeps {
  /** `claude auth status` stdout+stderr, or null when it could not be run / timed out. */
  authStatus: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  /** claude's config dir (settings.json lives here). */
  configDir?: () => string;
  now?: () => number;
  /** Told whenever the resolved status changes. */
  onChange?: (s: BillingStatus) => void;
}

export class BillingStore {
  private path: string;
  private setting: ReturnType<typeof cleanBillingSetting> = null;
  private facts: BillingProbe | null = null;
  private probedAt = 0;
  private inflight: Promise<BillingStatus> | null = null;
  private lastKey = "";

  constructor(root: string, private deps: BillingDeps) {
    this.path = join(hostStateDir(root), "billing.json");
    const raw = readJsonGuarded<{ profile?: unknown }>(this.path, {});
    this.setting = cleanBillingSetting(raw?.profile);
    this.lastKey = this.key(this.status());
  }

  private key = (s: BillingStatus): string => `${s.profile}:${s.source}`;

  /** The answer right now: a setting wins; else the last probe; else `unknown` (never probed). */
  status(): BillingStatus {
    return resolveBilling(this.setting, this.facts);
  }

  /** The person's override: a profile, or null to hand it back to the probe. */
  setOverride(profile: unknown): BillingStatus {
    this.setting = cleanBillingSetting(profile);
    try { writeJsonAtomic(this.path, this.setting ? { profile: this.setting } : {}, { space: 2 }); } catch { /* a lost preference is not worth the daemon */ }
    return this.settle();
  }

  /**
   * Probe again. The cheap facts are re-read every time; `claude auth status`
   * runs only when never probed or past `PROBE_TTL_MS` (or `force`). Concurrent
   * callers share one run. Never throws.
   */
  refresh(force = false): Promise<BillingStatus> {
    const now = (this.deps.now ?? Date.now)();
    if (!force && this.facts && now - this.probedAt < (this.facts.authStatus === null ? PROBE_RETRY_MS : PROBE_TTL_MS)) return Promise.resolve(this.status());
    this.inflight ??= (async () => {
      const env = this.deps.env ?? process.env;
      let authStatus: string | null = null;
      try { authStatus = await this.deps.authStatus(); } catch { authStatus = null; }
      const dir = (this.deps.configDir ?? claudeConfigDir)();
      this.facts = { ...envFacts(env), apiKeyHelper: apiKeyHelperIn(dir), authStatus };
      this.probedAt = (this.deps.now ?? Date.now)();
      return this.settle();
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Has the first probe finished? Callers that must not act on a guess ask. */
  probed(): boolean { return this.facts !== null; }

  /** What the last probe read, for the doctor and tests. */
  lastProbe(): BillingProbe | null { return this.facts; }

  private settle(): BillingStatus {
    const s = this.status();
    const k = this.key(s);
    if (k !== this.lastKey) { this.lastKey = k; this.deps.onChange?.(s); }
    return s;
  }
}


/**
 * `claude auth status`, run for real: stdin closed, a timeout that kills it, output
 * capped. A non-zero exit still carries text worth classifying (signed out), so the
 * output is returned either way; a spawn failure or a timeout with nothing printed is null.
 */
export function runAuthStatus(bin: string, timeoutMs = AUTH_STATUS_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, ["auth", "status"], { timeout: timeoutMs, maxBuffer: 64 * 1024, env: process.env }, (err, stdout, stderr) => {
        const out = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        resolve(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed ? null : out || null);
      });
      child.stdin?.end();
      child.on("error", () => resolve(null));
    } catch { resolve(null); }
  });
}
