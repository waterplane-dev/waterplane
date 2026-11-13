/**
 * The rows of the skills screen: a plugin card (one on/off switch for the whole plugin, its skills
 * listed read-only under a fold) and a skill row (the four states). A selector tap only changes the
 * draft. What a row cannot do is a sentence, never a dimmed button.
 */
import { ChevronRight, Plug, Sparkles } from "lucide-react";
import type { PluginRow, SkillRow, SkillState, SwitchLevel } from "@waterplane/shared";
import { SKILL_STATES, skillPluginSkillLine, skillPluginNotSwitchable, SKILL_UNMEASURED } from "@waterplane/shared";
import { Button, Hint, Row, RowSub, RowTitle, Tag } from "../../kit";
import { choose } from "./actions";
import { STATE_TITLES, STATE_WORDS, canInherit, pluginTag, shownEnabled, shownState, stateTag, tilde, usesWords, type Draft } from "./logic";

const ICON = 14;

/** "~120 tokens", or the sentence for a row nobody could measure — never a 0. */
const weightWords = (chars: number | undefined): string => (chars === undefined ? SKILL_UNMEASURED : tilde(chars));

function InheritButton({ row, level, draft }: { row: SkillRow | PluginRow; level: SwitchLevel; draft: Draft }) {
  if (!canInherit(row, level, draft)) return null;
  const where = level === "global" ? "the default" : "the all-repos setting";
  return (
    <div className="sk-inherit">
      <Button className="sk-link" onClick={() => choose(row, "inherit")} title={`remove this row's setting from the file, so ${where} applies`}>
        use {where}
      </Button>
    </div>
  );
}

export function SkillRowView({ row, draft, level }: { row: SkillRow; draft: Draft; level: SwitchLevel }) {
  const shown = shownState(row, draft);
  // A locked row says so once, in its hint; the tag is for a state somebody chose.
  const tag = row.locked ? null : stateTag(row);
  const uses = usesWords(row);
  const changed = `skill:${row.id}` in draft;
  return (
    <div className={`sk-card${changed ? " sk-changed" : ""}`}><Row kind="grow">
      <RowTitle><Sparkles size={ICON} /> {row.id}</RowTitle>
      <RowSub>{[weightWords(row.listingChars), uses].filter(Boolean).join(" · ")}{tag ? <> <Tag>{tag}</Tag></> : null}</RowSub>
      {row.locked ? <Hint>{row.locked}</Hint>
        : !row.switchable ? <Hint>{row.why ?? (row.plugin ? skillPluginNotSwitchable(row.plugin) : "This skill cannot be switched from here.")}</Hint>
        : (
          // raw buttons: the kit's .segmented/.seg is a plain button pair everywhere (05-rows-approve.css)
          <div className="segmented sk-sel" role="group" aria-label={`${row.id} state`}>
            {SKILL_STATES.map((s: SkillState) => (
              <button key={s} className={`seg${shown === s ? " on" : ""}`} aria-pressed={shown === s} title={STATE_TITLES[s]} onClick={() => choose(row, s)}>
                {STATE_WORDS[s]}
              </button>
            ))}
          </div>
        )}
      {shown === "inherit" && <Hint>Will use the {level === "global" ? "default" : "all-repos setting"} after saving.</Hint>}
      {row.switchable && !row.locked && <InheritButton row={row} level={level} draft={draft} />}
    </Row></div>
  );
}

export function PluginCard({ row, skills, draft, level }: { row: PluginRow; skills: SkillRow[]; draft: Draft; level: SwitchLevel }) {
  const shown = shownEnabled(row, draft);
  const tag = row.from === "locked" ? null : pluginTag(row);
  const changed = `plugin:${row.id}` in draft;
  const locked = row.from === "locked";
  return (
    <div className={`sk-card sk-plugin${changed ? " sk-changed" : ""}`}><Row kind="grow">
      <RowTitle><Plug size={ICON} /> {row.name}{row.version ? <span className="sk-ver"> {row.version}</span> : null}</RowTitle>
      <RowSub>
        {[weightWords(row.listingChars), `${row.skills.length} skill${row.skills.length === 1 ? "" : "s"}`].join(" · ")}
        {tag ? <> <Tag>{tag}</Tag></> : null}
      </RowSub>
      {row.why && <Hint>{row.why}</Hint>}
      {locked ? <Hint>Locked by policy; this screen cannot change it.</Hint> : (
        <div className="segmented sk-sel" role="group" aria-label={`${row.name} plugin`}>
          <button className={`seg${shown === true ? " on" : ""}`} aria-pressed={shown === true} onClick={() => choose(row, true)}>on</button>
          <button className={`seg${shown === false ? " on" : ""}`} aria-pressed={shown === false} onClick={() => choose(row, false)}>off</button>
        </div>
      )}
      {shown === "inherit" && <Hint>Will use the {level === "global" ? "default" : "all-repos setting"} after saving.</Hint>}
      {row.mcpServers ? <Hint>Off also removes its connector tools ({row.mcpServers} server{row.mcpServers === 1 ? "" : "s"}).</Hint> : null}
      {!locked && <InheritButton row={row} level={level} draft={draft} />}
      {skills.length > 0 && (
        <details className="sk-fold">
          <summary><ChevronRight size={ICON} className="sk-chev" aria-hidden /> details · {skills.length} skill{skills.length === 1 ? "" : "s"}</summary>
          {skills.map((s) => (
            <div key={s.id} className="sk-sub">
              <span className="sk-sub-name">{s.id}</span>
              <span className="sk-sub-meta">{[weightWords(s.listingChars), usesWords(s), skillPluginSkillLine(row.name)].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
        </details>
      )}
    </Row></div>
  );
}
