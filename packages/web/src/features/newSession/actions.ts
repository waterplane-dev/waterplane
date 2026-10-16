/**
 * The chord's listener and what a press does (README.md): `+ now` for the
 * session on screen, else ask which repo.
 */
import { core } from "../../sdk";
import { askRepo, isAskingRepo } from "../../AskRepo";
import { baseName } from "../../format";
import { registerShortcut } from "../../shortcuts";
import { repoTitle } from "../../RepoPicker";
import { isNewSessionPress, newKeyNote, newKeyWhat } from "./logic";

/** What already owns the keyboard: an in-app dialog (`primaryKey.ts`'s set). */
const DIALOGS = ".bl-modal-backdrop, [role=dialog][aria-modal=true]";

/**
 * Is the chord live right now? With an in-app dialog up — the repo question
 * itself included — the press is left alone: a question being answered is not
 * the moment to open something else. The listener and the shortcut card both
 * read this, so the card never lists a press that does nothing.
 */
export function newKeyFree(doc: Pick<Document, "querySelector"> = document): boolean {
  return !isAskingRepo() && !doc.querySelector(DIALOGS);
}

/** Where the press would open a session, by name — null = it will ask. */
function newKeyTarget(): string | null {
  const c = core();
  const active = c.world.active;
  if (!active) return null;
  const t = c.world.repoForCwd(active.cwd);
  return t ? repoTitle(t) : baseName(active.cwd);
}

/** The chord's line on the shortcut card (`shortcuts.ts`). */
export function registerNewKeyShortcut(): () => void {
  return registerShortcut({
    id: "newSession",
    mods: ["ctrl", "meta", "alt"],
    key: "N",
    what: () => newKeyWhat(newKeyTarget()),
    when: () => newKeyFree(),
    note: newKeyNote,
  });
}

/** One press of the chord, read against this render's world. */
export function newSessionPressed(): void {
  const c = core();
  const active = c.world.active;
  if (active) {
    c.say.track("action:key.new.here");
    const t = c.world.repoForCwd(active.cwd);
    // A session outside every listed repo (an external folder) still has a
    // folder: the next one opens there.
    if (t) c.nav.openRepo(t); else c.launch.openCwd(active.cwd, baseName(active.cwd));
    return;
  }
  c.say.track("action:key.new.pick");
  void askRepo(c.world.repos, "New session in…").then((t) => { if (t) core().nav.openRepo(t); });
}

/**
 * Capture phase on `window`, so a focused xterm does not turn the press into
 * a CLI keystroke first. Stands down while `newKeyFree` says no.
 */
export function installNewKey(win: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!isNewSessionPress(e)) return;
    if (!newKeyFree(win.document)) return;
    e.preventDefault();
    e.stopPropagation();
    newSessionPressed();
  };
  win.addEventListener("keydown", onKey, true);
  return () => win.removeEventListener("keydown", onKey, true);
}
