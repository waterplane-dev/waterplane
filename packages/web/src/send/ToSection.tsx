/** The To row and its expansion, with the budget chip. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { ChevronDown, ChevronRight, DoorClosed, DoorOpen, History, ListOrdered, Play, SendHorizontal, Split, Wallet } from "lucide-react";
import { RadioRows } from "../kit";
import { LaunchRow } from "./LaunchRow";
import { FlagWhenDoneRow } from "./FlagWhenDoneRow";
import { BudgetField } from "../BudgetField";
import { budgetChipWords } from "../budgetInput";
import { RepoPicker, RepoSelect } from "../RepoPicker";
import { Unavailable } from "../Unavailable";
import { clockSessionNote, budgetOfTarget, launchOfTarget, targetWords, withBudget, withLaunch } from "../sendIntent";
import { Empty } from "../Empty";
import { SessionName } from "../SessionName";
import { CLOSE_CHOICES, type CloseChoice, closeChoiceDraft, closeChoiceLabel, closeChoiceOf, closeEffectWords } from "../autoSessions";
import type { SendSheetModel } from "./useSendSheet";
import { firstSession, cwdOf, dirsOf } from "./sendTargets";

export function ToSection({ m }: { m: SendSheetModel }) {
  const {
    seed, repos, live, names, closeGlobal, seqMeans, target, setTarget, when, sequential, setSequential, open, setOpen, budgetOpen, setBudgetOpen,
  } = m;
  /**
   * **A cap on the session(s) this send opens** — a `budget…` chip, collapsed
   * until it is wanted, drawn only on the two targets that OPEN sessions (a
   * live session's budget is set on the session). The cap lives on the target
   * (`SendTarget.budget`) and the button restates it (`sendLabel`). Words are
   * `BudgetField`'s, which is also the launch ask's field.
   */
  const bud = budgetOfTarget(target);
  const budgetRow = (
    <>
      <div className="sched-days" style={{ marginTop: 6 }}>
        <button className={`row-chip${bud ? " on" : ""}`} aria-pressed={budgetOpen}
          onClick={() => setBudgetOpen(!budgetOpen)}>
          <Wallet size={13} /> {bud ? budgetChipWords(bud) : "budget…"}
        </button>
      </div>
      {budgetOpen && (
        <BudgetField initial={bud ?? null} onChange={(b) => setTarget((t) => withBudget(t, b))}
          calFor="A percent is converted from dollars at the window's measured rate once the session is running — until there is a fresh usage reading, nothing is held." />
      )}
    </>
  );
  // The *model* row — the Start-with picker, offered and never forced (`LaunchRow`).
  const launchRow = <LaunchRow m={m} />;
  const flagRow = <FlagWhenDoneRow target={target} when={when} setTarget={setTarget} />;
  return (
    <>
      {/* ── To ─────────────────────────────────────────────────────── */}
      <button className="send-sum" onClick={() => setOpen(open === "to" ? null : "to")}>
        <span className="send-sum-k">To</span>
        <span className="send-sum-v">{targetWords(target, names, when)}</span>
        {open === "to" ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {/* What a clock aimed at a session will do, said on the *To* row rather
          than inside the WHEN editor that makes it true: the pair can also
          arrive seeded, with both rows collapsed, and a sentence only visible
          under an expanded *When* would say nothing at all on exactly the
          open this exists for. Read off the two live answers, so changing
          either one retires it rather than leaving it describing a state that
          has moved on. */}
      {clockSessionNote(target, when, target.kind === "session" ? names.sessionTitle(target.sessionId) : "") && (
        <div className="form-hint">
          {clockSessionNote(target, when, target.kind === "session" ? names.sessionTitle(target.sessionId) : "")}
        </div>
      )}
      {open === "to" && (
        <div className="send-exp">
          {/* Three answers to WHERE, and they are three different things:
              join a conversation that is already running, open one, or do
              it in several repos at once. There was a fourth — *work item*
              — which meant "a repo's shared backlog conversation", a thing
              this UI never showed and could not name; it and *new session*
              now do exactly the same thing host-side, so one of them is
              drawn. What was genuinely different about continuing survives
              as the chip below. With nothing open "this session" is not a
              choice, and not a dimmed one either: it is not drawn, and the
              reason is drawn instead (below). */}
          <RadioRows<"session" | "repo" | "repos"> label="Where it goes"
            value={target.kind === "session" || target.kind === "repo" || target.kind === "repos" ? target.kind : null}
            options={[
              ...(live.length ? [{ key: "session" as const, label: <><SendHorizontal size={13} /> this session</>, title: "type it into a session that is open right now" }] : []),
              { key: "repo" as const, label: <><Play size={13} /> a new session</>, title: "open a session for these words and run them there" },
              { key: "repos" as const, label: <><Split size={13} /> several repos</>, title: "one prompt, several repos" },
            ]}
            onChange={(k) => setTarget(k === "session"
              ? firstSession(live, seed.cwdHint)
              : k === "repo"
                ? withLaunch(withBudget({ kind: "repo", cwd: cwdOf(target, repos, seed.cwdHint) }, budgetOfTarget(target)), launchOfTarget(target))
                : withLaunch(withBudget({ kind: "repos", dirs: dirsOf(target, seed.cwdHint) }, budgetOfTarget(target)), launchOfTarget(target)))} />
          {/* The missing segment, as the sentence it is. `Unavailable` is the
              house form for exactly this — what a surface cannot do, said
              without being asked for, never a shape you can aim a thumb at. */}
          {!live.length && (
            <Unavailable cants={[{ label: "“this session”", reason: "nothing is open on this desktop right now" }]} />
          )}

          {target.kind === "session" && (
            <div className="pad-pick">
              <div className="form-hint">Which session?</div>
              {live.map((s) => (
                <button key={s.id} className={`row${target.sessionId === s.id ? " sched-on" : ""}`}
                  onClick={() => setTarget({ kind: "session", sessionId: s.id, cwd: s.cwd })}>
                  <span className="row-title">{s.title}</span>
                  {/* The desktop's own name for the conversation. Without it
                      this list is the repo name repeated once per session and
                      the question is unanswerable — `SessionName.tsx`. */}
                  <SessionName s={s} />
                  <span className="row-sub">{s.turnActive ? "working" : "idle"}</span>
                </button>
              ))}
              {!live.length && <Empty>No live sessions.</Empty>}
            </div>
          )}
          {target.kind === "repo" && (
            <>
              <RepoSelect repos={repos} home={seed.cwdHint ?? null} value={target.cwd} worktreeFilter
                onChange={(dir) => setTarget({ ...target, cwd: dir })} aria-label="repo" />
              {/* The one thing that was genuinely different about the retired
                  *work item* target: joining what the repo already knows.
                  `claude --continue`, so it needs no live session and nothing
                  has to still be open — and it is a CHOICE on this send, not
                  a property of which segment happened to be tapped. */}
              <div className="sched-days" style={{ marginTop: 6 }}>
                <button className={`row-chip${target.resume ? " on" : ""}`}
                  onClick={() => setTarget({ ...target, resume: target.resume ? undefined : true })}>
                  <History size={13} /> pick up its last conversation
                </button>
              </div>
              <div className="form-hint">
                {target.resume
                  ? "It reopens this repo's last conversation and carries on in it — everything that one read is already in the window, and every turn pays for it again."
                  : "Otherwise it starts clean — cheaper for anything that does not need what the last one knew."}
              </div>
              {/* **Its session once the work is done** — asked only where
                  the DESKTOP opens it (a backlog item, a chain, a schedule):
                  a `now` is a session the person opened, which nothing
                  closes. Default inherits the global and sends nothing. */}
              {when.kind !== "now" && (
                <>
                  <div className="section section-head"><span>Its session once the work is done</span></div>
                  <RadioRows<CloseChoice> label="Its session once the work is done"
                    value={closeChoiceOf(target.closeWhenDone)}
                    options={CLOSE_CHOICES.map((c) => ({
                      key: c,
                      label: <>{c === "close" ? <DoorClosed size={13} /> : c === "keep" ? <DoorOpen size={13} /> : null} {closeChoiceLabel(c, closeGlobal)}</>,
                    }))}
                    onChange={(c) => setTarget({ ...target, closeWhenDone: closeChoiceDraft(c) })} />
                  <div className="form-hint">{closeEffectWords(target.closeWhenDone, closeGlobal)}</div>
                </>
              )}
              {flagRow}
              {launchRow}
              {budgetRow}
            </>
          )}
          {target.kind === "repos" && (
            <RepoPicker multi repos={repos} home={seed.cwdHint ?? null} selected={target.dirs}
              listClass="pad-pick"
              onChange={(dirs) => setTarget((t) => withLaunch(withBudget({ kind: "repos", dirs }, budgetOfTarget(t)), launchOfTarget(t)))}
              countHint={sequential ? "· one at a time in each" : "· a fresh session in each"} />
          )}
          {/* The fan-out's model row, said here so no rule saves a model unseen. */}
          {target.kind === "repos" && flagRow}
          {target.kind === "repos" && launchRow}
          {target.kind === "repos" && budgetRow}
          {target.kind === "shell" && (
            <div className="form-hint">
              A build command — a shell in <b>{names.repoName(target.cwd)}</b>, no agent and no session.
            </div>
          )}

          {/* Sequential-vs-parallel, at composition time and only where it can
              mean anything (`sequentialMeans`). It was never a choice before:
              it was baked into whichever sheet you opened, or repaired
              afterwards in the queue manager. */}
          {seqMeans && (
            <>
            <div className="section section-head"><span>How many at once</span></div>
            <RadioRows<"parallel" | "sequential"> label="How many at once"
              value={sequential ? "sequential" : "parallel"}
              options={[
                { key: "parallel", label: <><Split size={13} /> all at once</> },
                { key: "sequential", label: <><ListOrdered size={13} /> one at a time</> },
              ]}
              onChange={(k) => setSequential(k === "sequential")} />
            </>
          )}
          {seqMeans && <div className="form-hint">{sequential ? seqMeans.on : seqMeans.off}</div>}
        </div>
      )}
    </>
  );
}
