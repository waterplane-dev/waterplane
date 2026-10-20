/**
 * The session manager's module constants — every tunable `sessions.ts` and its
 * slices read, and every `WATERPLANE_*` env knob among them, moved verbatim out of
 * the facade (docs/notes/host-architecture.md, package S1).
 *
 * Constants only: no class, and no function but `defaultTmuxServer` (the tmux
 * socket's derivation, evaluated once below) and the one-liners `tmuxName` and
 * `tmuxLiteral` (here so every slice may use it: a slice imports no slice) —
 * nothing that runs but the env reads themselves. Those still happen at IMPORT,
 * exactly once, exactly as they did inline — the facade imports this module
 * LAST among its imports, so it is evaluated immediately before the facade's own
 * body, where these lines used to sit. A slice reads its knobs from here, never from `process.env` itself.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LimitLogVerdict } from "../limitlog.js";
import { BRAND } from "@waterplane/shared";
import { ROOT, env } from "../env.js";

// Which binary a session spawns is asked of its DESCRIPTOR at spawn time
// (`spawnBackend`), not captured once at import: with two backends there is no
// single "the binary" to hold in a module const, and `backends/claude.ts` is
// still the ONE place `WATERPLANE_CLAUDE_BIN` is spelled out.
export const SCROLLBACK_LIMIT = 256 * 1024;
export const HISTORY_LIMIT = 200;            // entries kept per session
export const OUTPUT_CAP = 16 * 1024;         // cleaned output bytes stored per entry
export const RAW_CAPTURE_CAP = 128 * 1024;   // raw (still-ANSI) bytes buffered per turn
export const NAME_INPUT_CHARS = 1000;        // how much of the FIRST prompt the tab-name call is shown
export const RENAME_RECENT_PROMPTS = 4;      // later prompts a HAND-ASKED rename is also shown
export const RENAME_RECENT_CHARS = 400;      // …each clipped to this
/**
 * The tab-name call runs on the CHEAPEST thing that can do it, with none of the
 * context a coding session needs — because it is not a coding session.
 *
 * Measured on this host, one call, same transcript:
 *
 *   opus + project settings + tools    83,529 tok   (what this used to be)
 *   haiku + project settings + tools   70,690
 *   haiku, user settings only          27,642   <- the project CLAUDE.md, gone
 *   haiku, user settings, no tools      9,025   <- the default system prompt, gone
 *   haiku, user settings, no tools,
 *     own system prompt                 1,867   <- 45x
 *
 * Each flag removes something this task provably does not use. `--setting-sources
 * user` drops the project's own `CLAUDE.md` — 37k tokens of repo rules, loaded to
 * paraphrase a terminal screen. `--tools ""` drops the tool definitions: the
 * transcript is already IN the prompt and there is nothing to go and read.
 * `--system-prompt` replaces Claude Code's own, which is the agent harness for a
 * job that is one sentence of prose. Quality did not drop — on the same input the
 * cheap run produced a better summary than the expensive one.
 */
export const SUMMARY_MODEL = env("SUMMARY_MODEL") || "haiku";
/**
 * The ≤4-word tab name, and what it is asked ABOUT.
 *
 * The cheapest call in the daemon, by construction: its whole input is the
 * session's FIRST PROMPT (≤ `NAME_INPUT_CHARS`), never the screen, a summary or
 * a later prompt. Same model, same three flags, so it inherits every
 * measurement above; it is one call PER SESSION, once. (The per-turn AI summary
 * these measurements were taken on is gone — this is the only unattended call
 * of its kind left.)
 *
 * No thinking is asked for and none is useful: naming four words off one
 * prompt is a compression, not a decision, and a model that reasons about it
 * spends tokens to arrive at the same label.
 *
 * FOUR and not three because the tab is not the only place these words are
 * read: the session screen shows them in full when you open it, where a fourth
 * word is the difference between a category and a description. The tab clips to
 * its own width either way.
 */
