/**
 * Skills & plugins — what every new session of this repo carries, and the switches for it.
 * Reads the inventory from the host, keeps a DRAFT per file (each changed card names its own: this
 * repo or All repos), writes the named settings files on Save.
 * Rules (CLAUDE.md, `ux`, `web-numbers`): the total comes with its split; a count on a chip is a
 * filter (`logic.bucket` feeds both); controls sit ABOVE the rows; what cannot be done says why in
 * words; the draft is never overwritten by a re-read; nothing applies itself.
 */
import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { agoText } from "../../format";
import { SKILL_NEW_SESSIONS_ONLY, skillFileLine } from "@waterplane/shared";
import { SKILL_STATES } from "@waterplane/shared";
import type { SkillInventoryDoc, SkillRecommendResponse } from "@waterplane/shared";
import { core, cutByIds, evidenceCutWords, useEvidenceFocus, useStore } from "../../sdk";
import { Button, Empty, Explain, FilterChip, Hint, SearchBox, Sheet, chipRows, toggleChip } from "../../kit";
import { skillSwitchGate } from "../../backendCaps";
import { skillsAim } from "../../skillsDoor";
import { useSlowJob } from "../../slowJobs";
import { SlowJobLine } from "../../SlowJobLine";
import { SuggestList } from "./SuggestList";
import { CountBar } from "./CountBar";
import { RepoFileChoice } from "./RepoFileChoice";
import { PluginCard, SkillRowView } from "./SkillRows";
import { aimSkills, applySuggestions, closeSkills, dismissSuggest, openCarried, showSuggest, discardDraft, saveDrafts, setFilter, setQuery, setSort } from "./actions";
import {
  RECOMMEND_COST, SORT_KEYS, SORT_WORDS, STATE_TITLES, STATE_WORDS, saveNote, bucket, changedOf, chipCount, chipKeys, chipLabel, draftChanges, hereChanges, keyOf, layerOf, levelFor, matches, reconcileDraft, reconcileSuggestions, saveWords, savingsFor, sortRows, splitRows, summaryWords, usageWords, isCountingRefusal,
  isCountingDoc, usesBar, usesIsNewer,
} from "./logic";
import { skillsEmbedAim, skillsState } from "./store";
import { EmbeddedBody } from "../../SetupHealthSheet";

/**
 * `embedded`: drawn as Setup & health's Skills section (the frame has the one head; the save bar
 * follows the list). `fromDoor`: a skills door opened the screen, so its aim wins over the section's.
 */
