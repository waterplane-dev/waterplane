/**
 * The `at` rule's editing state — how often, the quick chips, the headroom and
 * lead fields, *more*, and the anchor memory — cut out of `useSendSheet.ts` so
 * a second form can draw the SAME `RuleEditor` without a second copy of any of
 * it: the schedule-a-build form (`BuildScheduleForm.tsx`) is the other caller.
 *
 * Nothing here knows about a target, a prompt or a queue. It owns the fields
 * of ONE `SendWhen` (`when` / `setWhen` belong to the caller) and derives the
 * readings the rule components draw from.
 */
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RuleAnchor, ScheduleRule, WindowResets } from "@waterplane/shared";
import { composeRule, ruleAnchor, ruleRecurs } from "@waterplane/shared";
import { LS, lsGet } from "../storage";
import { DEVICE_TZ, anchorWindowOf, guardWindowOf, leadLabel, leadOk, pctOk, type SendWhen } from "../sendIntent";

export function useRuleFields(when: SendWhen, setWhen: Dispatch<SetStateAction<SendWhen>>) {
  /** The `at` editor's rarely-touched half (repeat, lead, grace, name). */
  const [more, setMore] = useState(false);
  /** Which quick chip set the instant, so it can stay lit. Compared by identity,
   *  never by re-deriving the time — the chips move with the clock. */
  const [quickKey, setQuickKey] = useState<string | null>(null);
  /**
   * The headroom condition's *another…* field: whether it is open, and the raw
   * string in it.
   *
   * Raw, like every other number field on this phone, so a half-typed "3" on
   * the way to "30" is not snapped back under the finger — and applied only
   * once it parses, so the rule never holds a number nobody finished typing.
   * The last one that DID parse is kept on this device (`LS.schedPctLeft`) and
   * comes back as a chip beside the fixed four, which is the whole point: a
   * percentage somebody chose once is a habit, and re-typing it on every rule
   * is the tax the four presets were supposed to remove.
   */
  const [pctOpen, setPctOpen] = useState(false);
  const [savedPct, setSavedPct] = useState<number | null>(() => pctOk(lsGet(LS.schedPctLeft)));
  const [pctRaw, setPctRaw] = useState<string>(() => String(pctOk(lsGet(LS.schedPctLeft)) ?? ""));
  /** *How long before*'s *another…* field — the same shape as the headroom one
   *  above, kept in minutes under `LS.schedLeadMin`. */
  const [leadOpen, setLeadOpen] = useState(false);
  const [savedLead, setSavedLead] = useState<number | null>(() => leadOk(lsGet(LS.schedLeadMin)));
  const [leadRaw, setLeadRaw] = useState<string>(() => {
    const n = leadOk(lsGet(LS.schedLeadMin));
    return n == null ? "" : leadLabel(n);
  });
  /** The last rule seen under each ANCHOR, so flipping between "at a time" and
   *  "a usage window" is not a delete — a ref, not state, because it is only
   *  ever read back into a fresh rule, never rendered itself. */
  const ruleMemo = useRef<{ clock?: ScheduleRule; window?: ScheduleRule }>({});

  function patchRule(patch: Partial<ScheduleRule>) {
    setWhen((w) => (w.kind === "at" ? { ...w, rule: { ...w.rule, ...patch } } : w));
  }

  /** Hand over a whole rule rather than merging one — what switching ANCHOR or
   *  RECURRENCE needs, since a merge leaves the fields of the kind just left
   *  behind (harmless — `cleanRule` strips them host-side — but stale). */
  function replaceRule(next: ScheduleRule) {
    setWhen((w) => (w.kind === "at" ? { ...w, rule: next } : w));
  }

  /** Switch the ANCHOR of a rule that is already `at` — clock time vs. a usage
   *  window — without discarding whichever the phone is not looking at: the
   *  last rule under each is kept in `ruleMemo`, so tapping back and forth
   *  restores the days/zone/condition someone already picked. A first visit
   *  to an anchor lands on ONCE (`composeRule(…, false, …)`). */
  function switchAnchor(next: RuleAnchor) {
    if (when.kind !== "at") return;
    setQuickKey(null);
    const prevAnchor = ruleAnchor(when.rule);
    if (prevAnchor !== next) ruleMemo.current[prevAnchor] = when.rule;
    const remembered = ruleMemo.current[next];
    replaceRule(remembered ?? composeRule(next, false, when.rule, Date.now(), DEVICE_TZ));
  }

  const rule = when.kind === "at" ? when.rule : null;
  const days = rule?.days ?? [];
  const anchor: RuleAnchor | null = rule ? ruleAnchor(rule) : null;
  const recurs = rule ? ruleRecurs(rule) : false;
  /**
   * The two usage meters, kept apart: the one this rule is ANCHORED to, and the
   * one its condition READS. They were the same field until the instruction
   * people kept asking for turned out to need both at once — *right after the
   * session window resets, but only if 30% of the week is left*. Naming one of
   * them meant giving up the other.
   *
   * The same defaults `shared/schedule.ts` reads with (`anchorWindow` /
   * `guardOf`), so the sentence under the control and the sentence `describeRule`
   * puts on the row cannot disagree about which meter was read.
   */
  const anchorW = rule ? anchorWindowOf(rule) : "session";
  const guardW = rule ? guardWindowOf(rule) : "session";

  return {
    more, setMore, quickKey, setQuickKey, pctOpen, setPctOpen, savedPct, setSavedPct, pctRaw, setPctRaw,
    leadOpen, setLeadOpen, savedLead, setSavedLead, leadRaw, setLeadRaw, ruleMemo,
    patchRule, replaceRule, switchAnchor, rule, days, anchor, recurs, anchorW, guardW,
  };
}

/** What `RuleEditor`, `WindowRule`, `LeadPick` and `MoreRule` read: the rule
 *  fields above plus the caller's `when`, its preview and the usage reading.
 *  `SendSheetModel` is a superset; `BuildScheduleForm` builds exactly this. */
export type RuleModel = ReturnType<typeof useRuleFields> & {
  when: SendWhen;
  setWhen: Dispatch<SetStateAction<SendWhen>>;
  preview: number | null;
  usage?: WindowResets | null;
  /** Re-time mode (the Send sheet only): moves rows, so never names them. */
  retime?: { ids: string[] } | null;
};
