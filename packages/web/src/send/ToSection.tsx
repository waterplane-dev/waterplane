/** The To row and its expansion, with the budget chip. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { ChevronDown, ChevronRight, DoorClosed, DoorOpen, History, ListOrdered, Play, SendHorizontal, Split, Wallet } from "lucide-react";
import { BudgetField } from "../BudgetField";
import { budgetChipWords } from "../budgetInput";
import { RepoPicker, RepoSelect } from "../RepoPicker";
import { Unavailable } from "../Unavailable";
import { clockSessionNote, budgetOfTarget, targetWords, withBudget } from "../sendIntent";
import { Empty } from "../Empty";
import { SessionName } from "../SessionName";
import { CLOSE_CHOICES, closeChoiceDraft, closeChoiceLabel, closeChoiceOf, closeEffectWords } from "../autoSessions";
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
  return (
    <>
      {/* ── To ─────────────────────────────────────────────────────── */}
      <button className="send-sum" onClick={() => setOpen(open === "to" ? null : "to")}>
        <span className="send-sum-k">To</span>
        <span className="send-sum-v">{targetWords(target, names)}</span>
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
          <div className="segmented">
            {/* Three answers to WHERE, and they are three different things:
                join a conversation that is already running, open one, or do
                it in several repos at once. There was a fourth — *work item*
                — which meant "a repo's shared backlog conversation", a thing
                this UI never showed and could not name; it and *new session*
                now do exactly the same thing host-side, so one of them is
                drawn. What was genuinely different about continuing survives
                as the chip below. */}
            {/* With nothing open this is not a choice, and it is not a
                dimmed one either: it is not drawn, and the reason is drawn
                instead (below). A `disabled` segment differing by opacity is
                invisible on the one device this sheet is used from, and the
                reason lived in a `title` nobody on a phone can read. */}
            {!!live.length && (
              <button className={`seg${target.kind === "session" ? " on" : ""}`}
                title="type it into a session that is open right now"
                onClick={() => setTarget(firstSession(live, seed.cwdHint))}>
                <SendHorizontal size={13} /> this session
              </button>
            )}
            <button className={`seg${target.kind === "repo" ? " on" : ""}`}
              title="open a session for these words and run them there"
              onClick={() => setTarget(withBudget({ kind: "repo", cwd: cwdOf(target, repos, seed.cwdHint) }, budgetOfTarget(target)))}>
              <Play size={13} /> a new session
            </button>
            <button className={`seg${target.kind === "repos" ? " on" : ""}`}
              title="one prompt, several repos"
              onClick={() => setTarget(withBudget({ kind: "repos", dirs: dirsOf(target, seed.cwdHint) }, budgetOfTarget(target)))}>
              <Split size={13} /> several repos
            </button>
          </div>
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
                  <div className="sched-days" style={{ marginTop: 6 }}>
                    {CLOSE_CHOICES.map((c) => (
                      <button key={c} className={`row-chip${closeChoiceOf(target.closeWhenDone) === c ? " on" : ""}`}
                        aria-pressed={closeChoiceOf(target.closeWhenDone) === c}
                        onClick={() => setTarget({ ...target, closeWhenDone: closeChoiceDraft(c) })}>
                        {c === "close" ? <DoorClosed size={13} /> : c === "keep" ? <DoorOpen size={13} /> : null} {closeChoiceLabel(c, closeGlobal)}
                      </button>
                    ))}
                  </div>
                  <div className="form-hint">{closeEffectWords(target.closeWhenDone, closeGlobal)}</div>
                </>
              )}
              {budgetRow}
            </>
          )}
          {target.kind === "repos" && (
            <RepoPicker multi repos={repos} home={seed.cwdHint ?? null} selected={target.dirs}
              listClass="pad-pick"
              onChange={(dirs) => setTarget((t) => withBudget({ kind: "repos", dirs }, budgetOfTarget(t)))}
              countHint={sequential ? "· one at a time in each" : "· a fresh session in each"} />
          )}
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
            <div className="segmented" style={{ marginTop: 8 }}>
              <button className={`seg${sequential ? "" : " on"}`} onClick={() => setSequential(false)}>
                <Split size={13} /> all at once
              </button>
              <button className={`seg${sequential ? " on" : ""}`} onClick={() => setSequential(true)}>
                <ListOrdered size={13} /> one at a time
              </button>
            </div>
          )}
          {seqMeans && <div className="form-hint">{sequential ? seqMeans.on : seqMeans.off}</div>}
        </div>
      )}
    </>
  );
}