export function SkillsSheet({ embedded, fromDoor = true }: { embedded?: boolean; fromDoor?: boolean }) {
  const c = core();
  const doorAim = useStore(skillsAim);
  const embedAim = useStore(skillsEmbedAim);
  const aim = embedded && !fromDoor ? embedAim : doorAim;
  const s = useStore(skillsState);
  // The Setup check's door: the skills it named, with the rest said to be hidden and a way back.
  const focus = useEvidenceFocus("skills");
  const [ids, setIds] = useState<readonly string[] | null>(focus?.ids?.length ? focus.ids : null);
  // The door's aim becomes this screen's state on mount (and when a door re-aims it).
  useEffect(() => { if (aim) aimSkills(aim.repoId, aim.backend, aim.target); }, [aim]);
  const gate = skillSwitchGate(c.world.backends, aim?.backend);
  const repoId = s.repoId === aim?.repoId ? s.repoId : null;
  // Three slow jobs on the desktop (`slowJobs.ts`): leaving this screen aborts none of them, and
  // coming back shows the last answer with its age and whether a run is still going.
  const on = !!repoId && !gate;
  const inv = useSlowJob<SkillInventoryDoc>("skills.inventory", repoId, { enabled: on, auto: true, verb: "read the skills" });
  const uses = useSlowJob<SkillInventoryDoc>("skills.uses", repoId, { enabled: on, auto: false, verb: "count the uses" });
  // The one model call: only ever a tap, never started by opening the screen.
  const rec = useSlowJob<SkillRecommendResponse>("skills.recommend", repoId, { enabled: on, auto: false, verb: "ask for suggestions" });
  // The counted inventory replaces the plain one once it is newer; a save's answer is newer than both.
  const res = usesIsNewer(inv, uses) ? { ...uses, reload: inv.reload, set: inv.set } : inv;
  const doc = res.data;
  const [saveErr, setSaveErr] = useState<{ text: string; stale: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  // Uses are counted in the background on the host: the `skills.uses` job waits for both counts and
  // reports how far it is, so the bar moves without this screen asking again.
  const counting = uses.running || isCountingDoc(doc);
  useEffect(() => {
    // Not again after a failed count: its sentence stays on screen instead of a retry loop.
    if (!isCountingDoc(doc) || uses.running || uses.job?.state === "failed" || (uses.resultAt ?? 0) > (inv.resultAt ?? 0)) return;
    uses.start();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered: a new doc, a run ending, a re-read; the other guards are read fresh, and re-firing on each would risk a second start before `running` lands
  }, [doc?.at, uses.running, inv.state]);
  // A finished suggestion run is shown (once per run, and again after a return); never applied.
  useEffect(() => { if (rec.data) showSuggest(rec.job?.id ?? `at:${rec.resultAt}`, rec.data); }, [rec.data, rec.resultAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const asking = rec.running;

  const rows = doc?.rows ?? [];
  // A re-read never overwrites what was chosen; it only forgets rows that are gone.
  useEffect(() => {
    if (!doc) return;
    const kept = reconcileDraft(s.draft, doc.rows);
    const keptAll = reconcileDraft(s.allDraft, doc.rows);
    if (Object.keys(kept).length !== Object.keys(s.draft).length || Object.keys(keptAll).length !== Object.keys(s.allDraft).length) skillsState.set({ ...skillsState.get(), draft: kept, allDraft: keptAll });
    // The same for the suggestions: one a Save or re-read has made untrue is not offered, and the list says so.
    const sg = skillsState.get().suggest;
    if (sg?.suggestions.length) {
      const live = reconcileSuggestions(sg.suggestions, doc.rows);
      if (live.length !== sg.suggestions.length) {
        skillsState.set({ ...skillsState.get(), suggest: { ...sg, suggestions: live, ...(live.length ? {} : { ok: true, note: "Everything suggested has since been switched." }) } });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new read can make a draft or suggestion untrue; a draft edit picks from rows already on screen
  }, [doc?.at]);

  // Every card shows what THIS repo ends up with; each changed card says which file its choice goes to.
  const level = levelFor("repo", s.shared);
  const d = { draft: s.draft, allDraft: s.allDraft };
  const layer = layerOf(doc, level);
  const globalLayer = layerOf(doc, "global");
  const changes = draftChanges(s.draft, rows);
  const allChanges = draftChanges(s.allDraft, rows);
  const changedN = Object.keys(changedOf(d)).filter((k) => rows.some((r) => keyOf(r) === k)).length;
  const sav = savingsFor(rows, hereChanges(d, rows, level));
  // The files this save writes, each of which must be readable (a file that is not is said, never written blind).
  const writes = [allChanges.length ? globalLayer : undefined, changes.length ? layer : undefined].filter((l): l is NonNullable<typeof l> => !!l);
  const blocked = writes.find((l) => !l.readable);
  const split = splitRows(rows);
  const usageReady = doc?.usage.state === "ready";

  const cut = s.filter ? bucket(s.filter, split, changedOf(d), usageReady) : null;
  const plugins = sortRows(cutByIds(cut ? cut.plugins : split.plugins, ids ?? undefined, (r) => r.id).filter((r) => matches(r, s.query)), s.sort);
  const skills = sortRows(cutByIds(cut ? cut.skills : split.skills, ids ?? undefined, (r) => r.id).filter((r) => matches(r, s.query)), s.sort);
  const bundled = cut || ids ? [] : sortRows(split.bundled.filter((r) => matches(r, s.query)), "name");
  const total = split.plugins.length + split.skills.length;
  const shownN = plugins.length + skills.length;

  async function save() {
    if (!doc || !repoId || !changedN || saving || blocked) return;
    setSaving(true);
    setSaveErr(null);
    const r = await saveDrafts(repoId, doc, level, allChanges, changes);
    setSaving(false);
    if (r.ok) inv.set(r.doc);
    else {
      setSaveErr({ text: r.error, stale: r.stale });
      if (r.stale) res.reload({ quiet: true });
    }
  }

  async function apply() {
    if (!doc || !repoId || applying) return;
    setApplying(true);
    setSaveErr(null);
    const r = await applySuggestions(repoId, doc, level);
    setApplying(false);
    if (!r) return;
    if (r.ok) inv.set(r.doc);
    else {
      setSaveErr({ text: r.error, stale: r.stale });
      if (r.stale) res.reload({ quiet: true });
    }
  }

  const footer = changedN > 0 && writes.length > 0 && !blocked ? (
    <div className="sk-foot">
      {changes.length > 0 && <RepoFileChoice shared={s.shared} onChange={() => setSaveErr(null)} />}
      <Hint>{saveNote(writes.map((l) => l.path).join(" and "), sav.tokens, sav.unmeasured)}</Hint>
      <div className="sk-foot-btns">
        <Button variant="primary" onClick={save}>{saving ? "Saving…" : saveWords(changedN)}</Button>
        <Button onClick={() => { discardDraft(); setSaveErr(null); }}>discard</Button>
      </div>
    </div>
  ) : undefined;
  // With a draft the footer names the files; the top line says this repo's file only while there is none (never twice).
  const showFileLine = !footer;

  const content = (
      <div className="sheet-scroll sk-scroll">
        {gate ? <Hint>{gate}</Hint> : (
          <>
            {blocked && <Hint tone="warn">{blocked.why ?? `${blocked.path} could not be read.`}</Hint>}
            {layer && (layer.readable
              ? (showFileLine && <Hint>{skillFileLine(level, layer.path)}</Hint>)
              : <Hint tone="warn">{layer.why ?? `${layer.path} could not be read.`}</Hint>)}
            <Empty res={res} empty={!doc} thing="skills and plugins" />
            <SlowJobLine res={inv} what="Reading the skills" />
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
                {repoId && <div className="sk-share"><Button className="sk-link" onClick={() => openCarried(repoId)} title="Setup & health › Sessions: what every turn of this repo carries, skills and plugins included">what every turn carries →</Button></div>}
                <CountBar label="Counting uses in this repo and across all repos" u={usesBar(uses.running ? uses.job : null, doc)} note="Suggestions wait for it." />
                <SlowJobLine res={{ ...uses, job: uses.job?.state === "failed" ? uses.job : null }} what="Counting uses" />
                <SearchBox className="sk-search" placeholder="search skills and plugins" value={s.query} onChange={(e) => setQuery(e.target.value)} />
                {total > 0 && <div className="fchips">
                  {chipRows(chipKeys(usageReady), (k) => ({ count: chipCount(k, split, changedOf(d), usageReady) }), chipLabel).map((ch) => (
                    <FilterChip key={ch.key} on={s.filter === ch.key} onClick={() => setFilter(toggleChip(s.filter, ch.key))}>{ch.text}</FilterChip>
                  ))}
                </div>}
                {total > 0 && <div className="fchips sk-sort" role="group" aria-label="Sort">
                  {SORT_KEYS.map((k) => (
                    <FilterChip key={k} on={s.sort === k} clears={false} onClick={() => setSort(k)}>{SORT_WORDS[k]}</FilterChip>
                  ))}
                </div>}
                {total > 0 && <Button className="sk-suggest-btn" title={RECOMMEND_COST} onClick={() => { if (!asking) rec.start(); }}>{asking ? "Looking at what is used…" : "suggest what to switch off · one model call"}</Button>}
                {total > 0 && <SlowJobLine res={rec} what="Asking for suggestions" />}
                {s.suggest && !rec.running && rec.state === "cached" && rec.age !== null && <Hint>Suggested {agoText(rec.age)} — tap suggest for a fresh list.</Hint>}
                {/* A "still counting" refusal carries a frozen count: the bar above is the live one, so only the next step is said here. */}
                {s.suggest && isCountingRefusal(s.suggest) && <Hint>{counting ? "Not asked yet: the count above is still running. Tap suggest again when it reaches 100%." : "The count has finished: tap suggest again."} · <Button className="sk-link" onClick={dismissSuggest}>close</Button></Hint>}
                {s.suggest && !isCountingRefusal(s.suggest) && <SuggestList res={s.suggest} unticked={s.unticked} doc={doc} file={layer?.readable ? layer.path : null} globalFile={globalLayer?.readable ? globalLayer.path : null} shared={s.shared} showChoice={!(footer && changes.length > 0)} applying={applying} onApply={apply} />}
                {ids && <Hint>{evidenceCutWords(shownN, total, "skills and plugins")} · <Button className="sk-link" onClick={() => setIds(null)}>clear</Button></Hint>}
                {!ids && (s.filter || s.query.trim()) && <Hint>{shownN} of {total} shown{s.filter ? <> · <Button className="sk-link" onClick={() => { setFilter(null); setQuery(""); }}>clear</Button></> : null}</Hint>}
                {saveErr && <Hint tone="warn">{saveErr.text}{saveErr.stale ? " The list was read again; your choices are kept." : " Your choices are kept."}</Hint>}
                {plugins.map((r) => <PluginCard key={r.id} row={r} skills={r.skills.map((id) => split.pluginSkills.get(id)).filter((x): x is NonNullable<typeof x> => !!x)} d={d} level={level} fallback={s.target} />)}
                {skills.map((r) => <SkillRowView key={r.id} row={r} d={d} level={level} fallback={s.target} />)}
                {bundled.length > 0 && (
                  <details className="sk-fold sk-bundled">
                    <summary>built in to Claude Code, {bundled.length}</summary>
                    {bundled.map((r) => <SkillRowView key={r.id} row={r} d={d} level={level} fallback={s.target} />)}
                  </details>
                )}
                {shownN === 0 && bundled.length === 0 && <div className="empty empty-msg">{total === 0 ? "No skills or plugins found for this repo." : "Nothing matches."}</div>}
              </>
            )}
          </>
        )}
      </div>
  );
  if (embedded) return <EmbeddedBody footer={footer}>{content}</EmbeddedBody>;
  return (
    <Sheet title="Skills & plugins" icon={<Plug size={16} />} onClose={closeSkills} footer={footer}>
      {content}
    </Sheet>
  );
}
