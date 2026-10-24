/**
 * The phone's slash sheet: `GET /api/slash?cwd=<cwd>[&backend=<id>]` answers `SlashListDoc`.
 *
 * No `backend` ⇒ claude's set (built-ins + `.claude/commands/**`), exactly as before. With
 * `backend=<id>` for a backend whose `commands` fact a source answers (2.2,
 * `docs/plans/backend-parity-v3.md` §7) ⇒ THAT backend's own list, each row `source: "backend"`.
 */

/** One command the sheet lists. Picking one types it into the session. */
export interface SlashCommand {
  /** With the slash: `"/compact"`. */
  name: string;
  /** Who listed it: claude's built-ins, the repo's or the person's `.claude/commands`, or a backend's own list. */
  source: "builtin" | "project" | "user" | "backend";
  description?: string;
  /** The arguments as the backend's own help writes them. Absent = none or not stated. */
  args?: string;
  /**
   * The backend says this runs in its TUI and starts no agent turn — the host proves its delivery
   * by the screen moving, never by a turn. Absent = not stated (never "starts a turn" by default).
   */
  local?: true;
}

/** The answer of `GET /api/slash`. */
export interface SlashListDoc {
  commands: SlashCommand[];
  /**
   * Why `commands` is empty, in words — only with `?backend=` (the backend lists none, its list
   * failed, or the answer it gave was malformed and dropped whole). Absent with a non-empty list.
   */
  why?: string;
}
