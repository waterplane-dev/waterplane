/**
 * The requirements sheet: a repo's list as a person asked for it, cut by status and area. The cut is
 * `cut.ts`'s ONE predicate — the chips' numbers and the rows come from it, and a cut says "n of N"
 * against the unfiltered list with a way out. The update never runs here: the button hands the run to
 * the repo's agent through the backlog, where it waits for a tap.
 */
import { useEffect, useRef } from "react";
import { REQUIREMENT_STATUSES } from "@waterplane/shared";
import { ListChecks } from "lucide-react";
import { useStore } from "@waterplane/sdk";
import { CountChips, FilterBar, SearchBox, StaleHead, ago, useNow, Button, Hint } from "@waterplane/kit";
import { NO_CUT, areaBucket, builtWords, cutItems, cutWords, statusBucket } from "./cut.ts";
import { closeRequirements, focusItem, handUpdate, lists, readList, setUp, view } from "./data.ts";
import { ItemRow } from "./ItemRow.tsx";

const MANY_AREAS = 12;

export function RequirementsSheet() {
  const v = useStore(view);
  const all = useStore(lists);
  useNow(30_000);
  const repo = v.repo;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read only when the repo CHANGES (by id); `repo` is a fresh object on every store update
  useEffect(() => { if (repo) void readList(repo); }, [repo?.id]);
  const read = repo ? all.get(repo.id) : undefined;
  const openRef = useRef<string | null>(null);
  useEffect(() => {
    // Only a JUMP (focusItem) scrolls: an expand tap is under the thumb already and must not move the list.
    if (v.jump && v.open && openRef.current !== v.open) {
      openRef.current = v.open;
      document.querySelector(`[data-req="${v.open}"]`)?.scrollIntoView({ block: "center" });
      view.set((x) => (x.jump ? { ...x, jump: false } : x));
    }
    if (!v.open) openRef.current = null;
  }, [v.open, v.jump]);

  const head = (
    <StaleHead title={<><ListChecks size={16} /> requirements · {repo?.repoName ?? ""}</>} onClose={closeRequirements}
      onRefresh={() => { if (repo) void readList(repo); }} refreshTitle="read the list again" at={read?.at ?? null} />
  );
  if (!repo) return <div className="sheet">{head}<div className="empty">No repo chosen — open this from a repo’s menu.</div></div>;
  if (!read) return <div className="sheet">{head}<div className="empty">Reading the list…</div></div>;
  if (!read.res.ok) {
    return <div className="sheet">{head}<div className="empty">The list could not be read: {read.res.error}</div></div>;
  }
  const l = read.res.result;
  const { cut, q } = v;

  if (!l.setUp) {
    return (
      <div className="sheet">{head}
        <div className="empty">
          The requirements list is optional and not set up in {l.repoName}. Setting it up writes two files — a skill that
          tells the agent the format, and an index — and spends nothing. After that this sheet lists what you asked
          for, and the update goes to this repo’s agent through the backlog.
        </div>
        <div className="annot-tools wrap"><Button onClick={() => void setUp(repo)}>set up</Button></div>
      </div>
    );
  }

  const shown = cutItems(l.items, cut, q);
  const words = cutWords(cut, q, shown.length, l.items.length);
  const statusB = statusBucket(l.items, cut, q);
  const areaB = areaBucket(l.items, cut, q);
  const areaChips = (
    <CountChips keys={l.areas} bucket={areaB} label={(a) => a} active={cut.area}
      onPick={(area) => view.set((x) => ({ ...x, cut: { ...x.cut, area } }))} className="annot-tools wrap" />
  );
  return (
    <div className="sheet">
      {head}
      <div className="sheet-scroll">
        <div className="annot-tools wrap">
          <Hint as="span" style={{ flex: "1 1 14em" }}>{builtWords(l, ago)}</Hint>
          {l.scriptFound
            ? <Button onClick={() => void handUpdate(repo)}>update</Button>
            : <Hint as="span">This host cannot find the build script, so it cannot hand the update over — the setup checklist says where it looked.</Hint>}
        </div>
        {l.promptsBehind != null && l.promptsBehind >= l.stalePrompts && (
          <Hint style={{ padding: "0 14px" }}>
            That is {l.stalePrompts} or more prompts behind — the repo’s setup checklist flags it too.
          </Hint>
        )}
        <div className="search-row">
          <SearchBox placeholder="search the list" value={q} onChange={(e) => view.set((x) => ({ ...x, q: e.target.value }))} />
        </div>
        <CountChips keys={REQUIREMENT_STATUSES} bucket={statusB} label={(s) => s} active={cut.status}
          onPick={(status) => view.set((x) => ({ ...x, cut: { ...x.cut, status } }))} className="annot-tools wrap" />
        {l.areas.length > MANY_AREAS && !cut.area
          ? <details><Hint as="summary" style={{ padding: "8px 14px" }}>areas · {l.areas.length}</Hint>{areaChips}</details>
          : areaChips}
        {words && (
          <FilterBar section onClear={() => view.set((x) => ({ ...x, cut: NO_CUT, q: "" }))}>{words}</FilterBar>
        )}
        {l.items.length === 0
          ? <div className="empty">Built, but no items yet — the first update has nothing to list.</div>
          : shown.length === 0
            ? <div className="empty">Nothing matches this cut — {l.items.length} items are hidden by it.</div>
            : (
              <ul className="check-list">
                {shown.map((it) => (
                  <ItemRow key={it.id} it={it} list={l} repo={repo} open={v.open === it.id}
                    onToggle={() => view.set((x) => ({ ...x, open: x.open === it.id ? null : it.id }))}
                    onFocus={(id) => focusItem(id, shown.some((s) => s.id === id))} />
                ))}
              </ul>
            )}
      </div>
    </div>
  );
}
