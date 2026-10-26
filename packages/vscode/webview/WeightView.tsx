import { CHARS_PER_TOKEN, READER_NAME as AGENT_NAME, alwaysOnTotalsWords, desktopPathWords, fmtCount, isUnsizedServer, overlapWords } from "@waterplane/shared";
import type { PromptDef, ToExtension, WeightDoc } from "../src/protocol";
import { useState } from "react";
import { SCRUB_HINT } from "@waterplane/kit";
import { AO_BAND_NAME, AO_SLOT, aoBandFigure, aoHeadWords, aoLeftOutWords, aoMarkerFold, aoPick, aoPlot, aoSegWords } from "../../web/src/alwaysOnPlot";
import type { AoSeg } from "../../web/src/alwaysOnPlot";
import { Absent } from "./Absent";
import { PromptActions } from "./Actions";
import { TabLinks } from "./TabLinks";
import type { Agent, AgentTotals, InstructionFile, When } from "../src/protocol";


function readersWords(rs: Agent[], off: InstructionFile["off"]): string {
  if (rs.length) return rs.map((a) => AGENT_NAME[a]).join(", ") + (off ? ` (Copilot: ${off} is off)` : "");
  return off ? `nobody: ${off} is off` : "nobody";
}

function whenWords(w: When): string {
  if (w.kind === "always") return "every request";
  if (w.kind === "scoped") return `when a file matches ${w.globs.join(", ")}`;
  return "on demand";
}

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

/**
 * The rows of one file list. A row with no parts is UNSIZED (an MCP server, a plugin outside the
 * config dir, a source that could not be read): it says so in the Chars column, never a 0, and only
 * an MCP server — whose schemas do ride every request — says "every request" in When.
 * `pathWords` words a desktop row's path (shared `desktopPathWords`); repo rows print as they are.
 */
function FileRows({ files, pathWords = (p: string) => p }: { files: InstructionFile[]; pathWords?: (p: string) => string }) {
  return (
    <>
      {files.flatMap((f) => f.parts.length === 0
        ? [(
          <tr key={`${f.path}#${f.kind}#unsized`}>
            <th scope="row">{pathWords(f.path)}<div className="ctx-note">{f.kind}</div></th>
            <td>Claude Code</td>
            <td>{isUnsizedServer(f) ? "every request" : "—"}</td>
            <td className="num wt-unsized">{f.unsized ?? "not measured"}</td>
          </tr>
        )]
        : f.parts.map((p, i) => (
          <tr key={`${f.path}#${i}`}>
            <th scope="row">{i === 0 ? <>{pathWords(f.path)}<div className="ctx-note">{f.kind}</div></> : <span className="ctx-note">{pathWords(f.path)}, {p.when.kind === "always" ? "description" : "body"}</span>}</th>
            <td>{readersWords(p.readers, f.off)}</td>
            <td>{whenWords(p.when)}</td>
            <td className="num">{fmtCount(p.chars)}</td>
          </tr>
        )))}
    </>
  );
}

const FILE_HEAD = (
  <thead><tr><th scope="col">File</th><th scope="col">Read by</th><th scope="col">When</th><th scope="col" className="num">Chars</th></tr></thead>
);

/** This desktop's own files — user CLAUDE.md, auto-memory, user skills, plugins, user MCP — which every session here carries whatever the folder. */
function DesktopBlock({ doc }: { doc: WeightDoc }) {
  if (doc.desktop === undefined) return null;
  return (
    <>
      <div className="ctx-chart-title">This desktop</div>
      {doc.desktop === null ? <Absent>{doc.desktopWhy ?? "This desktop’s own files could not be read."}</Absent> : doc.desktop.length === 0 ? (
        <Absent>This desktop has no user-level CLAUDE.md, auto-memory, user skills, plugins or MCP servers that a session here would carry.</Absent>
      ) : (
        <>
          <div className="empty ctx-note">These ride along in every session on this machine, in whatever folder — as far as the files on disk show: plugin packs synced from claude.ai are not on disk, so a session’s measured skill listing (Session tab) is the truth. The threshold row above counts none of them.</div>
          <table className="plain">{FILE_HEAD}<tbody><FileRows files={doc.desktop} pathWords={(p) => desktopPathWords(p, doc.configDir)} /></tbody></table>
        </>
      )}
    </>
  );
}

/** What this folder's CLAUDE.md and skill descriptions cost on EVERY turn (bodies load on demand and are not counted). */
const SLOT = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

/**
 * The phone's always-on strip (web `alwaysOnPlot.ts`, one geometry): every-turn chars per file,
 * coloured by what the threshold does with them; unsized rows are named outlined markers, never a
 * length. Hovering reads the file under the pointer in a text line.
 */
