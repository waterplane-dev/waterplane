/**
 * "Shown as…" — the name a repo wears on the phone, set from that repo's own "⋯" menu.
 *
 * The folder is `myapp` and the product is waterplane; moving the folder is the risky fix, so a
 * repo may carry a display name the host stores (`host/reponames.ts`), the same on every device.
 * It changes what is SHOWN and nothing else: ids, paths, the repo's colour, its fold and every
 * stored key stay on the folder name (`shared/repotwins.ts` `repoShown`).
 *
 * Nothing applies itself: the field starts as the stored name (or empty) and only a tap on
 * *save* writes. Words typed and not yet saved are the last copy, so they are kept per repo for
 * as long as this page lives (`DRAFTS`) — closing the menu and opening it again gives them back —
 * and a failed save (offline, a refused name) keeps them and says why.
 */
import { useState } from "react";
import { Type } from "lucide-react";
import { cleanRepoDisplayName } from "@waterplane/shared";
import type { RepoTarget } from "@waterplane/shared";
import { api } from "../../api";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { Button } from "../../kit/Button";
import { Hint } from "../../kit/Hint";

/** Unsaved words by repo id: the last copy of what was typed, until it is saved or cleared. */
const DRAFTS = new Map<string, string>();

export function RepoShownAs({ repo, onSaved }: { repo: RepoTarget; onSaved: () => void }) {
  const [open, setOpen] = useState(DRAFTS.has(repo.id));
  const [draft, setDraft] = useState(() => DRAFTS.get(repo.id) ?? repo.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const folder = repo.repoName;
  const current = repo.displayName ?? null;
  const typed = (v: string) => { setDraft(v); setWhy(null); if (v === (current ?? "")) DRAFTS.delete(repo.id); else DRAFTS.set(repo.id, v); };

  async function save(name: string | null) {
    track(name ? "action:repo.shownas.save" : "action:repo.shownas.clear");
    // The same cleaning the host does, so a name it would refuse is said here, in the same words, offline too.
    const c = cleanRepoDisplayName(name);
    if (!c.ok) { setWhy(c.error); return; }
    setBusy(true);
    try {
      const r = await api.setRepoDisplayName(repo.id, c.value);
      if (!r.ok) { setWhy(r.error); return; }
      DRAFTS.delete(repo.id);
      setDraft(r.name ?? "");
      setOpen(false);
      showToast(r.name ? `${folder} is shown as “${r.name}” — the folder keeps its name` : `${folder} is shown by its folder name again`);
      onSaved();
    } catch {
      setWhy("The desktop did not answer, so nothing was changed. What you typed is still here.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className={`more-act${current ? " names" : ""}${open ? " on" : ""}`} aria-expanded={open}
        title={current ? `shown as “${current}” — change it, or go back to the folder name “${folder}”` : `change the name this repo is shown under; the folder “${folder}” keeps its name`}
        onClick={() => { track("action:repo.shownas"); setOpen((v) => !v); }}>
        <Type size={16} />{current ? <>shown as <b>{current}</b></> : "shown as…"}
      </button>
      {open && (
        <div className="shownas" style={{ flex: "0 0 100%" }}>
          <div className="plugin-field">
            <input type="text" value={draft} placeholder={folder} aria-label={`name to show for ${folder}`}
              onChange={(e) => typed(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(draft); }} />
            <Button variant="primary" onClick={() => void save(draft)}>{busy ? "saving…" : "save"}</Button>
            {current && <Button onClick={() => void save(null)}>use “{folder}”</Button>}
          </div>
          <Hint>Only what is shown changes, on every device. The folder is still “{folder}”, and so are the repo’s colour and everything that finds it by name.</Hint>
          {why && <Hint tone="warn">{why}</Hint>}
        </div>
      )}
    </>
  );
}
