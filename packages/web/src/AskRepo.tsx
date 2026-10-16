/**
 * "Which repo?" for a keyboard — `askText`'s shape (`const repo = await
 * askRepo(repos, title)`, `null` when dismissed), mounted once in `main.tsx`
 * beside `AskTextHost` for the same reason: it can be asked over any screen,
 * and `App` draws its sheets per overlay. The new-session chord
 * (`features/newSession`) is the first asker.
 *
 * `RepoPicker` is the row list a SHEET uses when picking is the screen; this is
 * the dialog for hands that never leave the keyboard: the caret starts in the filter,
 * ↑/↓ (or Ctrl+N/Ctrl+P) walk the rows, Return opens
 * the lit one, Esc closes. A tap on a row works too.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RepoTarget } from "@waterplane/shared";
import { createStore, useStore } from "./sdk/store.ts";
import { repoBranchLine, repoTitle } from "./RepoPicker";
import { askRepoRows } from "./askRepoRows";
import { registerShortcut } from "./shortcuts";

interface Ask {
  repos: RepoTarget[];
  title: string;
  resolve: (repo: RepoTarget | null) => void;
}

const asking = createStore<Ask | null>(null);

/** Ask which repo. A second ask answers the first `null` rather than stacking. */
export function askRepo(repos: RepoTarget[], title = "Which repo?"): Promise<RepoTarget | null> {
  asking.get()?.resolve(null);
  return new Promise((resolve) => { asking.set({ repos, title, resolve }); });
}

/** Is the question up right now? */
export const isAskingRepo = (): boolean => asking.get() != null;

/** The question's own chords on the shortcut card (`shortcuts.ts`), live
 *  only while it is asked. Install once (`main.tsx`); returns the removal. */
export function registerAskRepoShortcuts(): () => void {
  const offs = [
    registerShortcut({ id: "askRepo.next", mods: ["ctrl"], key: "N", what: () => "next repo", when: isAskingRepo }),
    registerShortcut({ id: "askRepo.prev", mods: ["ctrl"], key: "P", what: () => "previous repo", when: isAskingRepo }),
  ];
  return () => offs.forEach((off) => off());
}

function answerRepo(repo: RepoTarget | null): void {
  const a = asking.get();
  asking.set(null);
  a?.resolve(repo);
}

/** Mounted once in `main.tsx`. Renders nothing when nothing is being asked. */
export function AskRepoHost() {
  const ask = useStore(asking);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setQuery(""); setAt(0); }, [ask]);
  const rows = useMemo(() => (ask ? askRepoRows(ask.repos, query) : []), [ask, query]);
  useEffect(() => { setAt(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  if (!ask) return null;

  const step = (d: number) => setAt((i) => (rows.length ? (i + d + rows.length) % rows.length : 0));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const k = e.key.toLowerCase();
    if (e.key === "ArrowDown" || (ctrl && k === "n")) { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || (ctrl && k === "p")) { e.preventDefault(); step(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[at]) answerRepo(rows[at]); }
    // preventDefault: the wide layout's Esc (`escape.ts`) steps Back unless
    // the press was already answered.
    else if (e.key === "Escape") { e.preventDefault(); answerRepo(null); }
  };

  return (
    <div className="bl-modal-backdrop confirm-backdrop" onClick={() => answerRepo(null)}>
      <div className="bl-modal ask-repo-modal" role="dialog" aria-modal="true" aria-label={ask.title}
        onClick={(e) => e.stopPropagation()}>
        <div className="bl-modal-title">{ask.title}</div>
        <input className="ask-text-input" autoFocus value={query} placeholder="type to filter repos"
          role="combobox" aria-expanded="true" aria-controls="ask-repo-list" aria-activedescendant={rows[at] ? `ask-repo-${at}` : undefined}
          enterKeyHint="go" spellCheck={false} autoCapitalize="off" autoComplete="off"
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
        <div className="ask-repo-list" id="ask-repo-list" role="listbox" ref={listRef}>
          {rows.map((r, i) => (
            <button key={r.id} id={`ask-repo-${i}`} data-i={i} role="option" aria-selected={i === at} tabIndex={-1}
              className={`row ask-repo-row${i === at ? " on" : ""}`}
              onMouseMove={() => { if (i !== at) setAt(i); }} onClick={() => answerRepo(r)}>
              <span className="row-title">{repoTitle(r)}</span>
              {repoBranchLine(r) && <span className="row-sub">{repoBranchLine(r)}</span>}
            </button>
          ))}
          {rows.length === 0 && (
            <div className="ask-text-note ask-repo-none">
              {query.trim() ? `No repo or branch matches “${query.trim()}”.` : "No repos under the host root yet."}
            </div>
          )}
        </div>
        <div className="ask-text-note">↑ ↓ to choose · Return opens · Esc closes</div>
      </div>
    </div>
  );
}
