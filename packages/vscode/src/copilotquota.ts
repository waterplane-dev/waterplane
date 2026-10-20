/**
 * Copilot's monthly quota — premium requests and chat — read with the GitHub sign-in VS Code
 * already holds, parsed by the desktop app's own `parseCopilotQuota` (copilot-usage extension).
 *
 * The extension's only network call, so it is OFF until the person turns it on from the tree
 * row; the choice is kept per machine. The endpoint (`/copilot_internal/user`) is GitHub's
 * internal one: a shape the parser does not know reads as absent, never as a guessed number.
 * A token is asked for silently on refresh; only the person's click may raise VS Code's own
 * sign-in prompt.
 */
import * as vscode from "vscode";
import { BRAND, usageWindowPct } from "@waterplane/shared";
import type { UsageReading } from "@waterplane/shared";
import { parseCopilotQuota } from "../../extensions/copilot-usage/host/ghquota.mts";

const ON_KEY = `${BRAND.slug}.copilotQuota`;
const URL = "https://api.github.com/copilot_internal/user";
/** Monthly windows move slowly; ten minutes is plenty and stays far from any rate limit. */
const EVERY_MS = 10 * 60_000;
const SCOPES = ["user:email"];

export interface QuotaState {
  on: boolean;
  reading: UsageReading | null;
  /** Why there is no reading, in words; null while one is shown or nothing was asked yet. */
  why: string | null;
  busy: boolean;
}

export class CopilotQuota implements vscode.Disposable {
  private st: QuotaState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private memo: vscode.Memento, private onChange: () => void) {
    this.st = { on: memo.get<boolean>(ON_KEY, false), reading: null, why: null, busy: false };
    if (this.st.on) { void this.read(false); this.arm(); }
  }

  get state(): QuotaState { return this.st; }

  /** The tree row's click: turn it on (first time), else read again. May raise VS Code's sign-in. */
  async click(): Promise<void> {
    if (!this.st.on) {
      this.st.on = true;
      await this.memo.update(ON_KEY, true);
      this.arm();
    }
    await this.read(true);
  }

  async turnOff(): Promise<void> {
    this.st = { on: false, reading: null, why: null, busy: false };
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

  dispose(): void { if (this.timer) clearInterval(this.timer); }
}

const WINDOW_NAME: Record<string, string> = { premium: "premium", chat: "chat" };

/** `premium 34% · chat 2%` — each window's used share; null when none has one. */
export function quotaWords(r: UsageReading): string | null {
  const bits = r.windows.flatMap((w) => {
    const pct = usageWindowPct(w);
    return pct == null ? [] : [`${WINDOW_NAME[w.id] ?? w.id} ${Math.round(pct)}%`];
  });
  return bits.length ? bits.join(" · ") : null;
}

/** The tooltip: each window with its count, the reset date, when it was read. */
export function quotaTooltip(st: QuotaState): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const r = st.reading;
  if (r) {
    for (const w of r.windows) {
      const pct = usageWindowPct(w);
      const count = w.used != null && w.limit != null ? ` (${w.used} of ${w.limit} ${w.unitName ?? ""})`.replace(" )", ")") : "";
      md.appendText(`${w.id === "premium" ? "Premium requests" : "Chat"}: ${pct == null ? "no share given" : `${Math.round(pct)}% used`}${count}\n\n`);
    }
    const reset = r.windows.find((w) => w.resetAt)?.resetAt;
    if (reset) md.appendText(`Resets ${new Date(reset).toLocaleDateString()}.\n\n`);
    md.appendText(`Read ${new Date(r.checkedAt).toLocaleTimeString()} from GitHub with your VS Code sign-in.\n\n`);
  }
  if (st.why) md.appendText(`${st.why}\n\n`);
  md.appendText(st.on
    ? "Click to read again. Re-read every 10 minutes while on."
    : "Off. Click to read Copilot's monthly quota from GitHub with your VS Code GitHub sign-in — the extension's only network call.");
  return md;
}
