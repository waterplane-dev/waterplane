/**
 * Copilot's monthly quota — premium requests and chat — read with the GitHub sign-in VS Code
 * already holds, parsed by the desktop app's own `parseCopilotQuota` (copilot-usage extension).
 *
 * Before any of that, the row shows what needs no sign-in: the plan and this month's requests
 * counted off this machine's Copilot Chat logs (`copilot-usage/host/vscodelocal.mts`, shared with the desktop), re-read every few
 * minutes from disk. The GitHub read is the extension's only network call, so it is OFF until
 * the person turns it on with the GitHub button at the top of All sessions › Copilot Chat; the choice is kept per machine. The endpoint (`/copilot_internal/user`) is GitHub's
 * internal one: a shape the parser does not know reads as absent, never as a guessed number.
 * A token is asked for silently on refresh; only the person's press of that button may raise VS Code's own
 * sign-in prompt.
 */
import * as vscode from "vscode";
import { BRAND } from "@waterplane/shared";
import type { UsageReading } from "@waterplane/shared";
import type { CopilotQuotaView } from "./protocol.js";
import { localLines, localWords } from "../../extensions/copilot-usage/host/vscodelocal.mts";
import type { CopilotLocalDoc, CopilotLocalReader } from "../../extensions/copilot-usage/host/vscodelocal.mts";
import { parseCopilotQuota } from "../../extensions/copilot-usage/host/ghquota.mts";

const ON_KEY = `${BRAND.slug}.copilotQuota`;
const URL = "https://api.github.com/copilot_internal/user";
/** Monthly windows move slowly; ten minutes is plenty and stays far from any rate limit. */
const EVERY_MS = 10 * 60_000;
/** The local count reads only files that moved since the last pass, so it can run more often. */
const LOCAL_EVERY_MS = 2 * 60_000;
const SCOPES = ["user:email"];

export interface QuotaState {
  on: boolean;
  reading: UsageReading | null;
  /** Why there is no reading, in words; null while one is shown or nothing was asked yet. */
  why: string | null;
  busy: boolean;
  /** The plan and this month's requests off this machine's files; null until the first read. */
  local: CopilotLocalDoc | null;
}

export class CopilotQuota implements vscode.Disposable {
  private st: QuotaState;
  private timer: NodeJS.Timeout | null = null;
  private localTimer: NodeJS.Timeout;

  constructor(private memo: vscode.Memento, private local: CopilotLocalReader, private onChange: () => void) {
    this.st = { on: memo.get<boolean>(ON_KEY, false), reading: null, why: null, busy: false, local: null };
    void this.readLocal();
    this.localTimer = setInterval(() => void this.readLocal(), LOCAL_EVERY_MS);
    if (this.st.on) { void this.read(false); this.arm(); }
  }

  private async readLocal(): Promise<void> {
    try { this.st.local = await this.local.read(); } catch { this.st.local = null; }
    this.onChange();
  }

  get state(): QuotaState { return this.st; }

  /** The GitHub button on All sessions › Copilot Chat: turn it on (first time), else read again. May raise VS Code's sign-in. */
  async click(): Promise<void> {
    if (!this.st.on) {
      this.st.on = true;
      await this.memo.update(ON_KEY, true);
      this.arm();
    }
    void this.readLocal();
    await this.read(true);
  }

  async turnOff(): Promise<void> {
    this.st = { on: false, reading: null, why: null, busy: false, local: this.st.local };
    await this.memo.update(ON_KEY, false);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onChange();
  }

  private arm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.read(false), EVERY_MS);
  }

  private async read(interactive: boolean): Promise<void> {
    if (this.st.busy) return;
    this.st.busy = true;
    this.onChange();
    try {
      const session = await vscode.authentication.getSession("github", SCOPES, interactive ? { createIfNone: true } : { silent: true })
        .then((s) => s, () => undefined);
      if (!session) {
        this.set(null, "Not signed in to GitHub in VS Code. Click to sign in; the quota is read with that sign-in.");
        return;
      }
      const res = await fetch(URL, {
        headers: { Authorization: `Bearer ${session.accessToken}`, Accept: "application/json", "User-Agent": BRAND.slug },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.set(null, res.status === 404 || res.status === 403
          ? `GitHub answered ${res.status}: this account (${session.account.label}) has no Copilot quota it will show.`
          : `GitHub answered ${res.status}; nothing was read.`);
        return;
      }
      const reading = parseCopilotQuota(await res.json());
      this.set(reading, reading ? null : "GitHub answered in a shape this version does not read, so no figure is shown.");
    } catch (e) {
      this.set(null, `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.st.busy = false;
      this.onChange();
    }
  }

  private set(reading: UsageReading | null, why: string | null): void {
    // A failed refresh keeps the last good reading on screen; its age is in the tooltip.
    this.st.reading = reading ?? this.st.reading;
    this.st.why = reading ? null : why;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    clearInterval(this.localTimer);
  }
}

/** What All sessions › Copilot Chat draws: the same state, with the local reading already in words. */
export function quotaView(st: QuotaState): CopilotQuotaView {
  return {
    on: st.on, busy: st.busy, reading: st.reading, why: st.why,
    local: st.local ? { words: localWords(st.local), lines: localLines(st.local) } : null,
  };
}
