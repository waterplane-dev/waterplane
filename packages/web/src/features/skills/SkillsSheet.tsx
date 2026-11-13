/**
 * Skills & plugins — what every new session of this repo carries, and the switches for it.
 * Reads the inventory from the host, keeps a DRAFT, writes one named settings file on Save.
 * Rules (CLAUDE.md, `ux`, `web-numbers`): the total comes with its split; a count on a chip is a
 * filter (`logic.bucket` feeds both); controls sit ABOVE the rows; what cannot be done says why in
 * words; the draft is never overwritten by a re-read; nothing applies itself.
 */
import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { SKILL_NEW_SESSIONS_ONLY, skillFileLine } from "@waterplane/shared";
import { SKILL_STATES } from "@waterplane/shared";
import type { SkillInventoryDoc } from "@waterplane/shared";
import { api } from "../../api";
import { core, useStore } from "../../sdk";
import { Button, Empty, Explain, FilterChip, Hint, SearchBox, Sheet, chipRows, toggleChip, useRemoteResource } from "../../kit";
import { skillSwitchGate } from "../../backendCaps";
import { skillsAim } from "../../skillsDoor";
import { SuggestList } from "./SuggestList";
import { PluginCard, SkillRowView } from "./SkillRows";
import { aimSkills, applySuggestions, closeSkills, recommend, discardDraft, saveChanges, setFilter, setQuery, setShared, setSort, setTarget } from "./actions";
import {
  RECOMMEND_COST, SORT_KEYS, SORT_WORDS, STATE_TITLES, STATE_WORDS, saveNote, bucket, chipCount, chipKeys, chipLabel, draftChanges, layerOf, levelFor, matches, parkedWords, reconcileDraft, reconcileSuggestions, saveWords, savingsFor, sortRows, splitRows, summaryWords, usageWords,
} from "./logic";
import { skillsState } from "./store";

const POLL_MS = 3000;