export const TAB_TITLE_SYSTEM = "You name things in at most four words. Output only the name.";
export const TAB_TITLE_PROMPT =
  "Name what this coding session is about, from the opening prompt the person sent it, " +
  "in at most 4 words (max 30 characters). " +
  "Lower case, no punctuation, no quotes, no preamble — output only the name. " +
  "If the prompt asks for no real work (a greeting, a bare command), output exactly: (none).";
/**
 * The hand-asked rename (`record.nameNow`) — the sparkle on the session header.
 * A person taps it because the name the opening prompt bought no longer says
 * what the session is DOING, so the opening prompt alone is the one input that
 * cannot answer it: a session opened on "continue" or a bare command came back
 * "(none)" every time. It is shown the opening prompt plus the last few, the
 * recent ones weighing most. Still toolless, still prompts only — never the
 * screen or output — and bounded to ~3k characters.
 */
export const RENAME_PROMPT =
  "Name what this coding session is working on NOW, from the prompts the person sent it, " +
  "in at most 4 words (max 30 characters). The most recent prompts weigh most; the opening " +
  "prompt is context. Lower case, no punctuation, no quotes, no preamble — output only the name. " +
  "If none of the prompts asks for real work, output exactly: (none).";
// The Remote Control banner prints a "Continue ... at <url>" line.
export const REMOTE_URL_RE = /https?:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/;

export const PROMPT_CHECK_MS = 600;          // quiet time before we test for a prompt
export const PROMPT_MAX_STALE_MS = 1200;     // ceiling: a check runs even under constant output
export const PROMPT_MISS_MAX = 3;            // failed strict parses tolerated while a dialog is still up
/**
 * How soon a strict pass that read a NEW box (or a change to the published
 * one) looks again before publishing it. A box is published only once two
 * consecutive reads agree (`boxes.ts`'s `readTwice`): tmux hands its client a
 * screen in chunks, and a read between two of them is a box cut mid-label —
 * which `mergeBox`, never rewriting a published label, then kept for the life
 * of the box. Short, because it is added to every box's first appearance;
 * long enough to span the gap between two chunks of one paint.
 */
export const PROMPT_SETTLE_MS = 300;
/**
 * How long after a resize a capture is presumed half-drawn.
 *
 * Generous on purpose: the cost of being wrong here is that a box which really
 * did close stays published for one extra check (it is retired the moment the
 * screen carries no dialog footer, which needs no budget at all), and the cost
 * of being too tight is the blink this constant exists to stop. Two checks'
 * worth.
 */
export const RESIZE_REPAINT_MS = 1500;
export const PROMPT_GATE_BYTES = 12000;      // byte window the cheap prompt gate scans
// Tail read for the prose-question check. The agent's closing lines, not the
// whole turn: `questionWindow` keeps the last 8 content rows, and a wrapped
// paragraph on a phone-width pane is a lot of rows.
export const QUESTION_TAIL_BYTES = 4000;
// Walking the cursor onto a checkbox box's Submit row: passes over the rendered
// screen, keys per pass, and the repaint window between them. Bounded because
// every one of these is a keystroke into a live TUI.
export const SUBMIT_NAV_TRIES = 6;
export const SUBMIT_NAV_MAX_KEYS = 8;
export const SUBMIT_NAV_LINES = 60;
export const SUBMIT_NAV_SETTLE_MS = 160;
// `session.mode` (livemode.ts): shift+tabs per walk — the measured cycle is at most
// five modes long — how long one press may take to move the footer, and how
// often the live grid is re-read meanwhile (a buffer read, not a replay).
export const MODE_MAX_PRESSES = 6;
export const MODE_PRESS_WAIT_MS = 1500;
export const MODE_POLL_MS = 60;
/**
 * Placing the selection on an UNNUMBERED option (`choosePromptBox`), and the
 * rows an attributed replay reads back for it.
 *
 * One key per pass, so the tries are the steps: three options measured, and the
 * ring wraps, so two moves is the worst case and the rest is headroom for a
 * repaint that swallowed one. The settle is longer than the checkbox walk's
 * because opencode's repaint lag was measured between 0.3 s and 2 s, and a
 * re-read taken before the redraw lands reads the OLD armed option — which
 * would walk the selection straight past the one that was asked for.
 */
