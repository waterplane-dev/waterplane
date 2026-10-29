/**
 * "Week-end burn": which repos get the rest of the subscription week, and what
 * their sessions are told. The pick is the approval and is bound to ONE week by
 * the host; nothing here runs anything. When and why it starts is the shared
 * plan's sentence, printed as it arrives; the prompt preview is the shared
 * `weekBurnItemPrompt` over the draft, so what is shown is what is sent.
 */
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckSquare, ChevronDown, ChevronRight, ListTodo, Square } from "lucide-react";
import { weekBurnItemPrompt, weekBurnRowsLabel, WEEKBURN_DEFAULT_TASK, type WeekBurnStatus } from "@waterplane/shared";
import { useCore } from "../../sdk";
import { api } from "../../api";
import { Sheet, Empty, Unavailable, Button, Hint, Row, RowTitle, RowSub, Explain, RadioRows, PromptComposer } from "../../kit";
import { SHEET } from "../../sheetNames";
import { useRemoteResource } from "../../useRemoteResource";
import { saveWeekBurn } from "./actions";
import { burnRowIds, burnRows, hiddenWorktreesNote, howItWorks, startLine, lastWeekHere, runningWords, sameAsLastOffered, saveVerb, stopChoices, toggleDir, type TaskMode } from "./logic";

const baseName = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir;

type Draft = { repos: string[]; recurring: boolean; stopPct: number; mode: TaskMode; task: string; notes: Record<string, string> };

const draftOf = (s: WeekBurnStatus): Draft => ({
  repos: s.pickedThisWeek ? s.prefs.repos : [], recurring: s.prefs.recurring, stopPct: s.prefs.stopPct,
  mode: s.prefs.task ? "own" : "health", task: s.prefs.task ?? "", notes: s.prefs.notes ?? {},
});

