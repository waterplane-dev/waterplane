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
import { Button, RowSub, RowTitle, Hint } from "../../kit";

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
    ui.phase === "restarting" ? null : <Button onClick={close}>Close</Button>
  ) : busy === "save" ? (
    <RowSub>Saving…</RowSub>
  ) : (
    <>
      <Button onClick={close}>{info.picked === "chosen" && info.rootExists ? "Close" : "Later"}</Button>
      {canKeep && <Button onClick={() => void save(info.root)}>Keep {info.root}</Button>}
      {differs && <button className="send" onClick={() => void save(target)}>Use this folder</button>}
    </>
  );

  return (
    <Sheet title="Which folder holds your repos?" icon={<FolderOpen size={ICON} />} onClose={close} footer={footer}>
      <div className="sheet-scroll">
        <Hint>
          Everything under this folder is reachable from the phone. The host scans it for repos.
        </Hint>

        <div className="section">In use now</div>
        <Hint>
          <span className="mono">{rootLine(info)}</span>
          <br />{pickedWords(info.picked, info.envName)}
        </Hint>
        {info.pending && <Hint tone="warn">{pendingWords(info.pending)}</Hint>}

        {ui.phase === "restarting" && <Hint>{ui.text}</Hint>}
        {ui.phase === "manual" && <Hint>{ui.text}</Hint>}

        {mode === "named" && <Hint>{namedWords(info.envName)}</Hint>}
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
                        <RowTitle className="mono">{c.path}</RowTitle>
                        <RowSub>{reposWords(c.repos)}{samePath(c.path, info.root) ? " · in use" : ""}</RowSub>
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
                ? <Hint as="span">Checking…</Hint>
                : <Button style={{ margin: "0 10px", alignSelf: "flex-start" }} onClick={() => void runCheck()}>Check</Button>)}
            </div>
            {check && <Hint tone={check.ok ? undefined : "warn"}>{check.text}</Hint>}
            {!target && <Hint>Pick a folder above, or type a path, to change it.</Hint>}
            {target && !differs && <Hint>That is the folder in use now.</Hint>}
            {err && <Hint tone="warn">{err}</Hint>}
          </>
        )}

        <Hint>{footerWords(info)}</Hint>
      </div>
    </Sheet>
  );
}
