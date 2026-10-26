/**
 * The updates area's shared pieces, drawn in the plugins row (installed tags, available, add by URL)
 * and in the updates sheet (waterplane's own row, the due cut). Words come from `updatesLogic.ts`
 * and `@waterplane/shared`'s `pluginMaturity`; nothing here decides what counts as an update.
 */
import { useState } from "react";
import { Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { BRAND, PLUGIN_MATURITIES, pluginMaturity } from "@waterplane/shared";
import type { UpdatesStatus, UpdatesTarget } from "@waterplane/shared";
import { copyText } from "../../api";
import { core, useStore } from "../../sdk";
import { Button, Explain, Hint, RowSub, Tag } from "../../kit";
import { SetNote, SetWarn } from "../../SettingsKit";
import { useNow } from "../../useNow";
import { checkNow, installFromOrg, installFromUrl, restartDesktop, rollbackSelf, updateSelf } from "./updatesActions";
import {
  ORG, applyRunning, availableRows, checkedWords, nextCheckWords, parseUrlInput, resultView, selfSwapped, selfView, type AvailableRow,
} from "./logic";
import { applies, checking, targetKey } from "./store";

export function MaturityTag({ m }: { m: { label: string; meaning: string } }) {
  // The meaning rides on `title`, which a long press shows (hints.ts) — the phone has no hover.
  return <Tag title={`${m.label}: ${m.meaning}`}>{m.label}</Tag>;
}

/** "checked 3 min ago", the refresh button and the last check's failure as a sentence. */
export function CheckedLine({ status }: { status: UpdatesStatus | null }) {
  const now = useNow(30_000);
  const busy = useStore(checking);
  return (
    <>
      <div className="plugin-head">
        <RowSub>{[checkedWords(status?.checkedAt, now), nextCheckWords(status?.nextCheckAt, now)].filter(Boolean).join(" · ")}</RowSub>
        <Button title="check for updates now" onClick={checkNow}>
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} {busy ? "checking" : "check now"}
        </Button>
      </div>
      {status?.error && <SetWarn>{status.error}</SetWarn>}
    </>
  );
}

/** What the last apply for one target answered, verbatim, plus what is left to do. */
export function ApplyNote({ target }: { target: UpdatesTarget }) {
  const a = useStore(applies)[targetKey(target)];
  const now = useNow(30_000);
  if (!a) return null;
  if (applyRunning(a, now)) return <SetNote><Loader2 size={12} className="spin" /> working on the desktop…</SetNote>;
  // No answer after a while (a restart eats it): say so; the desktop's kept result replaces this on reconnect.
  if (a.pending) return <SetNote>No answer yet. If the desktop restarted, its result shows here when the phone reconnects.</SetNote>;
  const v = resultView({ ok: a.ok, restart: a.restart }, a.target, selfSwapped({ ok: a.ok, restart: a.restart }));
  return (
    <>
      <SetWarn tone={a.ok ? "plain" : "bad"}>{a.message}</SetWarn>
      {v.note && <SetNote>{v.note}</SetNote>}
      {v.restartButton && <Button onClick={restartDesktop}>restart the desktop</Button>}
    </>
  );
}

/** One plugin from the catalogue that is not installed: an install button, or why it cannot be. */
export function AvailableRowView({ r }: { r: AvailableRow }) {
  return (
    <div className="plugin-sec">
      <div className="plugin-head">
        <b>{r.name}</b> {r.ref && <RowSub>{r.ref}</RowSub>}
        {r.untagged && <RowSub>{r.untagged}</RowSub>}
        <MaturityTag m={r.maturity} />
        {r.action.kind === "install" && (
          <Button title={`install ${r.name} from ${r.fromOrg ? ORG : r.url}`} onClick={() => installFromOrg(r.repo, r.name, r.ref, { fromOrg: r.fromOrg, url: r.url })}>
            <Download size={14} /> install
          </Button>
        )}
      </div>
      {r.description && <SetNote>{r.description}</SetNote>}
      {r.action.kind === "problems" && r.action.words.map((w) => <SetWarn key={w}>{w}</SetWarn>)}
      <ApplyNote target={{ kind: "plugin-install", repo: r.repo }} />
    </div>
  );
}

