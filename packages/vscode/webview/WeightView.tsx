import { CHARS_PER_TOKEN, alwaysOnTotalsWords, fmtCount, overlapWords } from "@waterplane/shared";
import type { AlwaysOnRow } from "@waterplane/shared";
import type { PromptDef, ToExtension, WeightDoc } from "../src/protocol";
import { useState } from "react";
import { AO_SCOPES, AlwaysOnStrip, AoFileList, aoScopeChips } from "../../web/src/AlwaysOnRows";
import { aoPlot } from "../../web/src/alwaysOnPlot";
import type { AoPlot } from "../../web/src/alwaysOnPlot";
import { FilterChip } from "../../web/src/kit/FilterChip";
import { toggleChip } from "../../web/src/kit/chips";
import { Absent } from "./Absent";
import { PromptActions } from "./Actions";
import { TabLinks } from "./TabLinks";
import type { AgentTotals } from "../src/protocol";


/** One agent's line: what it carries every request, then what joins when a file matches and on demand. */
function AgentHead({ name, t }: { name: string; t: AgentTotals }) {
  if (!t.files) return <div className="cost-head"><span className="cost-label"><b>{name}</b> reads none of these files.</span></div>;
  const extra = [
    t.scoped ? `${fmtCount(t.scoped)} more when a matching file is touched` : null,
    t.onDemand ? `${fmtCount(t.onDemand)} on demand` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="cost-head">
      <span className="cost-total">~{fmtCount(Math.round(t.always / CHARS_PER_TOKEN))}</span>
      <span className="cost-label"><b>{name}</b> tokens · {fmtCount(t.always)} characters every request, from {t.files} {t.files === 1 ? "file" : "files"}{extra ? ` · ${extra} (characters)` : ""}</span>
    </div>
  );
}

/** This desktop's own files — user CLAUDE.md, auto-memory, user skills, plugins, user MCP — which every session here carries whatever the folder. */
function DesktopBlock({ doc, strip, plot, pick, onPick }: {
  doc: WeightDoc;
  /** Draw the strip over these rows — when the folder adds nothing, the top strip is not drawn. */
  strip?: boolean;
  /** The plot of the strip these rows' meters read on (the view's, or this block's own). */
  plot: AoPlot;
  pick: string | null;
  onPick: (key: string | null) => void;
}) {
  if (doc.desktop === undefined) return null;
  return (
    <>
      <div className="ctx-chart-title">This desktop</div>
      {doc.desktop === null ? <Absent>{doc.desktopWhy ?? "This desktop’s own files could not be read."}</Absent> : doc.desktop.length === 0 ? (
        <Absent>This desktop has no user-level CLAUDE.md, auto-memory, user skills, plugins or MCP servers that a session here would carry.</Absent>
      ) : (
        <>
          <div className="empty ctx-note">These ride along in every session on this machine, in whatever folder — as far as the files on disk show: plugin packs synced from claude.ai are not on disk, so a session’s measured skill listing (Session tab) is the truth. The threshold row above counts none of them.</div>
          {strip && <div className="wt-strip"><AlwaysOnStrip files={doc.desktop} scopes={["desktop"]} configDir={doc.configDir} pick={pick} onPick={onPick} /></div>}
          <AoFileList rows={aoScopeChips(doc).bucket("desktop")} plot={plot} configDir={doc.configDir}
            pick={pick} onPick={onPick} />
        </>
      )}
    </>
  );
}

type Scope = AlwaysOnRow["scope"];

/**
 * The phone's repo/desktop chips over the always-on list (web `aoScopeChips`: ONE bucketing feeds
 * the numbers and the cut), above the phone's strip itself (`AlwaysOnStrip`) over the same cut. A
 * count on a chip is a filter: the cut view says "n of N" and how to show all.
 */
function ScopeChips({ chips, cut, setCut, shownN, totalN }: {
  chips: { key: Scope; text: string }[];
  cut: Scope | null;
  setCut: (s: Scope | null) => void;
  shownN: number;
  totalN: number;
}) {
  if (chips.length < 2) return null;
  return (
    <>
      <div className="fchips wrap wt-chips" role="group" aria-label="which files">
        {chips.map((c) => (
          <FilterChip key={c.key} on={cut === c.key} onClick={() => setCut(toggleChip(cut, c.key))}
            title={`Only the files ${c.key === "repo" ? "this folder" : "this desktop"} adds`}>
            {c.text}
          </FilterChip>
        ))}
      </div>
      {cut && <div className="empty ctx-note">{shownN} of {totalN} files — the other file table is hidden; click the lit chip to show both.</div>}
    </>
  );
}

