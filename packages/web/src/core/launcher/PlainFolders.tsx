/**
 * Folders under the desktop's root that the repo scan skipped because they hold
 * no `.git` — said after a rescan, with `git init` one tap away.
 *
 * Discovery lists only git checkouts (`host/repos.ts`), so a folder dragged in
 * with the Finder used to be silently missing however often rescan was pressed.
 * The rescan button now asks `GET /api/plainfolders` and this note names what it
 * skipped. It sits ABOVE the repo list (`ux` §5) and goes when dismissed or when
 * the next rescan finds nothing. Module state, because the launcher unmounts
 * under every sheet.
 */
import { useEffect, useState } from "react";
import { FolderGit2, X } from "lucide-react";
import { api } from "../../api";
import { showToast } from "../../toast";
import { Row, RowSub, RowTitle } from "../../kit/Row";
import { Button } from "../../kit/Button";

type Folder = { name: string; path: string };

let folders: Folder[] = [];
const subs = new Set<(f: Folder[]) => void>();
function setFolders(f: Folder[]) { folders = f; for (const s of subs) s(f); }

/** Called by the rescan button. Resolves to how many folders were skipped (null: the read failed). */
export function scanPlainFolders(): Promise<number | null> {
  return api.plainFolders()
    .then((r) => { setFolders(r.folders ?? []); return folders.length; })
    .catch(() => null);
}

export function PlainFolders({ refreshRepos }: { refreshRepos: () => void }) {
  const [list, setList] = useState(folders);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { subs.add(setList); return () => { subs.delete(setList); }; }, []);
  if (!list.length) return null;

  const init = (f: Folder) => {
    setBusy(f.path);
    api.initPlainFolder(f.path)
      .then((r) => {
        if (r.error) { showToast(`${f.name}: ${r.error}`); return; }
        setFolders(folders.filter((x) => x.path !== f.path));
        refreshRepos();
        showToast(`${f.name} is a git repo now — listed below`);
      })
      .catch(() => showToast(`${f.name}: the desktop did not answer — nothing changed`))
      .finally(() => setBusy(null));
  };

  return (
    <div className="list">
      <div className="section section-head">
        <span>{list.length === 1 ? "1 folder is" : `${list.length} folders are`} not listed: no git in {list.length === 1 ? "it" : "them"}</span>
        <button className="head-act" aria-label="dismiss" title="dismiss — the next rescan says it again"
          onClick={() => setFolders([])}><X size={13} /></button>
      </div>
      {list.map((f) => (
        <Row key={f.path} kind="wrap">
          <Row kind="grow">
            <RowTitle className="mono">{f.name}</RowTitle>
            <RowSub>only folders with git are repos here</RowSub>
          </Row>
          <Button title={`run git init in ${f.name} — adds a .git folder, no commit, your files stay as they are`}
            onClick={() => { if (!busy) init(f); }}>
            <FolderGit2 size={14} /> {busy === f.path ? "running…" : "git init"}
          </Button>
        </Row>
      ))}
    </div>
  );
}
