import { CHARS_PER_TOKEN, READER_NAME as AGENT_NAME, fmtCount, overlapWords } from "@waterplane/shared";
import type { PromptDef, ToExtension, WeightDoc } from "../src/protocol";
import { Absent } from "./Absent";
import { PromptActions } from "./Actions";
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

/** What this folder's CLAUDE.md and skill descriptions cost on EVERY turn (bodies load on demand and are not counted). */
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
    return <Absent>This folder has no CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, instruction files, rules or skills, so neither Claude Code nor Copilot carries anything from it.</Absent>;
  }
  const groom = prompts.find((p) => p.id === "groom-claudemd");
  const shrink = prompts.find((p) => p.id === "shrink-skill-descs");
  const { claude, copilot } = doc.agents;
  return (
    <>
      <div className="ctx-chart-title">What this folder’s instructions cost on every request</div>
      <AgentHead name="Claude Code" t={claude} />
      <AgentHead name="GitHub Copilot" t={copilot} />

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
      <table className="plain">
        <thead><tr><th scope="col">File</th><th scope="col">Read by</th><th scope="col">When</th><th scope="col" className="num">Chars</th></tr></thead>
        <tbody>
          {doc.files.flatMap((f) => f.parts.map((p, i) => (
            <tr key={`${f.path}#${i}`}>
              <th scope="row">{i === 0 ? <>{f.path}<div className="ctx-note">{f.kind}</div></> : <span className="ctx-note">{f.path}, {p.when.kind === "always" ? "description" : "body"}</span>}</th>
              <td>{readersWords(p.readers, f.off)}</td>
              <td>{whenWords(p.when)}</td>
              <td className="num">{fmtCount(p.chars)}</td>
            </tr>
          )))}
        </tbody>
      </table>
      <div className="empty ts-caveat">
        Folder files only. User-level instructions (~/.claude/CLAUDE.md, ~/.copilot/…), CLAUDE.local.md and nested AGENTS.md files (off by default in VS Code) are not counted.
        Copilot’s readers follow VS Code’s instruction settings: one you turned off drops Copilot from that row.
        About 4 characters to a token. Skill bodies ({fmtCount(r.onDemandChars)} characters for Claude Code) load only when a skill is used.
      </div>

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