export function WeightView({ doc, why, prompts, terminal, post }: {
  doc: WeightDoc | null;
  why?: string;
  prompts: PromptDef[];
  terminal: string | null;
  post: (m: ToExtension) => void;
}) {
  const [cut, setCut] = useState<Scope | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  if (!doc) return <Absent>{why ?? "No CLAUDE.md or skills were found in this folder."}</Absent>;
  const r = doc.reading;
  const skills = [...doc.skills].sort((a, b) => b.descChars - a.descChars);
  const descTotal = skills.reduce((n, s) => n + s.descChars, 0);
  // Nothing to weigh is a sentence, not "~0 tokens" over a half-and-half bar of two zeros.
  if (!doc.files.length) {
    return (
      <>
        <Absent>This folder has no CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, instruction files, rules or skills, so neither Claude Code nor Copilot carries anything from it.</Absent>
        <DesktopBlock doc={doc} strip plot={aoPlot(doc.desktop ?? [], ["desktop"])} pick={pick} onPick={setPick} />
        <TabLinks tabs={["session", "all"]} post={post} />
      </>
    );
  }
  const groom = prompts.find((p) => p.id === "groom-claudemd");
  const { rows, bucket, chips } = aoScopeChips(doc);
  const shown = cut ? [cut] : AO_SCOPES;
  const all = [...doc.files, ...(doc.desktop ?? [])];
  // ONE plot for the strip's segments and every row's meter and order.
  const plot = aoPlot(all, shown);
  const openFile = (path: string) => post({ t: "openFile", folder: doc.folder, path });
  const shrink = prompts.find((p) => p.id === "shrink-skill-descs");
  const { claude, copilot } = doc.agents;
  return (
    <>
      <div className="ctx-chart-title">What this folder’s instructions cost on every request</div>
      <AgentHead name="Claude Code" t={claude} />
      <AgentHead name="GitHub Copilot" t={copilot} />
      <div className="empty ctx-note">{alwaysOnTotalsWords([...doc.files, ...(doc.desktop ?? [])])}</div>
      <ScopeChips chips={chips} cut={cut} setCut={setCut} shownN={cut ? bucket(cut).length : rows.length} totalN={rows.length} />
      <div className="wt-strip"><AlwaysOnStrip files={all} scopes={shown} configDir={doc.configDir} pick={pick} onPick={setPick} /></div>
      <TabLinks tabs={["session", "all"]} post={post} />

      {doc.overlaps.map((o) => (
        <div key={`${o.a}|${o.b}`} className="empty ctx-note">{overlapWords(o, fmtCount)}</div>
      ))}

      {claude.files > 0 ? (
        <>
          <div className="ctx-chart-title">Claude Code, every turn</div>
          <div className="wt-split" role="img" aria-label={`${fmtCount(r.alwaysOnChars - descTotal)} characters CLAUDE.md and what it pulls in, ${fmtCount(descTotal)} characters skill descriptions`}>
            <span className="wt-seg wt-a" style={{ flexGrow: Math.max(r.alwaysOnChars - descTotal, 1) }} />
            <span className="wt-seg wt-b" style={{ flexGrow: Math.max(descTotal, 1) }} />
          </div>
          <div className="ts-legend">
            <span className="ts-leg"><i className="wt-a" /><b>CLAUDE.md, imports, rules</b> {fmtCount(r.alwaysOnChars - descTotal)} chars</span>
            <span className="ts-leg"><i className="wt-b" /><b>Skill descriptions</b> {fmtCount(descTotal)} chars</span>
          </div>
          <div className="empty ctx-note">{r.note}</div>
          {r.advice && <div className="empty ctx-note">{r.advice}</div>}
        </>
      ) : null}
      {copilot.files > 0 ? (
        <div className="empty ctx-note">
          Copilot bills per premium request, not per token: what it carries here costs room in the context window and the model’s attention, not money.
        </div>
      ) : null}

      {cut !== "desktop" && (
        <>
          <div className="ctx-chart-title">Files</div>
          <AoFileList rows={bucket("repo")} plot={plot} onOpen={openFile} pick={pick} onPick={setPick} />
          <div className="empty ts-caveat">
        This table is the folder’s own files, CLAUDE.local.md, subagent descriptions and MCP servers included; the threshold above counts CLAUDE.md, its imports, rules and skill descriptions, and the rest are listed beside it. A row marked not measured is named, never counted as zero. This desktop’s user-level files are in the “This desktop” table; ~/.copilot/… and nested AGENTS.md files (off by default in VS Code) are not listed.
        Copilot’s readers follow VS Code’s instruction settings: one you turned off drops Copilot from that row.
        About 4 characters to a token. Skill bodies ({fmtCount(r.onDemandChars)} characters for Claude Code) load only when a skill is used.
          </div>
        </>
      )}

      {cut !== "repo" && <DesktopBlock doc={doc} plot={plot} pick={pick} onPick={setPick} />}

      <div className="ctx-chart-title">Skills</div>
      {skills.length === 0 ? <Absent>No skills in this folder.</Absent> : (
        <table className="plain">
          <thead><tr><th scope="col">Skill</th><th scope="col" className="num">Description, every turn</th><th scope="col" className="num">Body, on demand</th></tr></thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name}>
                <th scope="row">{s.name}</th>
                <td className="num">{fmtCount(s.descChars)}</td>
                <td className="num">{fmtCount(s.bodyChars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="ctx-chart-title">Groom it</div>
      {groom ? (
        <>
          <div className="ctx-summary">Asks Claude Code to propose a smaller CLAUDE.md as a diff. Nothing is applied until you say so.</div>
          <PromptActions id="groom-claudemd" terminal={terminal} post={post} />
        </>
      ) : <Absent>The groom prompt is not available in this version.</Absent>}
      {shrink && skills.length > 0 && (
        <>
          <div className="ctx-summary">Or ask for shorter skill descriptions, longest first.</div>
          <PromptActions id="shrink-skill-descs" terminal={terminal} post={post} />
        </>
      )}
    </>
  );
}
