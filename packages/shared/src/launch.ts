/**
 * A session that is supposed to open, held by the HOST until the files its
 * first prompt names have actually landed.
 *
 * The failure this exists for: "open a session in this repo and look at
 * `.claude/inbox/shot.jpg`" is assembled on the PHONE. The bytes are parked in
 * the send queue, the create op is parked behind them in the same lane, and the
 * whole plan lives in one browser tab on a device with a bad tunnel. If the
 * upload cannot get through inside the client's 30-minute queue TTL, the upload
 * fails, everything naming that path is failed with it, and the host — which is
 * the machine that will actually do the work, and the one that is not on a
 * train — never learned that any of it was supposed to happen.
 *
 * So the INTENT is handed over as early as it can be: the moment the create op
 * reaches the host, whether or not the picture has. The host writes it down,
 * persists it across restarts, and from then on it is the host that decides
 * when the session opens. The phone may go into a tunnel, be killed by the OS,
 * or be closed for the night; the launch still happens the moment the last file
 * arrives, because nothing about it depends on that tab any more.
 *
 * The rule is pure and lives here so both ends agree on it (the queue sheet has
 * to be able to say WHY a launch has not fired without asking) and so
 * `scripts/e2e-launchwait.mjs` can pin it directly.
 *
 * At-most-once is by INTENT ID, which is the create op's own ackId: a replayed
 * op upserts the row rather than adding a second one, exactly as
 * `schedule.save` does. The host writes the "opening" state BEFORE it spawns,
 * so a crash between the two can never open the session twice.
 */

import type { Effort, LaunchOpts, PermissionMode } from "./wire/session.js";

/**
 * How long a launch may wait for its files before the host gives up.
 *
 * Deliberately much longer than the client's `QUEUE_TTL_MS` (30 min): the whole
 * point of the handover is that the phone's clock stops mattering. Six hours
 * covers a commute, a flight, and a night with the laptop shut — and it still
 * ends, because a session opened tomorrow against a photo taken today is a
 * surprise, not a feature.
 */
export const LAUNCH_WAIT_MS = 6 * 60 * 60_000;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const PERM_MODES: readonly PermissionMode[] = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"];
/** A model id or alias is one printable token — `opus`, `claude-opus-5[1m]`,
 *  `ollama/qwen3-coder:30b`. A space or a control character is not a model. */
const MODEL_RE = /^[\w.:/@[\]+-]{1,120}$/;
const BACKEND_RE = /^[\w.-]{1,64}$/;

/**
 * **A launch somebody chose, as it may be STORED** — on a deferred row
 * (`Intent.launch`), a schedule's action, a `backlog.add`.
 *
 * A `session.create` spends its launch at once; a row keeps it for days and
 * every tick re-reads it off disk, so the opts are rebuilt from the five fields
 * `LaunchOpts` names and nothing else rides along. A field that is not one of
 * them, or not a value the CLI would take, is DROPPED rather than guessed at —
 * a dropped field is the new-session default, which is what absent always
 * meant. All five gone ⇒ `undefined`: an empty object is not a choice.
 *
 * It does not decide whether the BACKEND exists; that is the host's
 * `resolveBackend` at spawn time, which refuses in words.
 */
export function cleanLaunchOpts(v: unknown): LaunchOpts | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: LaunchOpts = {};
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (MODEL_RE.test(model)) out.model = model;
  if (EFFORTS.includes(r.effort as Effort)) out.effort = r.effort as Effort;
  if (PERM_MODES.includes(r.permissionMode as PermissionMode)) out.permissionMode = r.permissionMode as PermissionMode;
  if (r.remoteControlled === true) out.remoteControlled = true;
  const backend = typeof r.backend === "string" ? r.backend.trim() : "";
  if (BACKEND_RE.test(backend)) out.backend = backend;
  return Object.keys(out).length ? out : undefined;
}

export type LaunchState =
  /** Files outstanding. Nothing has been spawned. */
  | "waiting"
  /** The gate opened and the session is being made. Written BEFORE the spawn. */
  | "opening"
  /** The session exists and the first prompt was handed to `deliverPrompt`. */
  | "done"
  /** It will never open: the deadline passed, or the spawn itself failed. */
  | "failed"
  /** The user called it off from the phone. */
  | "canceled";

/**
 * One parked "open a session here and run this".
 *
 * Carries everything `session.create` carries, because that is precisely what
 * it is: a create that has not been allowed to happen yet. Storing the fields
 * rather than the message keeps the persisted file readable and stops a wire
 * type change from silently rewriting rows that are already on disk.
 */
export interface LaunchIntent {
  /** The create op's ackId. Upsert key — a replayed op must not park twice. */
  id: string;
  cwd: string;
  /** For the UI, so a waiting row can name its repo with no listing loaded. */
  repoName?: string;
  /** The first prompt, typed once the session is up. May be empty (a bare open
   *  that still wants to wait for files someone else's prompt will use). */
  prompt: string;
  /** Repo-relative paths that must exist before this may open. */
  needs: string[];
  createdAt: number;
  /** Ms-epoch after which `waiting` becomes `failed`. Absolute, not a duration:
   *  a host restart must not restart the clock. */
  deadlineAt: number;
  state: LaunchState;
  /** Set when the gate opened. */
  sessionId?: string;
  /** The subset of `needs` still absent at the last check — what the row says. */
  missing?: string[];
  /** Why it is `failed`/`canceled`, in the words the phone shows. */
  reason?: string;
  openedAt?: number;
  settledAt?: number;
  // ── The create's own options, passed through verbatim ──
  cols?: number;
  rows?: number;
  title?: string;
  launch?: unknown;
  replaceSessionId?: string;
}

/** A repo-relative path that stays inside the repo. Rejects absolute paths,
 *  `..` segments and backslash separators (a Windows-ish path would be one
 *  opaque filename here, which is not what the sender meant). */
export function safeRel(p: string): boolean {
  const s = p.trim();
  if (!s || s.startsWith("/") || s.includes("\\") || s.includes("\0")) return false;
  return !s.split("/").some((seg) => seg === ".." || seg === ".");
}

/** One line for the row: what it is waiting for, in the user's terms. */
export function describeLaunch(i: LaunchIntent): string {
  const names = (i.missing?.length ? i.missing : i.needs).map((p) => p.split("/").pop() || p);
  switch (i.state) {
    case "waiting":
      return names.length === 1
        ? `waiting for ${names[0]} to finish uploading`
        : `waiting for ${names.length} files to finish uploading`;
    case "opening": return "opening the session…";
    case "done": return "opened";
    case "canceled": return i.reason || "called off";
    default: return i.reason || "did not open";
  }
}
