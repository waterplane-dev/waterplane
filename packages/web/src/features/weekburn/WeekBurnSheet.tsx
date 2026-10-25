/**
 * "This week's burn": which repos get the rest of the subscription week.
 * The pick is the approval and is bound to ONE week by the host; nothing here
 * runs anything. When and why it starts is the shared plan's sentence, printed
 * as it arrives.
 */
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckSquare, Square } from "lucide-react";
import type { WeekBurnStatus } from "@waterplane/shared";
import { useCore } from "../../sdk";
import { api } from "../../api";
import { Sheet, Empty, Unavailable, Button, Hint, Row, RowTitle, RowSub } from "../../kit";
import { hhmm } from "../../format";
import { useRemoteResource } from "../../useRemoteResource";
import { saveWeekBurn } from "./actions";
import { BRANCH_NOTE, lastWeekHere, runningWords, sameAsLastOffered, saveVerb, stopChoices, toggleDir } from "./logic";

const baseName = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir;

export function WeekBurnSheet() {
  const c = useCore();
  const res = useRemoteResource<WeekBurnStatus>("weekburn", () => api.getWeekBurn());
  const st = res.data;
  const repos = c.world.visibleRepos;
  const known = repos.map((r) => r.worktreePath);

  // The draft starts from this week's pick (empty when none) the first time the host answers,
  // and again after a save; a reload while it is being edited never overwrites it.
  const [draft, setDraft] = useState<{ repos: string[]; recurring: boolean; stopPct: number } | null>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (!st || seeded.current) return;
    seeded.current = true;
    setDraft({ repos: st.pickedThisWeek ? st.prefs.repos : [], recurring: st.prefs.recurring, stopPct: st.prefs.stopPct });
  }, [st]);
  const d = draft;

  const apply = (next: WeekBurnStatus | null) => {
    if (!next) return;
    res.set(next);
    setDraft({ repos: next.pickedThisWeek ? next.prefs.repos : [], recurring: next.prefs.recurring, stopPct: next.prefs.stopPct });
  };

  const body = () => {
    if (!st || !d) return <Empty res={res} empty={!st} thing="this week's burn" />;
    if (!st.available) {
      return <Unavailable cants={[{ label: "this week's burn", reason: st.unavailableText ?? "Not available on this desktop." }]} />;
    }
    const verb = saveVerb(d.repos.length, st.pickedThisWeek);
    const last = lastWeekHere(st, known);
    const running = new Map(st.running.map((r) => [r.repoDir, r]));
    return (
      <>
        {st.plan && (
          <div>
            <RowTitle as="div"><CalendarClock size={16} /> Starts {hhmm(st.plan.startAt)}</RowTitle>
            <RowSub as="div">{st.plan.reasonText}</RowSub>
          </div>
        )}
        {st.stoppedText && <Hint tone="warn">{st.stoppedText}</Hint>}

        {sameAsLastOffered(st, known) && (
          <div>
            <Button onClick={async () => apply(await saveWeekBurn({ sameAsLast: true }, last.length))}>Same as last week</Button>
            <RowSub as="div">{last.map(baseName).join(", ")}</RowSub>
          </div>
        )}

        <div role="group" aria-label="repos for this week">
          {repos.map((r) => {
            const on = d.repos.includes(r.worktreePath);
            const run = running.get(r.worktreePath);
            const Box = on ? CheckSquare : Square;
            return (
              <Row as="button" key={r.worktreePath} role="checkbox" aria-checked={on}
                onClick={() => setDraft({ ...d, repos: toggleDir(d.repos, r.worktreePath) })}>
                <Box size={18} />
                <RowTitle>{r.repoName}{r.isPrimary ? "" : ` · ${r.branch}`}</RowTitle>
                {run && <RowSub as="div">{runningWords(run)}</RowSub>}
              </Row>
            );
          })}
        </div>

        <Row as="button" role="checkbox" aria-checked={d.recurring} onClick={() => setDraft({ ...d, recurring: !d.recurring })}>
          {d.recurring ? <CheckSquare size={18} /> : <Square size={18} />}
          <RowTitle>Ask me each week</RowTitle>
          <RowSub as="div">A reminder to pick again. It never reuses last week's repos by itself.</RowSub>
        </Row>

        <div>
          <RowTitle as="div">Stop when the week is at</RowTitle>
          <div className="row-wrap">
            {stopChoices(st.prefs.stopPct).map((p) => (
              <Button key={p} className={d.stopPct === p ? "active" : undefined} onClick={() => setDraft({ ...d, stopPct: p })}>{p}%</Button>
            ))}
          </div>
        </div>

        <Hint>{BRANCH_NOTE}</Hint>

        {verb.kind === "none"
          ? <Hint>{verb.why}</Hint>
          : (
            <Button variant={verb.kind === "save" ? "primary" : undefined} onClick={async () => apply(await saveWeekBurn(
              { repos: d.repos, recurring: d.recurring, stopPct: d.stopPct }, d.repos.length))}>
              {verb.label}
            </Button>
          )}
      </>
    );
  };

  return (
    <Sheet title="This week's burn" icon={<CalendarClock size={18} />} onClose={() => c.nav.close("weekburn")}>
      {body()}
    </Sheet>
  );
}
