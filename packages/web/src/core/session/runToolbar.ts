import type { SessionInfo } from "@waterplane/shared";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { openSearch } from "../../features/search";
import { openScrollback } from "../../features/scrollback";
import { openBacklogIn } from "../../features/backlog";
import { runFeatureCommand } from "../dispatch";
import { openToolbarGit } from "../../gitLanding";
import type { Connection } from "../conn/useConnection";
import type { QueueApi } from "../queue/useQueue";
import type { Route } from "../route/useRoute";
import type { TermFeed } from "../term/useTermFeed";

/** What a toolbar command reads — this render's values, as App held them. */
export interface ToolbarCtx {
  setOverlay: Route["setOverlay"];
  activeRepoId: string | null;
  active: SessionInfo | null;
  readMode: TermFeed["readMode"];
  fireReader: TermFeed["fireReader"];
  send: Connection["send"];
  geomRef: TermFeed["geomRef"];
  submitInput: QueueApi["submitInput"];
  /** `useLaunch`'s temporary shell, closed with the session it was opened for. */
  openCompanionShell(s: SessionInfo): unknown;
}

/**
 * The toolbar's command switch and the slash runner it uses
 * (docs/notes/app-architecture.md). Plain functions over App's values: no
 * hook, so nothing here has an order to keep. An id this switch does not
 * know is a feature's command (`runFeatureCommand`).
 */
export function runToolbarCommand(id: string, ctx: ToolbarCtx) {
  const { setOverlay, activeRepoId, active, readMode, fireReader, send, geomRef } = ctx;
  const runSlash = (cmd: string) => runSlashCommand(cmd, ctx);
  track(`toolbar:${id}`);
  switch (id) {
    case "model": setOverlay("model"); break;
    case "cmd": setOverlay("slash"); break;
    // An ASK on the session's repo, never a bare open (`openToolbarGit`, review R2-2 b).
    case "diff": if (!openToolbarGit(activeRepoId, setOverlay)) showToast("not a known repo"); break;
    case "ctx": runSlash("/context"); break;
    // The CLI's canonical name. It answers to `/cost` too — that is a
    // registered alias, not a leftover — but sending the alias meant the
    // toolbar's button and the CLI's own menu entry ("/usage (cost)") named
    // the command two different ways, and the one on screen was never ours.
    case "usage": runSlash("/usage"); break;
    case "teleport": runSlash("/teleport"); break;
    case "remote": runSlash("/remote-control"); break;
    case "tasks": runSlash("/tasks"); break;
    // The session's repo, like the compose badge and the next-prompt strip: a
    // plain open would land on a repo hand-picked last time.
    case "backlog": openBacklogIn(active?.cwd); break;
    case "history": setOverlay("history"); break;
    // The outline is reachable from the terminal too, not only from inside the
    // reader — "where am I in this session?" shouldn't cost a view swap. In
    // the reader it toggles that view's OWN drawer instead: the sheet would
    // be a second copy of the panel already one tap away, and it is the same
    // button either way because the user pinned one outline, not two.
    case "outline":
      if (!active) { showToast("no active session"); break; }
      if (readMode) fireReader("outline"); else setOverlay("outline");
      break;
    // Two different finds, one button, split by what is on screen: in the
    // reader the document IS on the phone, so find is in-page and needs no
    // host; from the terminal there is no document to search, so it is the
    // host-side session search.
    case "find":
      if (!active) { showToast("no active session"); break; }
      if (readMode) fireReader("find"); else openSearch(active.id);
      break;
    // Reader-only, and it says so rather than doing nothing: the terminal is
    // a live stream with nothing to refetch.
    case "refresh":
      if (!active) { showToast("no active session"); break; }
      if (readMode) fireReader("refresh"); else showToast("refresh is the reader's — the terminal is live");
      break;
    // Panning up in the terminal is a wheel event FOR THE TUI and needs the
    // socket. This is the copy that doesn't: the same history, read locally.
    case "scrollback": openScrollback(); break;
    case "fork":
      if (!active) break;
      send({ t: "session.fork", id: active.id, cols: geomRef.current.cols, rows: geomRef.current.rows });
      showToast("forking conversation into a new session…");
      break;
    case "companion":
      if (!active) { showToast("no active session"); break; }
      ctx.openCompanionShell(active);
      break;
    default: runFeatureCommand(id);
  }
}

/** Run a slash command. Split text and Return into two writes (like sendCompose)
 *  so Claude's TUI treats the Return as a submit keystroke, not part of a paste. */
export function runSlashCommand(cmd: string, ctx: ToolbarCtx) {
  const { active, submitInput } = ctx;
  if (!active) return;
  // Per-command counts ("action:slash:context") — which slash shortcuts earn their toolbar slot.
  track(`action:slash:${cmd.split(/\s/)[0].replace(/[^a-zA-Z0-9-]/g, "") || "other"}`);
  submitInput(active.id, active.cwd, cmd, "command");
}
