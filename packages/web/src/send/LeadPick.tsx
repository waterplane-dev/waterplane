/** *How long before* — the usage-window rule's lead: presets, a typed one, and
 *  the chip a typed one leaves behind. Split from `WindowRule.tsx`. */
import { LS, lsSet } from "../storage";
import { leadChoices, leadLabel, leadOk, leadWords } from "../sendIntent";
import type { RuleModel } from "./useRuleFields";
import { Hint } from "../kit/Hint";

export function LeadPick({ m }: { m: RuleModel }) {
  const { leadOpen, setLeadOpen, savedLead, setSavedLead, leadRaw, setLeadRaw, patchRule } = m;
  const rule = m.rule as NonNullable<typeof m.rule>;
  return (
    <>
      {/* The presets plus whatever was typed, the headroom row's
          shape: one row of equals, and an *another…* for the lead
          none of them is. See `leadChoices`. */}
      <div className="sched-days">
        {leadChoices(savedLead, -(rule.offsetMin ?? 0)).map((m) => (
          <button key={m} className={`row-chip${(rule.offsetMin ?? 0) === -m ? " on" : ""}`}
            onClick={() => patchRule({ offsetMin: -m })}>{leadLabel(m)}</button>
        ))}
        <button className={`row-chip${leadOpen ? " on" : ""}`}
          title="type a lead the chips don't cover — it is kept on this phone and offered beside them next time"
          onClick={() => setLeadOpen((v) => !v)}>another…</button>
      </div>
      {leadOpen && (
        <>
          <div className="search-row sched-row">
            <input className="search" type="text" inputMode="text" autoCapitalize="off" autoCorrect="off"
              placeholder="45m, 4h, 1h30"
              value={leadRaw}
              onChange={(e) => {
                setLeadRaw(e.target.value);
                const n = leadOk(e.target.value);
                // Applied and remembered only once it parses — same rule
                // as the headroom field: never a keystroke on the way.
                if (n != null) { patchRule({ offsetMin: -n }); setSavedLead(n); lsSet(LS.schedLeadMin, String(n)); }
              }} />
            <span>before</span>
          </div>
          {/* Echoes what it READ, so a bare `4` meant as hours shows
              up as 4m on the row being typed on. */}
          <Hint>
            {leadWords(leadRaw) ?? `Read as ${leadLabel(leadOk(leadRaw)!)} before the reset. Kept on this phone — offered as a chip on the next rule you write.`}
          </Hint>
        </>
      )}
    </>
  );
}
