/**
 * "Where does this go?" — a share from another app (the Android share sheet,
 * `shellShare.ts`). Four answers: the session on screen, another live one, a
 * new session in a repo, or just a repo's inbox (no session). Then `shareTo`
 * routes the files as the compose bar's paperclip would — pictures through the
 * annotator only when asked (one picture: yes; several: straight up). Nothing
 * lands anywhere unasked: any app can share to this one.
 */
import { useState } from "react";
import { FileText, Image as ImageIcon, Inbox, Share2, Terminal, X } from "lucide-react";
import { BRAND, fmtBytes } from "@waterplane/shared";
import { Sheet } from "../../Sheet";
import { RadioRows } from "../../kit";
import { RepoPicker } from "../../RepoPicker";
import { tabLabel } from "../../sessionTabs";
import { useCore, useStore } from "../../sdk";
import { shared } from "./store";
import { dropShare, shareTo, type ShareTarget } from "./actions";
import { shareOtherSessions, sharePictures, shareSummary } from "./logic";

export function ShareInSheet() {
  const c = useCore();
  const s = useStore(shared);
  const [busy, setBusy] = useState(false);
  const pics = s ? sharePictures(s) : 0;
  // One picture is usually "point at the part that is wrong"; a stack of
  // them is a batch to hand over, and 25 annotator screens is where people got lost.
  const [annotate, setAnnotate] = useState(pics === 1);
  const [inbox, setInbox] = useState(false);
  if (!s) return null;
  const { active, sessions, repos } = c.world;
  const connecting = c.conn.status !== "open";
  const repoName = (cwd: string) => repos.find((r) => r.worktreePath === cwd)?.repoName ?? "";
  const others = shareOtherSessions(sessions, active?.id);
  const go = (t: ShareTarget) => {
    if (busy) return;
    setBusy(true);
    void shareTo(t).finally(() => setBusy(false));
  };
  const sessionRow = (x: typeof sessions[number], sub: string) => (
    <button key={x.id} className="row" onClick={() => go({ kind: "session", sessionId: x.id, annotate })}>
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
        {busy ? "reading what was shared…" : `${shareSummary(s)} — where should it go? In a session, files are uploaded with their paths in the prompt, which is not sent until you send it.`}
      </div>
      {pics > 0 && (
        <RadioRows<"asis" | "markup">
          label="pictures"
          value={annotate ? "markup" : "asis"}
          options={[{ key: "asis", label: "upload pictures as they are" }, { key: "markup", label: "mark them up first" }]}
          onChange={(k) => setAnnotate(k === "markup")}
        />
      )}
      {connecting && <div className="form-hint">Connecting to the desktop — its open sessions appear here once it answers.</div>}
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
      {s.files.length > 0 && (
        <RadioRows<"session" | "inbox">
          label="in a repo"
          value={inbox ? "inbox" : "session"}
          options={[
            { key: "session", label: <><Terminal size={14} /> new session</> },
            { key: "inbox", label: <><Inbox size={14} /> inbox only</> },
          ]}
          onChange={(k) => setInbox(k === "inbox")}
        />
      )}
      {inbox && <div className="form-hint">No session: the files upload to the repo's .claude/inbox/ in the background{s.text ? ", and the text is copied" : ""}.</div>}
      <RepoPicker repos={repos} label={inbox ? "Into the inbox of…" : "A new session in…"} listClass="list" home={active?.cwd ?? null} worktreeFilter
        emptyText="No repos on this desktop yet." onPick={(repo) => go(inbox ? { kind: "inbox", repo } : { kind: "new", repo, annotate })} />
    </Sheet>
  );
}