export function SkillsSheet() {
  const c = core();
  const aim = useStore(skillsAim);
  const s = useStore(skillsState);
  // The door's aim becomes this screen's state on mount (and when a door re-aims it).
  useEffect(() => { if (aim) aimSkills(aim.repoId, aim.backend); }, [aim?.repoId, aim?.backend]); // eslint-disable-line react-hooks/exhaustive-deps
  const gate = skillSwitchGate(c.world.backends, aim?.backend);
  const repoId = s.repoId === aim?.repoId ? s.repoId : null;
  const res = useRemoteResource<SkillInventoryDoc>(`skills:${repoId}`, () => api.skills(repoId!), { enabled: !!repoId && !gate });
  const doc = res.data;
  const [saveErr, setSaveErr] = useState<{ text: string; stale: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  // Uses are counted in the background on the host; ask again while it counts.
  const counting = doc?.usage.state === "counting" || !!doc?.usage.refreshing;
  useEffect(() => {
    if (!counting) return;
    const t = setTimeout(() => res.reload({ quiet: true }), POLL_MS);
    return () => clearTimeout(t);
  }, [counting, doc?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = doc?.rows ?? [];
  // A re-read never overwrites what was chosen; it only forgets rows that are gone.
  useEffect(() => {
    if (!doc) return;
    const kept = reconcileDraft(s.draft, doc.rows);
    if (Object.keys(kept).length !== Object.keys(s.draft).length) skillsState.set({ ...skillsState.get(), draft: kept });
    // The same for the suggestions: one a Save or re-read has made untrue is not offered, and the list says so.
    const sg = skillsState.get().suggest;
    if (sg?.suggestions.length) {
      const live = reconcileSuggestions(sg.suggestions, doc.rows);
      if (live.length !== sg.suggestions.length) {
        skillsState.set({ ...skillsState.get(), suggest: { ...sg, suggestions: live, ...(live.length ? {} : { ok: true, note: "Everything suggested has since been switched." }) } });
      }
    }
  }, [doc?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const level = levelFor(s.target, s.shared);
  const kept = parkedWords(s.parked, repoId, level);
  const layer = layerOf(doc, level);
  // A recommendation is built on THIS repo's counts, so it is applied in this repo's file, whatever the segment shows.
  const applyLevel = levelFor("repo", s.shared);
  const applyLayer = layerOf(doc, applyLevel);
  const changes = draftChanges(s.draft, rows);
  const sav = savingsFor(rows, changes);
  const split = splitRows(rows);
  const usageReady = doc?.usage.state === "ready";

  const cut = s.filter ? bucket(s.filter, split, s.draft, usageReady) : null;
  const plugins = sortRows((cut ? cut.plugins : split.plugins).filter((r) => matches(r, s.query)), s.sort);
  const skills = sortRows((cut ? cut.skills : split.skills).filter((r) => matches(r, s.query)), s.sort);
  const bundled = cut ? [] : sortRows(split.bundled.filter((r) => matches(r, s.query)), "name");
  const total = split.plugins.length + split.skills.length;
  const shownN = plugins.length + skills.length;

  async function save() {
    if (!doc || !repoId || !changes.length || saving) return;
    setSaving(true);
    setSaveErr(null);
    const r = await saveChanges(repoId, doc, level, changes);
    setSaving(false);
    if (r.ok) res.set(r.doc);
    else {
      setSaveErr({ text: r.error, stale: r.stale });
      if (r.stale) res.reload({ quiet: true });
    }
  }

  async function apply() {
    if (!doc || !repoId || applying) return;
    setApplying(true);
    setSaveErr(null);
    const r = await applySuggestions(repoId, doc, applyLevel);
    setApplying(false);
    if (!r) return;
    if (r.ok) res.set(r.doc);
    else {
      setSaveErr({ text: r.error, stale: r.stale });
      if (r.stale) res.reload({ quiet: true });
    }
  }

  const footer = changes.length > 0 && layer?.readable ? (
    <div className="sk-foot">
      <Hint>{saveNote(layer.path, sav.tokens, sav.unmeasured)}</Hint>
      <div className="sk-foot-btns">
        <Button variant="primary" onClick={save}>{saving ? "Saving…" : saveWords(changes.length)}</Button>
        <Button onClick={() => { discardDraft(); setSaveErr(null); }}>discard</Button>
      </div>
    </div>
  ) : undefined;
  // With a draft the footer names the file; the top line says it only while there is none (never twice).
  const showFileLine = !(changes.length > 0 && layer?.readable);

  return (
    <Sheet title="Skills & plugins" icon={<Plug size={16} />} onClose={closeSkills} footer={footer}>
      <div className="sheet-scroll sk-scroll">
        {gate ? <Hint>{gate}</Hint> : (
          <>
            {/* raw buttons: the app's .seg segmented control is a plain button pair everywhere (05-rows-approve.css) */}
            <div className="segmented sk-level" role="group" aria-label="Where the change applies">
              <button className={`seg${s.target === "repo" ? " on" : ""}`} aria-pressed={s.target === "repo"} onClick={() => { setTarget("repo"); setSaveErr(null); }}>This repo</button>
              <button className={`seg${s.target === "all" ? " on" : ""}`} aria-pressed={s.target === "all"} onClick={() => { setTarget("all"); setSaveErr(null); }}>All repos</button>
            </div>
            {kept && <Hint>{kept}</Hint>}
            {layer && (layer.readable
              ? (showFileLine && <Hint>{skillFileLine(level, layer.path)}</Hint>)
              : <Hint tone="warn">{layer.why ?? `${layer.path} could not be read.`}</Hint>)}
            {s.target === "repo" && (
              <div className="sk-share">
                <Button className="sk-link" onClick={() => { setShared(!s.shared); setSaveErr(null); }}>
                  {s.shared ? "write the gitignored file instead (.claude/settings.local.json)" : "share with the repo instead (.claude/settings.json)"}
                </Button>
              </div>
            )}
            <Empty res={res} empty={!doc} thing="skills and plugins" />
            {doc && (
              <>
                {doc.hostNote && <Hint>{doc.hostNote}</Hint>}
                {total > 0 && (
                  <div className="sk-explain">
                    <Explain of="skills and plugins" label="what these words mean">
                      <p>{SKILL_NEW_SESSIONS_ONLY}</p>
                      <p>{summaryWords(doc.totals)}</p>
                      <p>{usageWords(doc.usage)}</p>
                      <p>{SKILL_STATES.map((k) => `${STATE_WORDS[k]}: ${STATE_TITLES[k]}`).join(". ")}.</p>
                    </Explain>
                  </div>
                )}
                {doc.usage.state === "counting" && <Hint>{usageWords(doc.usage)}</Hint>}
                <SearchBox className="sk-search" placeholder="search skills and plugins" value={s.query} onChange={(e) => setQuery(e.target.value)} />
                {total > 0 && <div className="fchips">
                  {chipRows(chipKeys(usageReady), (k) => ({ count: chipCount(k, split, s.draft, usageReady) }), chipLabel).map((ch) => (
                    <FilterChip key={ch.key} on={s.filter === ch.key} onClick={() => setFilter(toggleChip(s.filter, ch.key))}>{ch.text}</FilterChip>
                  ))}
                </div>}
                {total > 0 && <div className="fchips sk-sort" role="group" aria-label="Sort">
                  {SORT_KEYS.map((k) => (
                    <FilterChip key={k} on={s.sort === k} clears={false} onClick={() => setSort(k)}>{SORT_WORDS[k]}</FilterChip>
                  ))}
                </div>}
                {total > 0 && <Button className="sk-suggest-btn" title={RECOMMEND_COST} onClick={() => repoId && recommend(repoId)}>{s.asking ? "Looking at what is used…" : "suggest what to switch off · one model call"}</Button>}
                {s.suggest && <SuggestList res={s.suggest} unticked={s.unticked} doc={doc} file={applyLayer?.readable ? applyLayer.path : null} applying={applying} onApply={apply} />}
                {(s.filter || s.query.trim()) && <Hint>{shownN} of {total} shown{s.filter ? <> · <Button className="sk-link" onClick={() => { setFilter(null); setQuery(""); }}>clear</Button></> : null}</Hint>}
                {saveErr && <Hint tone="warn">{saveErr.text}{saveErr.stale ? " The list was read again; your choices are kept." : " Your choices are kept."}</Hint>}
                {plugins.map((r) => <PluginCard key={r.id} row={r} skills={r.skills.map((id) => split.pluginSkills.get(id)).filter((x): x is NonNullable<typeof x> => !!x)} draft={s.draft} level={level} />)}
                {skills.map((r) => <SkillRowView key={r.id} row={r} draft={s.draft} level={level} />)}
                {bundled.length > 0 && (
                  <details className="sk-fold sk-bundled">
                    <summary>built in to Claude Code, {bundled.length}</summary>
                    {bundled.map((r) => <SkillRowView key={r.id} row={r} draft={s.draft} level={level} />)}
                  </details>
                )}
                {shownN === 0 && bundled.length === 0 && <div className="empty empty-msg">{total === 0 ? "No skills or plugins found for this repo." : "Nothing matches."}</div>}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
