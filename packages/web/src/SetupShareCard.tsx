/**
 * The Agent readings region's "Compare setups" card (R-metrics-073): export this desktop's setup
 * block, import a colleague's, and read the two side by side. No screen of its own: a card in the
 * region, under the headline.
 *
 *  - Export: the name is asked once and kept on this phone (`LS.setupShareName`, never synced). The
 *    block is shared `setupShareOf` over the region's own points; the PREVIEW is exactly
 *    `setupShareText(block)` — the string copy writes, and the one the desktop re-reads strictly
 *    and writes to `.claude/outbox/` (never git) for the one download button to fetch.
 *  - Import: paste or pick a file; shared `parseSetupShare` refuses with a sentence or keeps only
 *    the fields it names. Kept on this phone (`LS.setupShareImports`, device only), each removable
 *    with a `ConfirmButton`, and re-read through the same parser on every load.
 *  - Side by side: two figures per row (yours, theirs), never a difference, a ranking or a verdict;
 *    the repo's half says it is identical by construction, or that it is NOT; each imported block
 *    names whose desktop it came from (`shareSourceText`, R-metrics-069).
 */
import { useMemo, useRef, useState } from "react";
import {
  SETUP_SHARE_MAX_CHARS, START_GROUPS, isAgentAbsent, parseSetupShare, setupShareCompare, setupShareOf, setupShareText, shareNameProblem, shareSourceText, cleanShareName,
  type AgentPointsResponse, type SetupShareBlock, type SetupShareProbe,
} from "@waterplane/shared";
import { api } from "./api";
import { Button } from "./kit/Button";
import { ConfirmButton } from "./Confirm";
import { DownloadButton } from "./DownloadButton";
import { Explain } from "./Explain";
import { useOfflineGate } from "./kit/offlineGate";
import { copyText } from "./webapi/webapiClipboard";
import { showToast } from "./toast";
import { LS, lsGet, lsJson, lsSet, lsSetJson } from "./storage";
import type { RemoteResource } from "./useRemoteResource";
import {
  SHARE_CAPTION, SHARE_COPIED, SHARE_COPY_REFUSED, SHARE_HELP, SHARE_IMPORT_ASK, SHARE_KEPT, SHARE_LEAVES, SHARE_NAME_ASK, SHARE_NO_POINTS, SHARE_TITLE,
  shareImportedText, shareProbeLine, shareProbeNote, shareStartLine, shareRanLine, shareRepoHalfText, shareRowLine, shareSavedText,
} from "./agentReadingsWords";

/** Most blocks this phone keeps. */
const MAX_IMPORTS = 12;

/** The stored blocks, each re-read through the strict parser: a stored text this version cannot read is not drawn. */
function readImports(): SetupShareBlock[] {
  const raw = lsJson<unknown>(LS.setupShareImports, []);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => { const p = parseSetupShare(t); return p.ok ? [p.block] : []; });
}
function writeImports(bs: readonly SetupShareBlock[]): void {
  lsSetJson(LS.setupShareImports, bs.map(setupShareText));
}

