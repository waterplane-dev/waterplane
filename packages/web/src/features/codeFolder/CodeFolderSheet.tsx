/**
 * "Which folder holds your repos?" — the code folder the host scans, asked once when it was only
 * guessed and reachable any time from Settings → Code folder.
 *
 * Nothing here applies itself: the list and the typed path only SELECT, and the folder changes on
 * the tap of "Use this folder" or "Keep …". What cannot be done is a sentence, not a dimmed
 * button — a variable that names the root, or a connection that may not change it.
 */
import { useState } from "react";
import { Check, Folder, FolderOpen } from "lucide-react";
import { core, useStore } from "../../sdk";
import { Sheet } from "../../Sheet";
import { Empty } from "../../Empty";
import { CantInline } from "../../Unavailable";
import { checkFolder, saveFolder } from "./actions";
import {
  LOCKED_WORDS, checkWords, footerWords, namedWords, pendingWords, pickedWords, reposWords, rootLine, samePath, sheetMode, targetPath,
} from "./logic";
import { rootInfo, rootUi } from "./store";

const ICON = 16;

export function CodeFolderSheet() {
  const info = useStore(rootInfo);
  const ui = useStore(rootUi);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Closing here is a "later" for this guess too (`leaveCodeFolder`, run by the sheet def's onLeave).
  const close = () => core().nav.close("codefolder");

  if (!info) {
    return (
      <Sheet title="Code folder" icon={<FolderOpen size={ICON} />} onClose={close}>
        <Empty res={{ state: ui.phase === "idle" && ui.readError ? "error" : "loading", error: ui.phase === "idle" ? ui.readError : null }}
          thing="the code folder">
          The desktop did not say which folder it scans.
        </Empty>
      </Sheet>
    );
  }

  const mode = sheetMode(info);
  const target = targetPath(selected, typed);
  const differs = target !== "" && !samePath(target, info.root);
  const waiting = ui.phase !== "idle";
  const canKeep = mode === "choose" && info.rootExists && info.picked !== "chosen";

  const pick = (path: string) => { setSelected(path); setTyped(""); setCheck(null); setErr(null); };
  const type = (v: string) => { setTyped(v); setSelected(null); setCheck(null); setErr(null); };
  const runCheck = async () => {
    setBusy("check"); setErr(null);
    const r = await checkFolder(typed.trim());
    setBusy(null);
    setCheck({ ok: r.ok, text: checkWords(r) });
  };
  const save = async (path: string) => {
    setBusy("save"); setErr(null);
    const why = await saveFolder(path);
    setBusy(null);
    if (why) setErr(why);
  };

  const footer = mode !== "choose" || waiting ? (
    ui.phase === "restarting" ? null : <button className="key" onClick={close}>Close</button>
  ) : busy === "save" ? (
    <span className="row-sub">Saving…</span>
  ) : (
    <>
      <button className="key" onClick={close}>{info.picked === "chosen" && info.rootExists ? "Close" : "Later"}</button>
      {canKeep && <button className="key" onClick={() => void save(info.root)}>Keep {info.root}</button>}
      {differs && <button className="send" onClick={() => void save(target)}>Use this folder</button>}
    </>
  );

  return (
    <Sheet title="Which folder holds your repos?" icon={<FolderOpen size={ICON} />} onClose={close} footer={footer}>
      <div className="sheet-scroll">
        <div className="form-hint">
          Everything under this folder is reachable from the phone. The host scans it for repos.
        </div>

        <div className="section">In use now</div>
        <div className="form-hint">
          <span className="mono">{rootLine(info)}</span>
          <br />{pickedWords(info.picked, info.envName)}
        </div>
        {info.pending && <div className="form-hint warn">{pendingWords(info.pending)}</div>}

        {ui.phase === "restarting" && <div className="form-hint">{ui.text}</div>}
        {ui.phase === "manual" && <div className="form-hint">{ui.text}</div>}

        {mode === "named" && <div className="form-hint">{namedWords(info.envName)}</div>}
        {mode === "locked" && <div className="act-cants"><CantInline>{LOCKED_WORDS}</CantInline></div>}

        {mode === "choose" && !waiting && (
          <>
            {info.candidates.length > 0 && (
              <>
                <div className="section">Usual code folders</div>
                <div className="list">
                  {info.candidates.map((c) => {
                    const on = selected === c.path;
                    return (
                      <button key={c.path} className={`row${on ? " sched-on" : ""}`} aria-pressed={on} onClick={() => pick(c.path)}>
                        {on ? <Check size={ICON} /> : <Folder size={ICON} />}
                        <span className="row-title mono">{c.path}</span>
                        <span className="row-sub">{reposWords(c.repos)}{samePath(c.path, info.root) ? " · in use" : ""}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <div className="section">Another folder</div>
            <div className="form">
              <input className="search mono" placeholder={info.root} value={typed} spellCheck={false}
                autoCapitalize="off" autoCorrect="off" onChange={(e) => type(e.target.value)} />
              {typed.trim() && (busy === "check"
                ? <span className="form-hint">Checking…</span>
                : <button className="key" style={{ margin: "0 10px", alignSelf: "flex-start" }} onClick={() => void runCheck()}>Check</button>)}
            </div>
            {check && <div className={`form-hint${check.ok ? "" : " warn"}`}>{check.text}</div>}
            {!target && <div className="form-hint">Pick a folder above, or type a path, to change it.</div>}
            {target && !differs && <div className="form-hint">That is the folder in use now.</div>}
            {err && <div className="form-hint warn">{err}</div>}
          </>
        )}

        <div className="form-hint">{footerWords(info)}</div>
      </div>
    </Sheet>
  );
}