/** One line saying what each maturity tag means — the explain route for the tags. */
function MaturityExplain() {
  return (
    <Explain of="the maturity tags">
      {PLUGIN_MATURITIES.map((l) => { const m = pluginMaturity({ maturity: l }); return <span key={l}><b>{m.label}</b>: {m.meaning}. </span>; })}
      Plugins that name no maturity are <b>{pluginMaturity({}).label}</b>: {pluginMaturity({}).meaning}.
    </Explain>
  );
}

export function AvailableList({ status }: { status: UpdatesStatus | null }) {
  if (!status) return null;
  const rows = availableRows(status);
  return (
    <>
      <Hint>Available from {ORG} <MaturityExplain /></Hint>
      {rows.length === 0 && <SetNote>{status.error ? "The list could not be loaded." : "Nothing else is listed there."}</SetNote>}
      {rows.map((r) => <AvailableRowView key={r.repo} r={r} />)}
    </>
  );
}

/** The one place a plugin from outside waterplane-dev goes in; its confirm says so. */
export function AddByUrl() {
  const [url, setUrl] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  // The address last SENT: the result note follows it, not the live box, so editing the box keeps the answer.
  const [sent, setSent] = useState<string | null>(null);
  const go = () => {
    const r = parseUrlInput(url);
    if (!r.ok) { setWhy(r.why); return; }
    setWhy(null);
    setSent(r.url);
    void installFromUrl(r.url);
  };
  return (
    <div className="plugin-sec">
      <Hint>Add by URL</Hint>
      <div className="plugin-field">
        <input type="text" inputMode="url" value={url} placeholder="https://github.com/owner/plugin"
          onChange={(e) => { setUrl(e.target.value); setWhy(null); }} onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
        <Button onClick={go}><Download size={14} /> install</Button>
      </div>
      {why && <SetWarn>{why}</SetWarn>}
      {sent && <ApplyNote target={{ kind: "plugin-install", url: sent }} />}
    </div>
  );
}

/** waterplane itself: current → latest, notes behind a tap, update / roll back, or the command and why. */
export function SelfRow({ status }: { status: UpdatesStatus }) {
  const [notes, setNotes] = useState(false);
  const s = status.self;
  const v = selfView(s, status);
  return (
    <div className="plugin-sec">
      <div className="plugin-head">
        <b>{BRAND.displayName}</b> <RowSub>{v.headline}</RowSub>
        {v.notes && <Button title="what changed" onClick={() => setNotes((x) => !x)}>{notes ? "hide notes" : "notes"}</Button>}
        {/* Notes are the NEXT version's text; What's new is THIS version's new things, with their state here. */}
        <Button title="this version's new things and a way to each" onClick={() => core().nav.open("whatsnew")}>what's new</Button>
        {v.showUpdate && s.latest && <Button variant="primary" onClick={() => updateSelf(s.current, s.latest!)}><Download size={14} /> update</Button>}
        {v.showRollback && s.rollbackTo && <Button title={`go back to ${s.rollbackTo}`} onClick={() => rollbackSelf(s.current, s.rollbackTo!)}><RotateCcw size={14} /> roll back</Button>}
      </div>
      {notes && v.notes && <pre className="update-log">{v.notes}</pre>}
      {v.why && <SetNote>{v.why}</SetNote>}
      {v.command && (
        <SetNote>
          <code>{v.command}</code>{" "}
          <Button title="copy the command" onClick={() => void copyText(v.command!)}>copy</Button>
        </SetNote>
      )}
      <ApplyNote target={{ kind: "self" }} />
      <ApplyNote target={{ kind: "self-rollback" }} />
    </div>
  );
}