export const CHOOSE_NAV_TRIES = 8;
export const CHOOSE_NAV_SETTLE_MS = 400;
/** Rows of the grid an attributed replay reads back. The dialog is drawn at the
 *  bottom of an alternate screen that is exactly the terminal's height, so this
 *  only has to cover a tall box plus the rows it is anchored against. */
export const PROMPT_CELL_ROWS = 60;
export const IDLE_PING_MS = Number(env("IDLE_PING_MS") || 4000); // quiet ⇒ "turn done"

/**
 * How long a `Stop` hook is treated as a CLAIM before it is believed.
 *
 * A Stop hook is not the end of a turn — it is the CLI asking whether the turn
 * may end. A hook that answers "no" (`decision: block`, which is how every
 * keep-going loop is built: a /goal hook, a checklist driver, anything that
 * feeds work back in) makes the CLI carry straight on with NO
 * `UserPromptSubmit` to follow, because no prompt was submitted — the
 * continuation arrives in the conversation as a meta message. So the exact
 * signal fires, the turn does not end, and this host believed it: a session
 * spinning "✻ Crafting… (9m 35s · ↓ 34.5k tokens)" published
 * `turnActive: false`, the reader said "idle — nothing running" over a live
 * turn, and the queue typed a prompt into it that was never confirmed and had
 * to be retried four times.
 *
 * So the Stop is settled against the screen a moment later: the CLI's own
 * working line (`shared/working.ts`, the same matcher the phone's reader uses)
 * printed AFTER the Stop is the one thing that can contradict it. Nothing is
 * recorded on the health board for this — the hook did not fail, it was
 * answered, and a signal that reads "broken" for every session with a
 * keep-going hook is a permanent amber nobody reads.
 *
 * 0 disables the check: the Stop is believed immediately, as it was.
 */
export const STOP_VERIFY_MS = Number(env("STOP_VERIFY_MS") || 1200);
/** Ceiling on the bytes one settle pass scans. The window is normally "what the
 *  CLI printed since the last pass" (one repaint); the cap is only there so a
 *  session that dumped a megabyte in that gap costs a regex over the tail of it
 *  and not over the whole ring. */
export const STOP_VERIFY_BYTES = 64_000;

// ── CLI-health observation gates (see `clihealth.ts`) ───────────────────
/**
 * How long after a spawn the hook pipe and the conversation log are allowed to
 * be missing without it counting against them.
 *
 * Both are legitimately absent for the first seconds of a session's life: the
 * `SessionStart` hook is a curl that has to run, and the CLI writes its
 * conversation log when it accepts the first prompt. Without this grace every
 * fresh session would record one fallback for each — a steady drip of misses
 * that says nothing except "sessions start", and one that would drag both
 * signals to `degraded` on an ordinary busy morning.
 *
 * Env-settable because it is the one health rule an e2e cannot wait out: a
 * minute per assertion is a minute per assertion, so the rule that a fresh
 * session records nothing went unchecked, and the rule NEXT to it — that a
 * re-attached session records nothing either — shipped wrong (see
 * `noteHookFallback`). A knob nobody sets in production is cheaper than a rule
 * nobody tests.
 */
export const HEALTH_SPAWN_GRACE_MS = Number(env("HEALTH_GRACE_MS") || 60_000);
/** Rows of a rendered screen kept as a `line` sample. Enough to hold a dialog's
 *  footer and the option rows above it, which is what a stale matcher is read
 *  against; the redaction and the 240-char cap do the rest. */
export const HEALTH_SAMPLE_ROWS = 6;