function SideBySide({ mine, theirs, onRemove }: { mine: SetupShareBlock | null; theirs: SetupShareBlock; onRemove: () => void }) {
  const cmp = mine ? setupShareCompare(mine, theirs) : null;
  const name = theirs.from;
  return (
    <div className="ar-part-group">
      <div className="ar-chart-title">{name}</div>
      <div className="rh-cap">{shareSourceText(name, theirs.days)}</div>
      {mine ? <div className="rh-cap">{shareRanLine(mine, "you")}</div> : null}
      <div className="rh-cap">{shareRanLine(theirs, name)}</div>
      {mine ? <div>{shareStartLine(mine, "you")}</div> : null}
      <div>{shareStartLine(theirs, name)}</div>
      {mine?.probe || theirs.probe ? (<>
        {mine ? <div>{shareProbeLine(mine, "you")}</div> : null}
        <div>{shareProbeLine(theirs, name)}</div>
        {shareProbeNote(mine, theirs) ? <div className="rh-cap">{shareProbeNote(mine, theirs)}</div> : null}
      </>) : null}
      {cmp ? cmp.groups.map((g) => (
        <div key={g.group} className="ar-part-group">
          <div className="ar-chart-title">{shareRowLine(g.label, g.mine, g.theirs, name)}</div>
          <div className="rh-cap">{g.group === "repo" ? shareRepoHalfText(cmp.repoHalf, theirs) : g.note}</div>
          {g.parts.map((p) => <div key={p.key}>{shareRowLine(p.label, p.mine, p.theirs, name)}</div>)}
        </div>
      )) : theirs.groups.map((g) => (
        <div key={g.group} className="ar-part-group">
          <div className="ar-chart-title">{shareRowLine(START_GROUPS.find((x) => x.id === g.group)?.label ?? g.group, undefined, g.chars, name)}</div>
        </div>
      ))}
      {cmp && !cmp.groups.some((g) => g.group === "repo") ? <div className="rh-cap">{shareRepoHalfText(cmp.repoHalf, theirs)}</div> : null}
      <div className="rh-cap">{SHARE_CAPTION}</div>
      <div className="ar-share-acts">
        <ConfirmButton className="key" confirm={`remove ${name}'s?`} onConfirm={onRemove}>remove</ConfirmButton>
      </div>
    </div>
  );
}