export function WeekBurnSheet() {
  const c = useCore();
  const res = useRemoteResource<WeekBurnStatus>("weekburn", () => api.getWeekBurn());
  const st = res.data;
  const repos = c.world.visibleRepos;
  const known = repos.map((r) => r.worktreePath);

  // The draft starts from this week's pick (empty when none) the first time the host answers,
  // and again after a save; a reload while it is being edited never overwrites it.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [shown, setShown] = useState<string | null>(null); // the repo whose full prompt is open
  const seeded = useRef(false);
  useEffect(() => {
    if (!st || seeded.current) return;
    seeded.current = true;
    setDraft(draftOf(st));
  }, [st]);
  const d = draft;

  const apply = (next: WeekBurnStatus | null) => {
    if (!next) return;
    res.set(next);
    setDraft(draftOf(next));
  };

  const body = () => {
    if (!st || !d) return <Empty res={res} empty={!st} thing="the week-end burn" />;
    if (!st.available) {
      return <Unavailable cants={[{ label: "the week-end burn", reason: st.unavailableText ?? "Not available on this desktop." }]} />;
    }
    const verb = saveVerb(d.repos.length, st.pickedThisWeek);
    const last = lastWeekHere(st, known);
    const listed = burnRows(repos, d.repos);
    const hiddenNote = hiddenWorktreesNote(listed.hidden);
    const running = new Map(st.running.map((r) => [r.repoDir, r]));
    const task = d.mode === "own" ? d.task : "";
    const steps = howItWorks({ start: st.plan ? startLine(st.plan.startAt, Date.now()) : null, maxPerRepo: st.maxPerRepo ?? null, stopPct: d.stopPct });
    return (
      <>
        {st.plan && (
          <div>
            <RowTitle as="div"><CalendarClock size={16} /> {startLine(st.plan.startAt, Date.now())}</RowTitle>
            <Explain of="the start time">{st.plan.reasonText}</Explain>
          </div>
        )}
        {st.stoppedText && <Hint tone="warn">{st.stoppedText}</Hint>}

        <section aria-label="how it works">
          <RowTitle as="div">How it works</RowTitle>
          <ol className="wb-steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </section>

        <section aria-label="what each session works on">
          <RowTitle as="div">What each session works on</RowTitle>
          <RadioRows<TaskMode> label="what each session works on" value={d.mode}
            onChange={(mode) => setDraft({ ...d, mode })}
            options={[
              { key: "health", label: WEEKBURN_DEFAULT_TASK, note: "Reads the repo's latest health index; without one, its own tests and lint." },
              { key: "own", label: "My own instructions", note: "Your words replace the health pick, in every ticked repo. The safety rules stay." },
            ]} />
          {d.mode === "own" && (
            <>
              <PromptComposer inline rows={3} prompts={[d.task]} onChange={(next) => setDraft({ ...d, task: next[0] ?? "" })}
                placeholder="e.g. Raise test coverage in src/parser; no new dependencies." />
              {!d.task.trim() && <Hint>Nothing written yet: saved empty, sessions fix the weakest health reading.</Hint>}
            </>
          )}
        </section>

        <section aria-label="stop line">
          <RowTitle as="div">Stop when the week is at</RowTitle>
          <RadioRows<string> label="stop when the week is at" value={String(d.stopPct)}
            onChange={(p) => setDraft({ ...d, stopPct: Number(p) })}
            options={stopChoices(st.prefs.stopPct).map((p) => ({ key: String(p), label: `${p}%`, ...(p === 100 ? { note: "Spends the whole week; nothing left for your own sessions." } : {}) }))} />
        </section>

        {/* The week's settings and the save ABOVE the repo list: a list's verbs
            never trail its last row (ux §5). */}
        <Row as="button" role="checkbox" aria-checked={d.recurring} onClick={() => setDraft({ ...d, recurring: !d.recurring })}>
          {d.recurring ? <CheckSquare size={18} /> : <Square size={18} />}
          <RowTitle>Ask me each week</RowTitle>
          <RowSub as="div">A reminder to pick again. It never reuses last week's repos by itself.</RowSub>
        </Row>

        {verb.kind === "none"
          ? <Hint>{verb.why}</Hint>
          : (
            <Button variant={verb.kind === "save" ? "primary" : undefined} onClick={async () => apply(await saveWeekBurn(
              { repos: d.repos, recurring: d.recurring, stopPct: d.stopPct, task, notes: d.notes }, d.repos.length))}>
              {verb.label}
            </Button>
          )}

        {sameAsLastOffered(st, known) && (
          <div>
            <Button onClick={async () => apply(await saveWeekBurn({ sameAsLast: true, task, notes: d.notes }, last.length))}>Same as last week</Button>
            <RowSub as="div">{last.map(baseName).join(", ")}</RowSub>
          </div>
        )}

        <RowTitle as="div">Repos</RowTitle>
        <Hint>A ticked repo can get its own extra line and shows the exact prompt its sessions get.</Hint>
        <div role="group" aria-label="repos for this week">
          {listed.rows.map((r) => {
            const on = d.repos.includes(r.dir);
            const run = running.get(r.dir);
            const Box = on ? CheckSquare : Square;
            const open = on && shown === r.dir;
            const note = d.notes[r.dir] ?? "";
            const posted = burnRowIds(c.world.backlog, r.dir);
            return (
              <div key={r.dir}>
                <Row as="button" role="checkbox" aria-checked={on}
                  onClick={() => setDraft({ ...d, repos: toggleDir(d.repos, r.dir) })}>
                  <Box size={18} />
                  <RowTitle>{r.title}</RowTitle>
                  {r.where && <RowSub as="div" className="mono">{r.where}</RowSub>}
                  {run && <RowSub as="div">{runningWords(run)}</RowSub>}
                </Row>
                {/* The rows the burn wrote here, in that repo's backlog: the count opens exactly those. */}
                {posted.length > 0 && (
                  <div className="wb-repo">
                    <Button onClick={() => c.nav.openBacklogCut(r.dir, posted, weekBurnRowsLabel(posted.length))}>
                      <ListTodo size={14} /> backlog · {weekBurnRowsLabel(posted.length)}
                    </Button>
                  </div>
                )}
                {on && (
                  <div className="wb-repo">
                    <PromptComposer inline rows={1} prompts={[note]} placeholder="Extra for this repo only (optional)"
                      onChange={(next) => setDraft({ ...d, notes: { ...d.notes, [r.dir]: next[0] ?? "" } })} />
                    <Button aria-expanded={open} onClick={() => setShown(open ? null : r.dir)}>
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {open ? "Hide the prompt" : "Show the prompt"}
                    </Button>
                    {open && (
                      <pre className="wb-prompt">{weekBurnItemPrompt({
                        repoName: repos.find((x) => x.worktreePath === r.dir)?.repoName ?? r.title, healthSummary: st.readings?.[r.dir] ?? null, task, note,
                      })}</pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {hiddenNote && <RowSub as="div">{hiddenNote}</RowSub>}
      </>
    );
  };

  return (
    <Sheet title={SHEET.weekburn} icon={<CalendarClock size={18} />} onClose={() => c.nav.close("weekburn")}>
      <div className="sheet-scroll">{body()}</div>
    </Sheet>
  );
}