// ── auto-continue on usage limit ────────────────────────────────────────
// When a session is blocked and the banner named a reset time, the continue
// fires at reset + BUFFER. Without a parseable time it retries every RETRY_MS
// (a rejected attempt just re-renders the banner). ATTEMPTS caps runaway loops.
export const LIMIT_RETRY_MS = Number(env("LIMIT_RETRY_MS") || 10 * 60_000);
export const LIMIT_RESET_BUFFER_MS = Number(env("LIMIT_RESET_BUFFER_MS") || 2 * 60_000);
/** The verdict when there is nothing to read — never a claim, see `limitlog.ts`. */
export const LIMIT_LOG_UNKNOWN: LimitLogVerdict = { state: "unknown", rejectedAt: null, resetAt: null, weekly: false, spend: false, servedAt: null, clearedBy: null };
/**
 * Churn guard, and ONLY that.
 *
 * It used to be the thing that ended a wait, which is why every weekly wall
 * gave up on the afternoon it started: 24 attempts on a ten-minute cadence is
 * under four hours against a window that resets days later. `limitretry.ts`
 * widens the delay instead, so the same cap now spans days — and how long a
 * wall may last is `LIMIT_GIVEUP_MS`'s question, not this one. Raised with the
 * ladder because a week of six-hourly attempts is ~30 of them.
 */
export const LIMIT_MAX_ATTEMPTS = Number(env("LIMIT_MAX_ATTEMPTS") || 64);
/**
 * How long one continuous block may last before this desktop stops waiting.
 *
 * Eight days: a weekly window is seven, so the bound is "a window and a bit"
 * rather than a number picked to feel patient. Past it the session is left
 * closed and says so — `gaveup` — which is the honest end of a wait nobody can
 * see the end of.
 */
export const LIMIT_GIVEUP_MS = Number(env("LIMIT_GIVEUP_MS") || 8 * 24 * 3_600_000);
/**
 * How long a reopened conversation may take to re-hit the wall it was reopened
 * into and still count as the SAME block (`Session.limitCarried`).
 *
 * A resurrection that lands on a live wall re-blocks within seconds. Five
 * minutes is that with room to spare, and short enough that a session which
 * came back, worked, and met a fresh wall later is treated as what it is.
 */
export const LIMIT_CARRY_MS = Number(env("LIMIT_CARRY_MS") || 5 * 60_000);
/** The first rung of the backoff, shortened only by tests that cannot sit one
 *  out (`limitretry.ts`'s `probeMs`). */
export const LIMIT_PROBE_MS = Number(env("LIMIT_PROBE_MS") || 0);
/** …and the whole ladder, for the tests that cannot sit out the rungs behind the
 *  first either. Empty (the default) means `limitretry.ts`'s own. */
export const LIMIT_LADDER_MS: number[] = (env("LIMIT_LADDER_MS") || "")
  .split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
export const LIMIT_SWEEP_MS = Number(env("LIMIT_SWEEP_MS") || 60_000);
/** How often the running-agent list is re-read while any agent is running. A
 *  readdir plus a stat per agent, and armed only while there is something to
 *  re-read — see `checkAgents`. */
export const AGENT_POLL_MS = Number(env("AGENT_POLL_MS") || 5000);
/** How many submitted prompts a session remembers. A delivery asks about the
 *  seconds it has just been waiting through, and a turn takes minutes — this is
 *  a short queue against a race, not a history (the transcript is that). */
export const SUBMIT_RING = 8;
/** How long a turn must have been IN FLIGHT before it counts as the account
 *  serving this session again. A rejected turn dies in seconds — the wall is
 *  the CLI's answer to it — so a turn still running well past that is the one
 *  dated fact a screen scan cannot argue with. */
