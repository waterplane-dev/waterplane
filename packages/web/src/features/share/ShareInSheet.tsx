/**
 * "Where does this go?" — a share from another app (the Android share sheet,
 * `shellShare.ts`). Three answers: the session on screen, another live one, or
 * a new session in a repo. Then `shareTo` routes the files exactly as the
 * compose bar's camera and paperclip would. Nothing lands anywhere unasked: any
 * app can share to this one.
 */
import { useState } from "react";
import { FileText, Image as ImageIcon, Share2, Terminal, X } from "lucide-react";
import { BRAND, fmtBytes } from "@waterplane/shared";
import { Sheet } from "../../Sheet";
import { RepoPicker } from "../../RepoPicker";
import { tabLabel } from "../../sessionTabs";
import { useCore, useStore } from "../../sdk";
import { shared } from "./store";
import { dropShare, shareTo, type ShareTarget } from "./actions";
import { shareOtherSessions, shareSummary } from "./logic";

export function ShareInSheet() {
  const c = useCore();
  const s = useStore(shared);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const { active, sessions, repos } = c.world;
  const repoName = (cwd: string) => repos.find((r) => r.worktreePath === cwd)?.repoName ?? "";
  const others = shareOtherSessions(sessions, active?.id);
  const go = (t: ShareTarget) => {
    if (busy) return;
    setBusy(true);
    void shareTo(t).finally(() => setBusy(false));
  };
  const sessionRow = (x: typeof sessions[number], sub: string) => (
    <button key={x.id} className="row" onClick={() => go({ kind: "session", sessionId: x.id })}>
      <span className="row-title"><Terminal size={14} /> {tabLabel(x, repoName(x.cwd))}</span>
      <span className="row-sub">{repoName(x.cwd) || x.cwd}{sub ? ` · ${sub}` : ""}</span>
    </button>
  );
  return (
    <Sheet title={`Shared to ${BRAND.displayName}`} icon={<Share2 size={16} />} onClose={dropShare}
      footer={
        <div className="sheet-actions">
          <button className="key" onClick={dropShare}><X size={16} /> drop it</button>
        </div>
      }>
      <div className="form-hint">
        {busy ? "reading what was shared…" : `${shareSummary(s)} — where should it go? Pictures open in the annotator first; the rest are attached with their paths in the prompt, which is not sent until you send it.`}
      </div>
      <div className="list">
        {s.files.map((f) => (
          <div key={f.url} className="row">
            <span className="row-title">{f.type.startsWith("image/") ? <ImageIcon size={14} /> : <FileText size={14} />} {f.name}</span>
            <span className="row-sub">{f.type || "file"}{f.size ? ` · ${fmtBytes(f.size)}` : ""}</span>
          </div>
        ))}
        {s.text && (
          <div className="row">
            <span className="row-title"><FileText size={14} /> text</span>
            <span className="row-sub">{s.text.length > 200 ? `${s.text.slice(0, 200)}…` : s.text}</span>
          </div>
        )}
      </div>
      {active && (
        <>
          <div className="section section-head"><span>This session</span></div>
          <div className="list">{sessionRow(active, "on screen now")}</div>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="section section-head"><span>{active ? "Another open session" : "An open session"}</span></div>
          <div className="list">{others.map((x) => sessionRow(x, ""))}</div>
        </>
      )}
      <RepoPicker repos={repos} label="A new session in…" listClass="list" home={active?.cwd ?? null} worktreeFilter
        emptyText="No repos on this desktop yet." onPick={(repo) => go({ kind: "new", repo })} />
    </Sheet>
  );
}
