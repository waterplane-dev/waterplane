/**
 * The links sheet: pinned links grouped by repo (a tap opens one, with its up/down line), then what
 * the host FOUND and nobody pinned yet (a Pin each; hidden rows counted, one tap shows them), then a
 * form to pin a link by hand. Cut to one repo when opened from a repo chip — the bar says "n of N".
 * Chips cut both lists by env, where it runs and (pins only) up/down; groups are by repo, env or
 * where, each header folds its group and says how many rows it holds and how many are down. Search,
 * the filter panel and the hand-pin form sit above the lists; each row is a card.
 *
 * Nothing is greyed out: a pin the phone cannot open says why in place of its link, a loopback-only
 * port shows the serve command that would give it a front door (shown, never run).
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleCheck, CircleDashed, CircleX, Link2, Pencil, Pin, PinOff, Plus, SlidersHorizontal } from "lucide-react";
import { useConnStatus, useCore, useStore } from "@waterplane/sdk";
import { CountChips, Explain, FilterBar, SearchBox, StaleHead, ago, useNow, Button, Hint, RowSub } from "@waterplane/kit";
import { LINK_ENVS, isHttpUrl, type FoundLink, type LinkEnv, type PinnedView } from "../shared/wire.mts";
import {
  GROUP_BYS, HEALTHS, WHERES, cutBoth, discoveryLine, facetsOn, foundCut, groupByWord, groupRows, groupTally, healthWord,
  inRepo, kindWord, localWords, matching, probeWords, sharedEnv, shortUrl, whereWord, type Facets, type GroupBy,
} from "./logic.ts";
import {
  addLink, clearCut, clearFacets, closeLinks, collapseAll, editLink, expandAll, links, lookOnOpen, openLink, pinFound, setFacet, setGroupBy,
  setQuery, setShowHidden, toggleFold, unpinLink,
} from "./state.ts";
import "./links.css";

const PAD = { padding: "0 14px" } as const;

function useRepoNames(): string[] {
  const c = useCore();
  return [...new Set(c.world.repos.map((r) => r.repoName))].sort((a, b) => a.localeCompare(b));
}

function EnvPick({ value, onPick }: { value: LinkEnv; onPick: (e: LinkEnv) => void }) {
  return (
    <div className="segmented links-seg" role="group" aria-label="environment">
      {/* Raw: `.seg` is the segmented control's own button, as in AppsSheet; kit Button would add `.key`. */}
      {LINK_ENVS.map((e) => <button key={e} className={`seg ${e === value ? "on" : ""}`} onClick={() => onPick(e)}>{e}</button>)}
    </div>
  );
}

