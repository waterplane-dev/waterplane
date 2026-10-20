import { BRAND, fmtCount } from "@waterplane/shared";
import type { PromptDef, ToExtension, WeightDoc } from "../src/protocol";
import { Absent } from "./Absent";
import { PromptActions } from "./Actions";

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
  if (doc.claudeMdChars === 0 && skills.length === 0) {
    return <Absent>This folder has no CLAUDE.md, .claude/CLAUDE.md or skills, so Claude Code carries nothing from it on every turn.</Absent>;
  }
  const groom = prompts.find((p) => p.id === "groom-claudemd");
  const shrink = prompts.find((p) => p.id === "shrink-skill-descs");
  return (
    <>
      <div className="ctx-chart-title">What this folder’s CLAUDE.md costs on every turn</div>
      <div className="cost-head">
        <span className="cost-total">~{fmtCount(r.alwaysOnTokens)}</span>
        <span className="cost-label">tokens · {fmtCount(r.alwaysOnChars)} characters, carried by every request</span>
      </div>
      <div className="wt-split" role="img" aria-label={`${fmtCount(doc.claudeMdChars)} characters CLAUDE.md, ${fmtCount(descTotal)} characters skill descriptions`}>
        <span className="wt-seg wt-a" style={{ flexGrow: Math.max(doc.claudeMdChars, 1) }} />
        <span className="wt-seg wt-b" style={{ flexGrow: Math.max(descTotal, 1) }} />
      </div>
      <div className="ts-legend">
        <span className="ts-leg"><i className="wt-a" /><b>CLAUDE.md</b> {fmtCount(doc.claudeMdChars)} chars</span>
        <span className="ts-leg"><i className="wt-b" /><b>Skill descriptions</b> {fmtCount(descTotal)} chars</span>
      </div>
      <div className="empty ctx-note">{r.note}</div>
      {r.advice && <div className="empty ctx-note">{r.advice}</div>}
      <div className="empty ts-caveat">
        This folder’s CLAUDE.md and .claude/CLAUDE.md and its skills only, the same files {BRAND.name}’s host measures; your user-level ~/.claude/CLAUDE.md and a CLAUDE.local.md are not counted here.
        About 4 characters to a token. Skill bodies ({fmtCount(r.onDemandChars)} characters) load only when a skill is used, so they are not in the figure.
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
