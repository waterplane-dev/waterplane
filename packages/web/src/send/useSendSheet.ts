/** All of the sheet's state, refs, effects, derivations and handlers, in the order they always ran. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RuleAnchor } from "@waterplane/shared";
import { attachBlockers, attachmentsReady, composeRule, describeRule, ruleAnchor, type AttachStatus } from "@waterplane/shared";
import { intentTitle } from "../activityRows";
import { loadSheetDraft, saveSheetDraft } from "../outbox";
import { track } from "../usage";
import { DEVICE_TZ, chainCandidates, inboxRefs, onceIn, previewOf, resumeWhen, retimeBlocker, retimeWhenLabel, RETIME_NOW_SEG, sendBlocker, sendLabel, sequentialMeans, whenWords, windowIn, type SendIntent, type SendNames, type SendTarget, type SendWhen } from "../sendIntent";
import { usePref } from "../core/prefs";
import type { SendSheetProps } from "./sendSheetTypes";
import { defaultTarget } from "./sendTargets";
import { useRuleFields } from "./useRuleFields";

export function useSendSheet(props: SendSheetProps) {
  const {
    seed, sessions, repos, usage, intents, buildName, onAttach, onAnnotate, resume, onDecide, onSend, onClose,
  } = props;
  const live = useMemo(() => sessions.filter((s) => s.running), [sessions]);
  // Must match `App.SEND_DRAFT`: App writes the seed into this buffer before
  // the sheet mounts, and the annotator round trip appends to the same one.
  const draftKey = seed.draftKey ?? "send.compose";
  /** Re-time mode (`SendSeed.retime`): the When editor alone, over rows that exist. */
  const retime = seed.retime ?? null;

  // The chain is ONE stored string separated by a form feed — the same shape
  // and the same reason as the sheet drafts it replaces: the store is a flat
  // Record<string,string>, and \f cannot be typed on a phone keyboard, so it
  // can never appear inside a prompt and split it.
  const [prompts, setPrompts] = useState<string[]>(() => {
    // Re-time mode has no words, and must not read — or write — the compose
    // draft: that slot is somebody's half-written message.
    const stashed = retime ? null : loadSheetDraft(draftKey);
    if (stashed) return stashed.split("\f");
    return seed.prompts?.length ? seed.prompts : [""];
  });
  // The ref is the authority: attaching a file appends a path and this sheet
  // can unmount (the annotator takes the overlay) before a state update lands.
  const promptsRef = useRef(prompts);
  function updatePrompts(next: string[]) {
    promptsRef.current = next;
    setPrompts(next);
    // Written HERE, not only in an effect: an effect belonging to a component
    // that unmounts in the same commit never runs, so the path just appended
    // would be missing from the buffer this sheet re-reads when it comes back.
    if (!retime) saveSheetDraft(draftKey, next.join("\f"));
  }
  useEffect(() => { if (!retime) saveSheetDraft(draftKey, prompts.join("\f")); }, [draftKey, prompts, retime]);

  const names: SendNames = {
    repoName: (cwd) => repos.find((r) => r.worktreePath === cwd)?.repoName ?? cwd.split("/").filter(Boolean).pop() ?? cwd,
    sessionTitle: (id) => sessions.find((s) => s.id === id)?.title ?? "that session",
    buildName,
  };

  // Both halves of the WHEN in one read (`resumeWhen`): the live answer and the
  // `at` rule the sheet is holding behind it. Read apart they came back apart —
  // see `SendResume.parkedAt`.
  const resumed = resumeWhen(resume, seed.when);
  const seededTarget = resume?.target ?? seed.target ?? defaultTarget(live, repos, seed.cwdHint);
  // A recalled clock over a seeded session used to arrive already refused, and
  // the sheet answered by re-aiming the send at the session's repo. It keeps
  // the session now (`clockSessionNote`): the host remembers the conversation,
  // so the pair of answers is sayable and nothing has to be replaced.
  const [target, setTarget] = useState<SendTarget>(() => seededTarget);
  const [when, setWhen] = useState<SendWhen>(() => resumed.when);
  // The `at` rule's own fields — shared with the schedule-a-build form, so it
  // draws the same `RuleEditor` off the same state (`useRuleFields.ts`).
  const {
    more, setMore, quickKey, setQuickKey, pctOpen, setPctOpen, savedPct, setSavedPct, pctRaw, setPctRaw,
    leadOpen, setLeadOpen, savedLead, setSavedLead, leadRaw, setLeadRaw, ruleMemo,
    patchRule, replaceRule, switchAnchor, rule, days, anchor, recurs, anchorW, guardW,
  } = useRuleFields(when, setWhen);
  // The global *close automatic sessions when done* — what the per-item
  // choice's default (inherit) means today.
  const closeGlobal = usePref("closeWhenDone");
  const [sequential, setSequential] = useState(() => resume?.sequential ?? !!seed.sequential);
  // Same promise as the draft, for the half of the decision that is not words.
  // Reported on every change rather than on the way out, for the draft's reason:
  // handing images to the annotator unmounts this sheet, and a component that
  // unmounts in the same commit never runs its cleanup in time to be read.
  // Through a ref, so the callback's identity (a fresh arrow on every render of
  // the caller) is not itself a change in the decision.
  const decideRef = useRef(onDecide);
  decideRef.current = onDecide;
  // `parkedAt` rides along: the rule a trip out of the clock is HOLDING is as
  // much of the decision as the three live answers, and the row promises it is
  // kept. Read off the ref rather than from state because `leaveAt` writes it in
  // the same breath as `setWhen`, so this effect already sees the fresh one.
  useEffect(
    () => { decideRef.current?.({ target, when, sequential, parkedAt: atMemo.current ?? undefined }); },
    [target, when, sequential],
  );
  /** Which summary row is expanded. One at a time — two open pickers on a phone
   *  is a scroll, and the point of a summary row is that it is one line. */
  const [open, setOpen] = useState<null | "to" | "when">(retime ? "when" : null);
  /** The `budget…` row's field is open. The cap itself lives ON the target
   *  (`SendTarget.budget`), so closing the field keeps it and the button says so. */
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false); // the *model* row's picker; the pick lives ON the target
  /**
   * The whole `at` decision, kept across a trip OUT of the clock — to `now`, to
   * `when it's free`, to `after another…`.
   *
   * `ruleMemo` above only remembered across an ANCHOR switch, so the far more
   * ordinary gesture deleted everything: set *at a time* → *repeating* → Thu →
   * 16:00 → *more* → hours → a name, then tap `when it's free` on the row above
   * to see what it says, and the rule is gone with no sentence about it. That
   * is the "writing over words nobody typed" rule applied to a decision rather
   * than to prose — a schedule is seven taps, and seven taps is something
   * somebody made.
   *
   * The WHOLE `when` and not just its rule: grace, the name and *wait until
   * it's free* are part of the same decision, and restoring three of the four
   * fields is its own small delete. A ref because it is never rendered; the
   * hint under row one is drawn off it, which is the only thing it is read for
   * besides the restore.
   */
  const atMemo = useRef<SendWhen | null>(resumed.parkedAt);
  /** Which turn the caret is in — written by `PromptComposer` on focus, read by
   *  the action bar's mic so speech lands in the turn the person is looking at
   *  rather than always in turn one. */
  const focusStep = useRef(0);

  const [states, setStates] = useState<AttachStatus[]>([]);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [shots, setShots] = useState<string[]>([]);

  const text = prompts[0] ?? "";
  const intent: SendIntent = { prompts, target, when, sequential };
  const preview = previewOf(when, usage ?? undefined);
  /**
   * **The durable row this sheet was opened ON**, when it was opened on one —
   * the backlog's *when* verb, an Activity row's *edit*, a schedule card.
   *
   * Handed to `sendBlocker` so the two WHENs that cannot be re-decided on this
   * row say so on the button, before the tap. Without it, choosing *now* or
   * *when it's free* here posted a second row and left the first one armed:
   * the same words ran twice, once in turn and once at their instant.
   */
  const editing = useMemo(
    () => (seed.scheduleId ? intents.find((x) => x.id === seed.scheduleId) ?? null : null),
    [intents, seed.scheduleId],
  );
  const blocker = retime ? retimeBlocker(when, preview, retime.ids.length) : sendBlocker(intent, preview, editing);
  const label = retime
    ? retimeWhenLabel(retime.ids.length, when.kind === "at" ? describeRule(when.rule) : when.kind === "now" ? RETIME_NOW_SEG : whenWords(when, preview))
    : sendLabel(intent, names, preview);
  // Only where it can mean anything — and never under a wall-clock rule or a
  // chain: those fire ONE action, and how it spreads is the executor's
  // business, exactly as it is for a schedule.
  const seqMeans = when.kind === "at" || when.kind === "after" ? null : sequentialMeans(target);
  /**
   * What *after another…* may point at. Frozen per mount rather than ticking:
   * this list decides what is OFFERABLE, and a row ageing out of the six-hour
   * window while somebody is mid-decision would take the thing they were about
   * to tap off the screen. The store itself still arrives live — a row that
   * starts, finishes or is cancelled while the sheet is open is redrawn — it is
   * only the "recently settled" EDGE that is held still.
   */
  const openedAt = useRef(Date.now());
  const chainRows = useMemo(
    // `scheduleId` is the row being edited, when this sheet was opened on one.
    // Dropping it is what stops the one cycle this side can see.
    // In re-time mode every row being moved is dropped for the same reason.
    () => chainCandidates(intents, openedAt.current, seed.scheduleId)
      .filter((c) => !retime?.ids.includes(c.id)),
    [intents, seed.scheduleId, retime],
  );
  /** The repo a file would be uploaded INTO. A sweep has several, so its first
   *  is the one paths are minted against — the same rule the pad follows: bytes
   *  need one inbox and one path, decided now. */
  const attachCwd = target.kind === "repos" ? target.dirs[0] ?? seed.cwdHint ?? "" : target.cwd;
  const attachRepo = repos.find((r) => r.worktreePath === attachCwd) ?? null;
  const repoId = seed.repoId ?? attachRepo?.id ?? null;
  const waitsForFiles = inboxRefs(text).length;

  async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    setBusy(true);
    try { return await run(); }
    finally { setBusy(false); setNonce((n) => n + 1); }
  }

  /** Picked files, routed by the file's own type — images to the annotator,
   *  everything else straight into the send queue. The same rule every other
   *  picker in this app follows, so a JPEG reached through "file" behaves like
   *  one reached through "image". */
  async function pick(files: File[]) {
    if (!files.length || !attachRepo) return;
    const images = files.filter((f) => /^image\//.test(f.type));
    const rest = files.filter((f) => !/^image\//.test(f.type));
    if (rest.length) {
      setBusy(true);
      try {
        const paths = await onAttach(rest, attachRepo);
        if (paths.length) {
          setShots((cur) => [...cur, ...paths]);
          const cur = promptsRef.current.length ? promptsRef.current.slice() : [""];
          const head = cur[0] ?? "";
          cur[0] = head ? `${head}${/\s$/.test(head) ? "" : " "}${paths.join(" ")}` : paths.join(" ");
          updatePrompts(cur);
        }
      } finally { setBusy(false); }
    }
    // This unmounts the sheet. The draft is already on disk per keystroke, and
    // the marked path is appended to the same buffer, so both come back.
    if (images.length) onAnnotate(images, attachRepo);
  }

  /** Switch the ANCHOR — clock time vs. a usage window — without discarding
   *  whichever the phone is not looking at: the last rule under each is kept
   *  in `ruleMemo`, so tapping back and forth restores the days/zone/condition
   *  someone already picked rather than resetting to a blank default. A first
   *  visit to an anchor (nothing remembered yet) lands on ONCE — the default
   *  for either anchor, matching `onceIn`/`windowIn` — rather than carrying
   *  over whatever the other anchor happened to be set to. */
  function setAnchor(next: RuleAnchor) {
    // A clock may name a session now, so this tap changes nothing about *To*.
    // What it used to do — re-aim the send at the session's repo — is why
    // `clockSessionNote` exists: the promise is drawn on the *To* row instead,
    // and the answer somebody gave stands.
    if (when.kind !== "at") {
      // Coming BACK to a clock. Whatever was configured before the trip out is
      // restored whole (`atMemo`); only the rule is re-anchored when the tap
      // names the other anchor, which is what `ruleMemo` has always been for.
      const back = atMemo.current;
      if (back && back.kind === "at") {
        const remembered = ruleAnchor(back.rule) === next ? back.rule : ruleMemo.current[next];
        setWhen({ ...back, rule: remembered ?? composeRule(next, false, back.rule, Date.now(), DEVICE_TZ) });
        return;
      }
      setWhen(next === "window" ? windowIn() : onceIn(3600e3));
      return;
    }
    switchAnchor(next);
  }

  /**
   * Hang this send off another piece of work.
   *
   * Deliberately NO re-aim here, unlike `setAnchor` above: a clock cannot name
   * a session because the id lasts only as long as the process, and a rule may
   * fire days out — a chain is released by an event that is usually minutes
   * away, and the store holds a `session` target natively. So "when the
   * migration finishes, tell THIS session about it" is left exactly as the
   * person composed it.
   *
   * The first candidate is pre-filled for the reason every other answer in this
   * sheet is: the picker is drawn open right underneath with that row lit, so
   * the guess is visible and is one tap from being a different one. With no
   * candidates it lands on an empty id, which `sendBlocker` turns into a
   * sentence — the segment itself is never dimmed, because a `title` explaining
   * why is invisible on the device this sheet is used from.
   */
  function setAfter() {
    if (when.kind === "after") return;
    const head = chainRows[0];
    leaveAt({ kind: "after", id: head?.id ?? "", title: head ? intentTitle(head) : undefined });
  }

  /**
   * Leaving the clock for one of the three WHENs that is not a rule.
   *
   * The rule is kept rather than dropped, and the row says so — see `atMemo`.
   * Every exit from `at` goes through this one function, so there is no fourth
   * door that quietly deletes it.
   */
  function leaveAt(next: SendWhen) {
    if (when.kind === "at") atMemo.current = when;
    setWhen(next);
  }

  function go() {
    if (blocker) return;
    track("action:send.post");
    const final = promptsRef.current.map((p) => p.trim()).filter(Boolean);
    // This sheet's *model* row IS the launch question: never asked again on top.
    if (!onSend({ prompts: final, target, when, sequential, launchChosen: true })) return;
    if (!retime) saveSheetDraft(draftKey, "");
    onClose();
  }

  const ready = attachmentsReady(states);
  const blockers = attachBlockers(states);

  return {
    ...props,
    live, draftKey, retime, promptsRef, names, resumed, seededTarget, closeGlobal, decideRef, ruleMemo, atMemo, focusStep, text, intent, preview, editing, blocker, label, seqMeans, openedAt, chainRows, attachCwd, attachRepo, repoId, waitsForFiles, ready, blockers, rule, days, anchor, recurs, anchorW, guardW, prompts, setPrompts, target, setTarget, when, setWhen, sequential, setSequential, open, setOpen, more, setMore, budgetOpen, setBudgetOpen, launchOpen, setLaunchOpen, quickKey, setQuickKey, pctOpen, setPctOpen, savedPct, setSavedPct, pctRaw, setPctRaw, leadOpen, setLeadOpen, savedLead, setSavedLead, leadRaw, setLeadRaw, states, setStates, nonce, setNonce, busy, setBusy, shots, setShots, updatePrompts, guard, pick, patchRule, replaceRule, switchAnchor, setAnchor, setAfter, leaveAt, go,
  };
}

export type SendSheetModel = ReturnType<typeof useSendSheet>;
