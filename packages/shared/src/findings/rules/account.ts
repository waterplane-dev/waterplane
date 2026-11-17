/** Account-scope rules (PLAN §4): the pace against the account's windows and quotas. */
import type { FindingsResult } from "../types.js";
import { Acc, type FindingFacts } from "./facts.js";

export function accountRules(f: FindingFacts): FindingsResult {
  const a = new Acc(f, "account");
  const u = f.usage;
  const limits = { screen: "tokens" as const, box: "limits" as const };
  const one = (rule: string, why: string, r: { text: string } | null | undefined, over: boolean | undefined, passWhat: string, remedy: string): void => {
    if (r == null || over === undefined) { a.skip(rule, why); return; }
    if (a.blind(rule)) return;
    const id = `account.${rule}`;
    if (!over) a.pass(id, rule, passWhat);
    else a.find({ id, rule, kind: "cost", weight: "consider", what: r.text, evidence: limits, remedy: { kind: "howto", text: remedy }, waveVia: "ignore" });
  };
  one("week-pace", "no usage reading for the week", u?.week, u?.week?.runsOut, "The week is not on course to run out before it resets.", "Spread the heavy work over the rest of the window, or run mechanical lanes on a cheaper model.");
  one("period-pace", "no capped dollar period has a measured spend yet (one needs a cap, a spend figure and a tenth of its length behind it)", u?.period, u?.period?.firing, "Spend is within the pace for this period.", "Slow down or raise the cap if the pace is intended.");
  one("copilot-quota", "the usage registry holds no Copilot reading (the Copilot extension is off, or has not answered yet)", u?.copilot, u?.copilot ? u.copilot.usedPct >= 80 : undefined, "The Copilot quota is not close to its end.", "Save premium requests for the work that needs them.");
  return a.out;
}