export function SetupShareCard({ repoId, pts, probe }: {
  repoId: string; pts: RemoteResource<AgentPointsResponse>;
  /** The newest non-void probe result's summary (`probeShareOf`), or null: the block's probe slot. */
  probe?: SetupShareProbe | null;
}) {
  const doc = pts.data?.ok ? pts.data : null;
  const [name, setName] = useState<string | null>(() => cleanShareName(lsGet(LS.setupShareName)));
  const [nameDraft, setNameDraft] = useState("");
  const [mode, setMode] = useState<null | "export" | "import">(null);
  const [paste, setPaste] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [imports, setImports] = useState<SetupShareBlock[]>(readImports);
  const [saved, setSaved] = useState<{ relPath: string; size: number; mtime: number; text: string } | null>(null);
  const [saveRefused, setSaveRefused] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const gate = useOfflineGate();

  const build = (who: string) => (doc
    ? setupShareOf(doc.points, { now: Date.now(), from: who, backend: "claude", repo: doc.share ?? null, probe: probe ?? null })
    : null);
  const block = useMemo(() => (name ? build(name) : null), [doc, name, probe]); // eslint-disable-line react-hooks/exhaustive-deps
  // Yours for the side by side: the same builder; the name is not shown there, so "you" stands in until one is set.
  const mine = useMemo(() => build(name ?? "you"), [doc, name, probe]); // eslint-disable-line react-hooks/exhaustive-deps
  const mineBlock = mine && !isAgentAbsent(mine) ? mine : null;
  const text = block && !isAgentAbsent(block) ? setupShareText(block) : null;
  // A file written for earlier words is not offered beside a preview of new ones.
  const savedNow = saved && saved.text === text ? saved : null;

  const keepName = () => {
    const problem = shareNameProblem(nameDraft);
    if (problem) { setRefusal(problem); return; }
    const n = cleanShareName(nameDraft)!;
    lsSet(LS.setupShareName, n);
    setName(n);
    setRefusal(null);
    showToast(`The block will say it is from ${n}.`);
  };
  const copy = async () => {
    if (!text) return;
    showToast((await copyText(text)) ? SHARE_COPIED : SHARE_COPY_REFUSED);
  };
  const save = gate.guard("save the block to the outbox", async () => {
    if (!block || isAgentAbsent(block)) return;
    setSaveRefused(null);
    try {
      const r = await api.setupShareWrite(repoId, block);
      if (r.ok) { setSaved({ relPath: r.relPath, size: r.size, mtime: r.mtime, text: setupShareText(block) }); showToast(shareSavedText(r.relPath)); }
      else { setSaveRefused(r.error); showToast(r.error); }
    } catch (err) {
      const why = `The desktop did not take the block: ${err instanceof Error ? err.message : String(err)}`;
      setSaveRefused(why);
      showToast(why);
    }
  });
  const take = (raw: string) => {
    const p = parseSetupShare(raw);
    if (!p.ok) { setRefusal(p.why); showToast(p.why); return; }
    const same = (b: SetupShareBlock) => setupShareText(b) === setupShareText(p.block);
    const next = [p.block, ...imports.filter((b) => !same(b))].slice(0, MAX_IMPORTS);
    writeImports(next);
    setImports(next);
    setPaste("");
    setRefusal(null);
    setMode(null);
    showToast(shareImportedText(p.block.from, p.dropped));
  };
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > SETUP_SHARE_MAX_CHARS * 4) { const why = parseSetupShare("x".repeat(SETUP_SHARE_MAX_CHARS + 1)); if (!why.ok) { setRefusal(why.why); showToast(why.why); } return; }
    f.text().then(take, () => { setRefusal("The file could not be read."); showToast("The file could not be read."); });
  };
  const remove = (b: SetupShareBlock) => {
    const next = imports.filter((x) => x !== b);
    writeImports(next);
    setImports(next);
    showToast(`Removed ${b.from}'s setup from this phone.`);
  };

  return (
    <div className="rh-card">
      <div className="section-head">
        <span className="rh-chart-label">{SHARE_TITLE}</span>
        <Explain of={SHARE_TITLE}>{SHARE_HELP}</Explain>
      </div>
      <div className="rh-gutter">
        <div className="ar-share-acts">
          <Button className={mode === "export" ? "active" : undefined} onClick={() => { setMode(mode === "export" ? null : "export"); setRefusal(null); }}>export mine</Button>
          <Button className={mode === "import" ? "active" : undefined} onClick={() => { setMode(mode === "import" ? null : "import"); setRefusal(null); }}>import</Button>
        </div>

        {mode === "export" ? (!name ? (<>
          <div className="rh-cap">{SHARE_NAME_ASK}</div>
          <div className="ar-share-acts">
            <input className="ar-share-name" value={nameDraft} maxLength={60} onChange={(e) => setNameDraft(e.target.value)} aria-label="your name on the block" />
            <Button variant="primary" onClick={keepName}>keep this name</Button>
          </div>
          {refusal ? <div className="rh-cap">{refusal}</div> : null}
        </>) : !doc ? <div className="rh-cap">{SHARE_NO_POINTS}</div>
          : block && isAgentAbsent(block) ? <div className="rh-cap">{block.absent}</div>
            : text ? (<>
              <div className="rh-cap">{SHARE_LEAVES}</div>
              <pre className="ar-share-pre mono">{text}</pre>
              <div className="ar-share-acts">
                <Button variant="primary" onClick={() => { void copy(); }}>copy</Button>
                <Button onClick={save}>save to outbox</Button>
                {savedNow ? <DownloadButton target={{ repoId, relPath: savedNow.relPath, name: savedNow.relPath.split("/").pop(), size: savedNow.size, mtime: savedNow.mtime }} trackId="action:agents.share" /> : null}
                <Button onClick={() => { setName(null); setNameDraft(name); }}>change name</Button>
              </div>
              {savedNow ? <div className="rh-cap">{shareSavedText(savedNow.relPath)}</div> : null}
              {saveRefused ? <div className="rh-cap">{saveRefused}</div> : null}
              {gate.note}
            </>) : null) : null}

        {mode === "import" ? (<>
          <div className="rh-cap">{SHARE_IMPORT_ASK}</div>
          <textarea className="ar-share-paste mono" value={paste} rows={6} spellCheck={false}
            onChange={(e) => setPaste(e.target.value)} aria-label="a setup block to import" />
          <div className="ar-share-acts">
            <Button variant="primary" onClick={() => take(paste)}>import this</Button>
            <Button onClick={() => pick.current?.click()}>pick a file</Button>
            <input ref={pick} type="file" accept=".json,application/json,text/plain" hidden onChange={onFile} />
          </div>
          {refusal ? <div className="rh-cap">{refusal}</div> : null}
        </>) : null}

        {imports.length ? (<>
          {mine && isAgentAbsent(mine) ? <div className="rh-cap">Yours: {mine.absent}</div> : null}
          {imports.map((b) => <SideBySide key={setupShareText(b)} mine={mineBlock} theirs={b} onRemove={() => remove(b)} />)}
          <div className="rh-cap">{SHARE_KEPT}</div>
        </>) : null}
      </div>
    </div>
  );
}