export const SERVING_TURN_MS = Number(env("LIMIT_SERVING_MS") || 30_000);
// Sessions do not hit the limit one at a time — a plan limit is an ACCOUNT fact,
// so every session working at that moment blocks on it and parses the SAME reset
// instant out of the same banner. Firing them all at once is therefore the
// normal case, and it is self-defeating: they race for a window one of them will
// consume, the rest re-block, and each spends one of its bounded ATTEMPTS
// proving what the first already proved. So the FIRST resume of a wave is always
// alone — the probe — and the next one is released once it provably started a
// turn or came back still blocked. What happens AFTER the probe succeeds is the
// release mode (`LimitResumeMode`, persisted): `one` keeps waiting for each
// verdict, `repo` allows one resume per worktree at a time, `all` releases
// everything waiting. GAP is the breath between two resumes — a rate limit that
// applies in every mode; SETTLE is the watchdog for the case neither outcome is
// observable (a non-hooked session that simply says nothing after being typed
// into).
export const LIMIT_RESUME_GAP_MS = Number(env("LIMIT_RESUME_GAP_MS") || 8_000);
export const LIMIT_RESUME_SETTLE_MS = Number(env("LIMIT_RESUME_SETTLE_MS") || 90_000);

export const CLAUDE_ID_POLL_MS = 5_000;   // how often to look for a not-yet-known conversation id
export const CLAUDE_ID_POLL_MAX = 60;     // give up after ~5 min (a final attempt runs at close)

/**
 * How stale a per-session file must be before the orphan sweep may delete it.
 *
 * Load-bearing, but for a narrower case than it looks. The alive set is the live
 * session map UNION the `live/` store's filenames (`aliveSessionIds`) — there is
 * no `tmux ls` in it. So what the age gate actually protects is a file whose
 * session was ACTIVE RECENTLY while the alive set was momentarily short: a boot
 * that crashed before `rediscover()` populated the map, a root mounted late.
 *
 * It does NOT protect a live tmux session that has been idle longer than the gate
 * — this host accumulates those — because such a file is past the gate AND, if
 * the map is empty, absent from it. The only thing standing between that session
 * and a delete is the `live/` read succeeding, which is why `aliveSessionIds`
 * distinguishes "no live store" from "the live store could not be read" and the
 * sweep declines to run at all on the second.
 *
 * Seven days is far shorter than the leak it exists to bound: measured here, 436
 * history files and 98 summaries against ~107 live sessions.
 */
export const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Boot is not the moment to walk two directories; the sweep is deferred behind
 *  this on an unref'd timer, so it can also never hold the process open. */
export const ORPHAN_SWEEP_DELAY_MS = 30_000;
/** A store file is `<sessionId>.json` and a session id is a uuid prefix. Anything
 *  else is refused and left alone rather than sanitised — `archive.ts`'s
 *  `deleteArchived` regex, for the same reason: this function deletes. */
export const STORE_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/;

// ── tmux session substrate (the ONE substrate) ───────────────────────────────
// Each claude runs inside a tmux session on a PRIVATE tmux server (-L <brand tmuxServer>, so
// it never collides with the user's own tmux). The node-pty we hold is only a
// tmux *client* — a viewport. The tmux server daemonizes (reparented to init),
// so it outlives the host: a host restart detaches the client instead of killing
// claude, and rediscover() re-attaches every live session on boot. REQUIRED
// (`tmuxreq.ts`): a missing binary refuses the spawn in words. There is no
// direct-PTY mode; the retired `TMUX` knob is ignored (doctor says so).
// -L socket name. Explicit override always wins. Otherwise the canonical root
// gets the stable brand socket, but a THROWAWAY root (under the OS tmpdir —
// i.e. an e2e host on a mkdtemp ROOT) gets a unique socket derived from its
// path. The tmux server is keyed by socket name, NOT by ROOT, so without this a
// test host would spawn its stub sessions onto the
// real brand server; those daemonized panes outlive the test and the real host
// then adopts them on boot (rediscover). Deriving the socket from a temp ROOT
// keeps test sessions on their own server, so they can never leak into the real
// UI. Stable per ROOT ⇒ a given host still finds its own sessions across restarts.
function defaultTmuxServer(): string {
  const explicit = env("TMUX_SERVER");
  if (explicit) return explicit;
  const root = ROOT; // env.ts' — the daemon's own root, one definition of its default
  // Both spellings of the temp dir: macOS's `/var/folders/…` is `/private/var/…`
  // once resolved, and a root a test realpath'd (`bootHost({ home: true })`)
  // must still count as throwaway.
  const tmps = new Set([resolve(tmpdir())]);
  try { tmps.add(realpathSync(tmpdir())); } catch { /* unresolvable: the plain spelling stands */ }
  if ([...tmps].some((tmp) => root === tmp || root.startsWith(tmp + "/"))) {
    return BRAND.tmuxServer + "-" + createHash("sha1").update(root).digest("hex").slice(0, 8);
  }
  return BRAND.tmuxServer;
}
export const TMUX_SERVER = defaultTmuxServer();
export const TMUX_PREFIX = `${BRAND.tmuxServer}_`;                // session-name prefix we own
export const tmuxName = (id: string) => TMUX_PREFIX + id;
/**
 * Which tmux server a `live/` record's pane was started on, as a string this
 * host can compare against its own: the socket directory tmux itself would use
 * (`$TMUX_TMPDIR`, else `/tmp`, then `tmux-<uid>`) and the `-L` name. Stamped on
 * every record by `persistLive` so the boot reclaim (`staleLiveIds`) only ever
 * judges a record against a listing of the server that record belongs to.
 * It never has to equal tmux's own spelling of the path — only itself: a
 * differently spelled but identical directory reads as a DIFFERENT server, and
 * a record on a different server is kept.
 */
