import { useState } from "react";
import { Check, Loader2, Rocket } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { api, isOffline } from "./api";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { backendOptionLabel } from "./backendCaps";
import { Unavailable } from "./Unavailable";

interface Props {
  root: string;
  repos: RepoTarget[];
  onOpen: (cwd: string, title: string) => void; // start a session there
  onChanged: () => void;                          // repos changed → refresh
  onClose: () => void;
  /**
   * Which binary the session this sheet OPENS will run, and how to change it.
   *
   * Both are passed only when the host has described more than one backend
   * (`backendCaps.showBackendPicker`); on a desktop that never sent a
   * `backends` frame neither arrives and nothing here is drawn — not greyed,
   * absent — so this sheet is exactly what it was. Two of its three tabs end
   * in an immediate `onOpen`, which is what makes this part of the new-session
   * flow rather than a setting that happens to apply to it.
   */
  backends?: { id: string; label: string; experimental?: boolean; unavailable?: string }[];
  backend?: string;
  onBackend?: (id: string | undefined) => void;
  /** "Build another app": the first-app journey (`features/onboard`), opened by the caller —
   *  a top-level module may not import a feature. Absent ⇒ the row is not drawn. */
  onBuildApp?: () => void;
}

/** Create a new folder, a new git repo, a clone of a remote, or a new worktree of an existing repo. */
export function NewMenu({ root, repos, onOpen, onChanged, onClose, backends, backend, onBackend, onBuildApp }: Props) {
  const [tab, setTab] = useState<"repo" | "clone" | "folder" | "worktree">("repo");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [url, setUrl] = useState("");
  /** Seed the phone-facing scaffold (gitignore, README, CLAUDE.md, inbox/outbox). */
  const [initSetup, setInitSetup] = useState(true);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [branch, setBranch] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  /** A created repo we did NOT auto-open because git had something to say. */
  const [made, setMade] = useState<{ path: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const primaryRepos = repos.filter((r) => r.isPrimary);
  const verb = tab === "clone" ? "Clone & open" : tab === "repo" ? "Create project & open" : tab === "folder" ? "Create folder" : "Create worktree & open";
  /** What the form still needs before its one verb can run — said, never greyed (`Unavailable.tsx`). */
  const missing = tab === "worktree"
    ? (!primaryRepos.length ? "no repo on this desktop to branch from" : !branch ? "name the new branch first" : "")
    : tab === "clone" ? (!url.trim() ? "paste a URL first" : "")
    : !name ? `name the new ${tab === "repo" ? "project" : "folder"} first` : "";

  async function go() {
    setBusy(true);
    setMsg(null);
    try {
      if (tab === "folder") {
        const r = await api.newFolder(root, name);
        setMsg(r.error ? `Error: ${r.error}` : `Created ${r.path}`);
        if (r.path) onChanged();
      } else if (tab === "clone") {
        track("action:repo.clone");
        const r = await api.cloneRepo(root, url.trim(), name.trim());
        if (r.error) setMsg(`Error: ${r.error}`);
        else {
          onChanged();
          const title = r.path!.split("/").pop() || "clone";
          if (r.warning) {
            setMade({ path: r.path!, title });
            setMsg(`Cloned into ${r.path}${r.branch ? ` on ${r.branch}` : ""} — ${r.warning}`);
          } else onOpen(r.path!, title);
        }
      } else if (tab === "repo") {
        track(initSetup ? "action:repo.new.project" : "action:repo.new.bare");
        const r = await api.newRepo(root, name, { setup: initSetup, description: desc });
        if (r.error) setMsg(`Error: ${r.error}`);
        else {
          onChanged();
          // A warning (usually: no git identity, so the commit used a
          // placeholder) is worth reading before the terminal takes the screen.
          if (r.warning) {
            setMade({ path: r.path!, title: name });
            setMsg(`Created ${r.path} on ${r.branch}${r.files?.length ? ` · ${r.files.join(", ")}` : ""} — ${r.warning}`);
          } else onOpen(r.path!, name);
        }
      } else {
        const r = await api.newWorktree(repoId, branch);
        if (r.error) setMsg(`Error: ${r.error}`);
        else {
          onChanged();
          onOpen(r.path!, `${repos.find((x) => x.id === repoId)?.repoName} · ${r.branch}`);
        }
      }
    } catch (e) {
      // There was a `finally` and no `catch`: a rejected fetch — which on this
      // app's link is the ordinary case, not the exotic one — unwound past the
      // button, cleared `busy`, and left the label reading "Create project &
      // open" with nothing written and nothing said. The one visible effect of
      // tapping it was the spinner briefly appearing. Say which nothing it was.
      setMsg(isOffline(e)
        ? "No connection — a project is created on the desktop, so this needs the link. Nothing was written."
        : `Error: ${String((e as Error)?.message || e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet">
      <SheetHead title={"New"} onClose={onClose} />
      <div className="annot-tools">
        <button className={`key ${tab === "repo" ? "active" : ""}`} onClick={() => setTab("repo")}>project</button>
        <button className={`key ${tab === "clone" ? "active" : ""}`} onClick={() => setTab("clone")}>clone</button>
        <button className={`key ${tab === "folder" ? "active" : ""}`} onClick={() => setTab("folder")}>folder</button>
        <button className={`key ${tab === "worktree" ? "active" : ""}`} onClick={() => setTab("worktree")}>worktree</button>
      </div>

      <div className="form">
        <div className="form-hint mono">{root}</div>
        {tab === "clone" && (
          <>
            <input className="search" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder="https://github.com/owner/repo or git@host:owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
            <input className="search" placeholder="folder name (optional — taken from the URL)" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="form-hint">
              Cloned on the desktop with its own git sign-in, so private repos work where the desktop can reach them.
              The phone's inbox and outbox are excluded in this clone only — the project itself is not changed.
              A big repo takes a while; this sheet waits.
            </div>
          </>
        )}
        {tab !== "worktree" && tab !== "clone" && (
          <input className="search" placeholder={tab === "repo" ? "new project name" : "new folder name"} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        )}
        {tab === "repo" && onBuildApp && (
          <button className="key new-buildapp" onClick={onBuildApp}>
            <Rocket size={14} /> build an app — a phone app or a web page from a template, built and ready to change
          </button>
        )}
        {tab === "repo" && (
          <>
            <input className="search" placeholder="one line: what is it? (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
            <button className={`key ${initSetup ? "active" : ""}`} onClick={() => setInitSetup(!initSetup)}>
              {initSetup && <Check size={14} />} set up for phone use
            </button>
            <div className="form-hint">
              {initSetup
                ? "git init on main + first commit, .gitignore, README, CLAUDE.md, and the .claude/outbox drop the phone gallery reads."
                : "bare git init + empty first commit only."}
            </div>
          </>
        )}
        {tab === "worktree" && (
          <>
            <select className="search" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              {primaryRepos.map((r) => <option key={r.id} value={r.id}>{r.repoName}</option>)}
            </select>
            <input className="search" placeholder="new branch name" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </>
        )}
        {/* The one decision this sheet makes that is not about the folder:
            what the session it opens will be. Same store as the launcher's
            other new-session defaults, so it is not a second answer to the
            same question. */}
        {backends && backends.length > 1 && onBackend && (
          <>
            <select className="search" value={backend ?? "claude"}
              onChange={(e) => onBackend(e.target.value === "claude" ? undefined : e.target.value)}>
              {backends.map((b) => <option key={b.id} value={b.id}>{backendOptionLabel(b)}</option>)}
            </select>
            <div className="form-hint">
              The session this opens runs {backends.find((b) => b.id === (backend ?? "claude"))?.label ?? "the default"}.
              Every new session does, until you change it back.
            </div>
          </>
        )}
        {/* Running is a line of text, not a dimmed button: the tap already happened, and a
            second one must not be offered while the first is still on the desktop. */}
        {busy
          ? <div className="form-hint"><Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> {tab === "clone" ? "Cloning on the desktop — a big repo takes a while" : "Working…"}</div>
          : missing
            ? <Unavailable cants={[{ label: verb, reason: missing }]} />
            : <button className="send" onClick={go}>{verb}</button>}
        {msg && <div className="form-hint">{msg}</div>}
        {made && <button className="send" onClick={() => onOpen(made.path, made.title)}>Open session anyway</button>}
      </div>
    </div>
  );
}