function WeightStrip({ files, configDir }: { files: InstructionFile[]; configDir?: string }) {
  const p = aoPlot(files, ["repo", "desktop"]);
  const [pick, setPick] = useState<string | null>(null);
  const picked = p.segs.find((s) => s.key === pick) ?? null;
  const pathWords = (s: AoSeg) => (s.scope === "desktop" ? desktopPathWords(s.path, configDir) : s.path);
  const { shown, more } = aoMarkerFold(p.markers);
  const leftOut = aoLeftOutWords(p);
  if (!p.segs.length && !p.markers.length) return null;
  return (
    <>
      <div className="ctx-chart-title">{aoHeadWords(p, fmtCount)}</div>
      {p.segs.length > 0 && (
        <>
          <div className="wt-split wt-pos" role="group" aria-label="where the every-turn characters go, file by file"
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const i = r.width > 0 ? aoPick(p.segs, (e.clientX - r.left) / r.width) : null;
              setPick(i == null ? null : p.segs[i].key);
            }}
            onPointerLeave={() => setPick(null)}>
            {p.segs.map((s) => (
              <span key={s.key} className="wt-seg" style={{
                left: `${s.x}%`, width: `${s.w}%`, background: SLOT[AO_SLOT[s.band]],
                boxShadow: s.key === pick ? "inset 0 0 0 2px var(--fg)" : s.seam ? "inset -1px 0 0 var(--panel)" : undefined,
              }} />
            ))}
          </div>
          <div className="empty ctx-note">{picked ? aoSegWords(picked, p.total, pathWords, fmtCount) : SCRUB_HINT}</div>
          <div className="ts-legend">
            {p.bands.map((b) => (
              <span key={b.band} className="ts-leg">
                <i style={{ background: SLOT[AO_SLOT[b.band]] }} />
                <b>{AO_BAND_NAME[b.band]}</b> {aoBandFigure(b, fmtCount)} · {b.files} {b.files === 1 ? "file" : "files"}
              </span>
            ))}
          </div>
        </>
      )}
      {shown.length > 0 && (
        <div className="empty ctx-note">
          No size:{" "}
          {shown.map((m) => (
            <span key={m.key} style={{ border: "1px dashed var(--muted)", borderRadius: 4, padding: "0 6px", marginRight: 6 }}>{m.kind}</span>
          ))}
          {more > 0 ? `+${more} more` : null}
        </div>
      )}
      {leftOut && <div className="empty ctx-note">{leftOut}</div>}
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
  if (!doc) return <Absent>{why ?? "No CLAUDE.md or skills were found in this folder."}</Absent>;
  const r = doc.reading;
  const skills = [...doc.skills].sort((a, b) => b.descChars - a.descChars);
  const descTotal = skills.reduce((n, s) => n + s.descChars, 0);
  // Nothing to weigh is a sentence, not "~0 tokens" over a half-and-half bar of two zeros.
  if (!doc.files.length) {
    return (
      <>
        <Absent>This folder has no CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, instruction files, rules or skills, so neither Claude Code nor Copilot carries anything from it.</Absent>
        <DesktopBlock doc={doc} />
        <TabLinks tabs={["session", "all"]} post={post} />
      </>
    );
  }
  const groom = prompts.find((p) => p.id === "groom-claudemd");
  const shrink = prompts.find((p) => p.id === "shrink-skill-descs");
  const { claude, copilot } = doc.agents;
  return (
    <>
      <div className="ctx-chart-title">What this folder’s instructions cost on every request</div>
      <AgentHead name="Claude Code" t={claude} />
      <AgentHead name="GitHub Copilot" t={copilot} />
      <div className="empty ctx-note">{alwaysOnTotalsWords([...doc.files, ...(doc.desktop ?? [])])}</div>
      <WeightStrip files={[...doc.files, ...(doc.desktop ?? [])]} configDir={doc.configDir} />
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

      <div className="ctx-chart-title">Files</div>
      <table className="plain">{FILE_HEAD}<tbody><FileRows files={doc.files} /></tbody></table>
      <div className="empty ts-caveat">
        This table is the folder’s own files, CLAUDE.local.md, subagent descriptions and MCP servers included; the threshold above counts CLAUDE.md, its imports, rules and skill descriptions, and the rest are listed beside it. A row marked not measured is named, never counted as zero. This desktop’s user-level files are in the “This desktop” table; ~/.copilot/… and nested AGENTS.md files (off by default in VS Code) are not listed.
        Copilot’s readers follow VS Code’s instruction settings: one you turned off drops Copilot from that row.
        About 4 characters to a token. Skill bodies ({fmtCount(r.onDemandChars)} characters for Claude Code) load only when a skill is used.
      </div>

      <DesktopBlock doc={doc} />

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