export const TMUX_SOCKET_ID = join(resolve(process.env.TMUX_TMPDIR || "/tmp"), `tmux-${process.getuid?.() ?? ""}`, TMUX_SERVER);
/**
 * True when nothing overrides the socket this host would pick by itself — no
 * `WATERPLANE_TMUX_SERVER`, no `TMUX_TMPDIR`. A record written before records
 * were stamped (`LiveMeta.tmuxSocket` absent) can only be judged under this
 * condition: the one way such a record's pane lives on ANOTHER server is a host
 * that once ran with an override, and a host that runs with one now cannot tell
 * that history from its own. So an unstamped record is reclaimable only by a
 * default host, and kept by any other.
 */
export const TMUX_SOCKET_DEFAULT = !env("TMUX_SERVER") && !process.env.TMUX_TMPDIR;
/**
 * How long a `live/` record must have gone unwritten before the boot reclaim may
 * delete it for having no tmux session (`staleLiveIds`). `create()` writes the
 * record and starts the tmux client in the same tick, but the `new-session` that
 * makes the name appear in `tmux ls` runs in the tmux CLIENT, asynchronously — so
 * a second host process booting on the same state dir (a dev host beside the
 * service, a doctor run) can list the server between the two. An hour is many
 * orders of magnitude past that window and costs nothing: a record young enough
 * to be spared is reclaimed by a later boot. Only e2e shortens it.
 */
export const STALE_LIVE_MIN_AGE_MS = Math.max(0, Number(env("STALE_LIVE_MIN_AGE_MS") || 60 * 60_000));

/** How often a backend's `sources.sweep` is asked to reap what a gone session left behind
 *  (`sidechannel.ts`; opencode's seat servers and records). Also run once when plugins settle. */
export const SEAT_SWEEP_MS = Math.max(1000, Number(env("SEAT_SWEEP_MS") || 60_000));

/**
 * Bytes typed INTO a pane through our tmux client: tmux reads ctrl+b (`\x02`)
 * as its PREFIX and the key after it as a tmux command (`d` detaches, `x` kills
 * the pane), so a lone ctrl+b from the phone never reached claude, which binds
 * it to "background the running task". The default `C-b C-b` binding is
 * `send-prefix`: doubling every `\x02` hands exactly one to the pane — what
 * claude itself says under tmux ("ctrl+b ctrl+b (twice)"). The prefix is left
 * as it is, for a person who attaches to this server at the desk.
 */
export function tmuxLiteral(data: string): string {
  return data.includes("\x02") ? data.replace(/\x02/g, "\x02\x02") : data;
}