function RepoPick({ value, onPick }: { value: string | null; onPick: (r: string | null) => void }) {
  const names = useRepoNames();
  const all = value && !names.includes(value) ? [value, ...names] : names;
  return (
    <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">no repo</option>
      {all.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

function ProbeIcon({ tone }: { tone: "ok" | "bad" | "dim" }) {
  if (tone === "ok") return <CircleCheck size={14} className="links-ok" />;
  if (tone === "bad") return <CircleX size={14} className="links-bad" />;
  return <CircleDashed size={14} className="links-dim" />;
}

/** `showEnv` is false when the group's header already says the one env all its rows share. */
function PinRow({ p, showEnv }: { p: PinnedView; showEnv: boolean }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(p.label);
  const [env, setEnv] = useState<LinkEnv>(p.env);
  const [repo, setRepo] = useState<string | null>(p.repo);
  const pw = probeWords(p.probe, ago);
  const lw = localWords(p);
  const save = async () => { if (await editLink(p.id, { label, env, repo })) setEditing(false); };
  return (
    <li className="links-row links-pin">
      <div className="links-title">
        <ProbeIcon tone={pw.tone} />
        {p.openUrl
          ? <button className="links-open" onClick={() => openLink(p.openUrl!)}>{p.label}</button>
          : <span className="links-label">{p.label}</span>}
        {!editing && <Button className="links-act" title={`edit ${p.label}`} aria-label={`edit ${p.label}`} onClick={() => setEditing(true)}><Pencil size={16} /></Button>}
      </div>
      {p.openUrl ? <RowSub as="div" className="links-url" title={p.openUrl}>{shortUrl(p.openUrl)}</RowSub> : <Hint>{p.why}</Hint>}
      <RowSub as="div" className="links-probe">
        <span>{p.openUrl || p.probe ? pw.text : null}{(p.openUrl || p.probe) && lw ? " · " : ""}{lw}</span>
        {showEnv && <span className={`links-env links-env-${p.env}`}>{p.env}</span>}
      </RowSub>
      {editing && (
        <div className="links-form">
          <label>name<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
          <EnvPick value={env} onPick={setEnv} />
          <label>repo<RepoPick value={repo} onPick={setRepo} /></label>
          <div className="annot-tools tri wrap">
            <Button onClick={() => void save()}>save</Button>
            <Button onClick={() => { setEditing(false); setLabel(p.label); setEnv(p.env); setRepo(p.repo); }}>cancel</Button>
            <Button onClick={() => void unpinLink(p)}><PinOff size={14} /> unpin</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function FoundRow({ f }: { f: FoundLink }) {
  const where = [kindWord[f.kind], f.project, f.env !== "dev" ? f.env : null].filter(Boolean).join(" · ");
  return (
    <li className="links-row">
      <div className="links-title">
        {f.url
          ? <button className="links-open" onClick={() => openLink(f.url!)}>{f.label}</button>
          : <span className="links-label">{f.label}</span>}
        <Button className="links-act" title={`pin ${f.label}`} aria-label={`pin ${f.label}`} onClick={() => void pinFound(f.key)}><Pin size={16} /></Button>
      </div>
      {f.url && <RowSub as="div" className="links-url" title={f.url}>{shortUrl(f.url)}</RowSub>}
      <RowSub as="div">{where}</RowSub>
      {f.note && <Hint>{f.note}</Hint>}
      {f.serveCmd && <Hint>To reach it from the phone, run on the desktop: <code className="links-cmd">{f.serveCmd}</code></Hint>}
    </li>
  );
}

/** One group: a header that folds it (title, how many, how many down), then its rows unless folded. */
function Group<T>({ fold, title, tally, rows, row, head = true }: { fold: string; title: string; tally: string; rows: T[]; row: (r: T) => ReactNode; head?: boolean }) {
  const folded = useStore(links).folded.includes(fold);
  if (!head) return <ul className="links-rows">{rows.map(row)}</ul>;
  return (
    <div>
      <button className="links-group" aria-expanded={!folded} onClick={() => toggleFold(fold)}>
        {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="links-group-title">{title}</span>
        <span className="links-group-n">{tally}</span>
      </button>
      {!folded && <ul className="links-rows">{rows.map(row)}</ul>}
    </div>
  );
}

/** The chip filters and the group-by switch. Every chip's number is `cutBoth(...).n` with that chip on. */
function Controls({ pins, found, facets, groupBy, foldKeys }: {
  pins: PinnedView[]; found: FoundLink[]; facets: Facets; groupBy: GroupBy; foldKeys: string[];
}) {
  const n = (f: Facets) => ({ count: cutBoth(pins, found, f).n });
  const folded = useStore(links).folded;
  const anyFolded = foldKeys.some((k) => folded.includes(k));
  const anyOpen = foldKeys.some((k) => !folded.includes(k));
  return (
    <div className="links-controls">
      <div className="links-chips">
      <CountChips className="links-chipset" keys={LINK_ENVS} label={(e) => e}
        bucket={(e) => n({ ...facets, env: e })} active={facets.env} onPick={(e) => setFacet("env", e)} />
      <CountChips className="links-chipset" keys={WHERES} label={(w) => whereWord[w]}
        bucket={(w) => n({ ...facets, where: w })} active={facets.where} onPick={(w) => setFacet("where", w)} />
      <CountChips className="links-chipset" keys={HEALTHS} label={(h) => `pins ${healthWord[h]}`}
        bucket={(h) => n({ ...facets, health: h })} active={facets.health} onPick={(h) => setFacet("health", h)} />
      </div>
      <div className="links-by-row">
        <span className="links-by">group by</span>
        <div className="segmented links-seg" role="group" aria-label="group by">
          {GROUP_BYS.map((g) => <button key={g} className={`seg ${g === groupBy ? "on" : ""}`} onClick={() => setGroupBy(g)}>{groupByWord[g]}</button>)}
        </div>
      </div>
      <div className="annot-tools tri wrap">
        {/* Each is offered only while it would change something — absent, never a grey button. */}
        {foldKeys.length > 1 && anyFolded && <Button onClick={() => expandAll(foldKeys)}><ChevronsUpDown size={14} /> expand all</Button>}
        {foldKeys.length > 1 && anyOpen && <Button onClick={() => collapseAll(foldKeys)}><ChevronsDownUp size={14} /> collapse all</Button>}
      </div>
    </div>
  );
}

/** Kept mounted while closed (`hidden`), so a name half typed is still there when it opens again. */
function AddForm({ repo0, open, onDone }: { repo0: string | null; open: boolean; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState<LinkEnv>("prod");
  const [repo, setRepo] = useState<string | null>(repo0);
  const ok = label.trim() !== "" && isHttpUrl(url.trim());
  const add = async () => {
    if (await addLink({ label: label.trim(), url: url.trim(), env, repo })) { setLabel(""); setUrl(""); onDone(); }
  };
  return (
    <div className="links-add" hidden={!open}>
      <div className="links-form">
        <label>name<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="admin console" /></label>
        <label>address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
        <EnvPick value={env} onPick={setEnv} />
        <label>repo<RepoPick value={repo} onPick={setRepo} /></label>
        {ok
          ? <div className="annot-tools wrap"><Button onClick={() => void add()}><Pin size={14} /> pin</Button></div>
          : <Hint>A name and an http:// or https:// address, then it can be pinned.</Hint>}
      </div>
    </div>
  );
}

export function LinksSheet() {
  const v = useStore(links);
  const status = useConnStatus();
  const [filtering, setFiltering] = useState(false);
  const [adding, setAdding] = useState(false);
  useNow(10_000);
  useEffect(() => { if (status === "open") void lookOnOpen(); }, [status]);

  const head = (
    <StaleHead title={<><Link2 size={16} /> links</>} onClose={closeLinks} onRefresh={() => void lookOnOpen(true)}
      refreshTitle="look again, cloud included" at={v.res?.ok ? v.at : null} />
  );
  if (!v.res) return <div className="sheet">{head}<div className="empty">{status === "open" ? "Asking the desktop…" : "No connection — the desktop can't be asked from here."}</div></div>;
  if (!v.res.ok) return <div className="sheet">{head}<div className="empty">The desktop did not answer: {v.res.error}</div></div>;
  const s = v.res.result;
  const inCut = inRepo(s.pinned, v.cut);
  const searchedPins = matching(inCut, v.q);
  const found = foundCut(s, v.cut, v.showHidden);
  const searchedFound = matching(found.shown, v.q);
  const cut = cutBoth(searchedPins, searchedFound, v.facets);
  const pinned = cut.pins;
  const foundShown = cut.found;
  const searching = v.q.trim() !== "";
  const nFacets = facetsOn(v.facets);
  // One repo on screen (opened from a repo chip): its own header would only repeat the bar.
  const heads = !(v.cut && v.groupBy === "repo");
  const pinGroups = groupRows(pinned, v.groupBy);
  const foundGroups = groupRows(foundShown, v.groupBy);
  const foldKeys = heads ? [...pinGroups.map((g) => `pin|${g.key}`), ...foundGroups.map((g) => `found|${g.key}`)] : [];
  const facetWords = [v.facets.env, v.facets.where && whereWord[v.facets.where], v.facets.health && `pins ${healthWord[v.facets.health]}`].filter(Boolean).join(" · ");

  return (
    <div className="sheet">
      {head}
      <div className="sheet-scroll">
        {v.cut && (
          <FilterBar onClear={clearCut} clearLabel="all repos">
            {v.cut.repo}: {inCut.length} of {s.pinned.length} pinned
          </FilterBar>
        )}
        <div className="links-search">
          <SearchBox className="grow" type="search" value={v.q} onChange={(e) => setQuery(e.target.value)}
            placeholder="find a link" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <Button className={filtering || nFacets > 0 ? "active" : undefined} title="filter and group" aria-expanded={filtering} onClick={() => setFiltering(!filtering)}><SlidersHorizontal size={14} /> filter</Button>
          <Button className={adding ? "active" : undefined} title="pin a link by hand" aria-label="pin a link by hand" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus size={16} /></Button>
        </div>
        <AddForm repo0={v.cut?.repo ?? null} open={adding} onDone={() => setAdding(false)} />
        {searching && (
          <FilterBar onClear={() => setQuery("")} clearLabel="clear search">
            “{v.q.trim()}”: {searchedPins.length} of {inCut.length} pinned · {searchedFound.length} of {found.shown.length} found
          </FilterBar>
        )}
        {filtering && <Controls pins={searchedPins} found={searchedFound} facets={v.facets} groupBy={v.groupBy} foldKeys={foldKeys} />}
        {nFacets > 0 && (
          <FilterBar onClear={clearFacets} clearLabel="clear filters">
            {facetWords}: {pinned.length} of {searchedPins.length} pinned · {foundShown.length} of {searchedFound.length} found
          </FilterBar>
        )}
        <Hint style={PAD}>{discoveryLine(s, ago)}</Hint>
        {s.notes.map((n) => <Hint key={n} style={PAD}>{n}</Hint>)}

        <div className="section section-head">Pinned</div>
        {pinned.length === 0
          ? <div className="empty">{s.pinned.length === 0 ? "Nothing pinned yet — pin one from the found list below." : inCut.length === 0 ? `Nothing pinned for ${v.cut?.repo}.` : searchedPins.length === 0 ? "No pin matches the search." : "No pin matches the filters."}</div>
          : pinGroups.map((g) => {
            // Said once on the header when every row shares it, not on each row; grouped by env the title says it.
            const env = heads ? sharedEnv(g.rows) : null;
            const tally = groupTally(g.rows, true);
            return (
              <Group key={g.key} fold={`pin|${g.key}`} title={g.title} tally={env && v.groupBy !== "env" ? `${env} · ${tally}` : tally} rows={g.rows} head={heads}
                row={(p) => <PinRow key={p.id} p={p} showEnv={!env} />} />
            );
          })}

        <div className="section section-head">
          <span>Found, not pinned</span>
          <Explain of="found, not pinned">
            Ports listening in a repo under the code root, and Cloud Run and Firebase Hosting in every GCP project gcloud can see.
            {found.hidden > 0 && ` ${found.hidden} hidden: Cloud Functions, internal services, helper ports.`}
          </Explain>
        </div>
        {(found.hidden > 0 || v.showHidden) && (
          <div className="links-more">
            <Button onClick={() => setShowHidden(!v.showHidden)}>{v.showHidden ? "hide functions and helper ports" : `show all ${found.total}`}</Button>
          </div>
        )}
        {v.facets.health
          ? <div className="empty">Found links are never checked, so none are listed while pins are filtered by up or down — {searchedFound.length} found.</div>
          : foundShown.length === 0
            ? <div className="empty">{s.localAt == null && s.cloudAt == null ? "Looking…" : searchedFound.length > 0 ? "Nothing found matches the filters." : found.shown.length > 0 ? `Nothing found matches the search${found.hidden > 0 && !v.showHidden ? ` — ${found.hidden} hidden rows were not searched` : ""}.` : "Nothing new found."}</div>
            : foundGroups.map((g) => (
              <Group key={g.key} fold={`found|${g.key}`} title={g.title} tally={groupTally(g.rows, false)} rows={g.rows} head={heads}
                row={(f) => <FoundRow key={f.key} f={f} />} />
            ))}

        <Hint style={PAD}>Pins are kept on the desktop in <code>{s.file}</code> — it can be edited by hand.</Hint>
      </div>
    </div>
  );
}
