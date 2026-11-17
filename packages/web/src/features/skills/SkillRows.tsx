/**
 * The rows of the skills screen: a plugin card (one on/off switch for the whole plugin, its skills
 * listed read-only under a fold) and a skill row (the four states). A selector tap only changes the
 * draft; a changed card carries its own This repo / All repos pair (where it is saved). What a row cannot do is a sentence, never a dimmed button.
 */
import { ChevronRight, Plug, Sparkles } from "lucide-react";
import type { PluginRow, SkillRow, SkillState, SwitchLevel } from "@waterplane/shared";
import { SKILL_STATES, skillPluginSkillLine, skillPluginNotSwitchable, SKILL_UNMEASURED } from "@waterplane/shared";
import { Button, Hint, Row, RowSub, RowTitle, Tag } from "../../kit";
import { choose, pin, scopeCard } from "./actions";
import { STATE_TITLES, STATE_WORDS, canInherit, changedOf, keyOf, rowView, scopeOf, sourceWords, tilde, usesWords, type Drafts, type Row as AnyRow, type Target } from "./logic";

const ICON = 14;

/** "~120 tokens", or the sentence for a row nobody could measure — never a 0. */
const weightWords = (chars: number | undefined): string => (chars === undefined ? SKILL_UNMEASURED : tilde(chars));

/**
 * Where the row's value comes from, said once under the selector: "follows All repos" (with a way to
 * keep it here) or "set for this repo; overrides All repos" (with a way back).
 */
function Source({ row, level, d }: { row: AnyRow; level: SwitchLevel; d: Drafts }) {
  const v = rowView(row, level, d.draft, d.allDraft);
  const words = sourceWords(v);
  if (!words) return null;
  const followsAll = v.follows.from === "repo-shared" ? "the shared repo file" : "All repos";
  return (
    <div className="sk-source">
      <Hint>{words}</Hint>
      {v.own && canInherit(row, level, d.draft)
        ? <Button className="sk-link" onClick={() => choose(row, "inherit")} title="remove this repo's own value, so the setting below it applies">follow {followsAll}</Button>
        // not on a changed card: its scope pair already says where the choice goes
        : !v.own && !(keyOf(row) in changedOf(d)) && <Button className="sk-link" onClick={() => pin(row)} title="write the value this row follows into this repo's file, so a later All-repos change does not move it">keep for this repo</Button>}
    </div>
  );
}

/** A changed card's own This repo / All repos pair: which file its choice is saved to. Only on a card with a choice. */
function ScopePair({ row, d, fallback, name }: { row: AnyRow; d: Drafts; fallback: Target; name: string }) {
  if (!(keyOf(row) in changedOf(d))) return null;
  const scope = scopeOf(row, d, fallback);
  return (
    <div className="sk-scope">
      <Hint>Applies to</Hint>
      {/* raw buttons: the kit's .segmented/.seg is a plain button pair everywhere (05-rows-approve.css) */}
      <div className="segmented" role="group" aria-label={`Where ${name}'s change applies`}>
        <button className={`seg${scope === "repo" ? " on" : ""}`} aria-pressed={scope === "repo"} onClick={() => scopeCard(row, "repo")}>this repo</button>
        <button className={`seg${scope === "all" ? " on" : ""}`} aria-pressed={scope === "all"} onClick={() => scopeCard(row, "all")}>all repos</button>
      </div>
    </div>
  );
}

export function SkillRowView({ row, d, level, fallback }: { row: SkillRow; d: Drafts; level: SwitchLevel; fallback: Target }) {
  const shown = rowView(row, level, d.draft, d.allDraft).value;
  // A locked row says so once, in its hint; where an unlocked value comes from is the Source line.
  const tag = row.locked ? (row.lockedBy === "author" ? "locked by the skill itself" : "locked by policy") : null;
  const uses = usesWords(row);
  const changed = keyOf(row) in changedOf(d);
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
      {row.switchable && !row.locked && <ScopePair row={row} d={d} fallback={fallback} name={row.id} />}
      {row.switchable && !row.locked && <Source row={row} level={level} d={d} />}
    </Row></div>
  );
}

export function PluginCard({ row, skills, d, level, fallback }: { row: PluginRow; skills: SkillRow[]; d: Drafts; level: SwitchLevel; fallback: Target }) {
  const shown = rowView(row, level, d.draft, d.allDraft).value;
  const changed = keyOf(row) in changedOf(d);
  const locked = row.from === "locked";
  return (
    <div className={`sk-card sk-plugin${changed ? " sk-changed" : ""}`}><Row kind="grow">
      <RowTitle><Plug size={ICON} /> {row.name}{row.version ? <span className="sk-ver"> {row.version}</span> : null}</RowTitle>
      <RowSub>
        {[weightWords(row.listingChars), `${row.skills.length} skill${row.skills.length === 1 ? "" : "s"}`].join(" · ")}
      </RowSub>
      {row.why && <Hint>{row.why}</Hint>}
      {locked ? <Hint>Locked by policy; this screen cannot change it.</Hint> : (
        <div className="segmented sk-sel" role="group" aria-label={`${row.name} plugin`}>
          <button className={`seg${shown === true ? " on" : ""}`} aria-pressed={shown === true} onClick={() => choose(row, true)}>on</button>
          <button className={`seg${shown === false ? " on" : ""}`} aria-pressed={shown === false} onClick={() => choose(row, false)}>off</button>
        </div>
      )}
      {!locked && <ScopePair row={row} d={d} fallback={fallback} name={row.name} />}
      {!locked && <Source row={row} level={level} d={d} />}
      {row.mcpServers ? <Hint>Off also removes its connector tools ({row.mcpServers} server{row.mcpServers === 1 ? "" : "s"}).</Hint> : null}
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
