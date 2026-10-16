/**
 * Settings › Sessions › spend marks: the orange and red thresholds a session's
 * Σ figure turns into a triangle at (`shared/spendwarn.ts`). Synced — how much
 * one session may spend before it is worth a mark is the person's budget.
 *
 * Four fields, two scales: a share of the week where this desktop has a weekly
 * limit reading to calibrate against (a subscription), dollars where it has not
 * (an API key, or a week not calibrated yet). A typed value commits on blur;
 * one that cannot be used is refused in words beside it, never clamped.
 */
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { SPEND_WARN_DEFAULT, cleanSpendWarn, type SpendWarnCfg } from "@waterplane/shared";
import { SetSwitch } from "../../SettingsKit.tsx";
import { setPref, usePref } from "../prefs.ts";
import { track } from "../../usage.ts";

type NumKey = "warnPct" | "highPct" | "warnUsd" | "highUsd";

const FIELDS: readonly { key: NumKey; label: string; prefix?: string; suffix?: string }[] = [
  { key: "warnPct", label: "orange at", suffix: "% of week" },
  { key: "highPct", label: "red at", suffix: "% of week" },
  { key: "warnUsd", label: "orange at", prefix: "$", suffix: "without a week reading" },
  { key: "highUsd", label: "red at", prefix: "$", suffix: "without a week reading" },
];

export function SpendWarnRow() {
  const cfg = usePref("spendWarn");
  const [draft, setDraft] = useState<Partial<Record<NumKey, string>>>({});
  const [why, setWhy] = useState<string | null>(null);

  const commit = (key: NumKey) => {
    const text = draft[key];
    if (text == null) return;
    const n = Number(text.trim().replace(",", ".").replace(/^\$|%$/g, ""));
    setDraft((d) => { const { [key]: _, ...rest } = d; return rest; });
    if (!(n > 0) || !Number.isFinite(n)) { setWhy(`“${text}” is not a number above zero — kept ${String(cfg[key])}.`); return; }
    const next: SpendWarnCfg = { ...cfg, [key]: n };
    const pair = key.endsWith("Pct") ? (["warnPct", "highPct"] as const) : (["warnUsd", "highUsd"] as const);
    if (!(next[pair[1]] > next[pair[0]])) { setWhy("Red has to be above orange — kept what was there."); return; }
    if (key.endsWith("Pct") && n > 100) { setWhy("A share of the week cannot be more than 100%."); return; }
    setWhy(null);
    track("action:spendWarn.set");
    setPref("spendWarn", cleanSpendWarn(next));
  };

  const isDefault = (["warnPct", "highPct", "warnUsd", "highUsd"] as const).every((k) => cfg[k] === SPEND_WARN_DEFAULT[k]);

  return (
    <SetSwitch
      id="spend-warn" label="spend marks" icon={TriangleAlert}
      on={cfg.on}
      onChange={() => { track("action:spendWarn.toggle"); setPref("spendWarn", { ...cfg, on: !cfg.on }); }}
      note={cfg.on
        ? <>A session's Σ figure gets an orange triangle at {cfg.warnPct}% of the week and a red one at {cfg.highPct}% — ${cfg.warnUsd} and ${cfg.highUsd} where there is no weekly limit reading.</>
        : <>Off: no session's spend is marked, whatever it reaches.</>}
      more={<>
        <p><b>Which scale.</b> With a subscription, the desktop measures what one percent of your week is in list-price dollars from its own <code>/usage</code> readings, and the marks are a share of that. With an API key there is no weekly limit, so the dollar pair applies — and also on a subscription until the week has been measured.</p>
        <p><b>Where the dollar defaults come from.</b> On a Max plan one percent of a week measured at about $15 of list price, so 2% ≈ $30 and 5% ≈ $75. Another plan moves that rate; the percent pair follows it on its own.</p>
        <p><b>What a mark does.</b> It is a readout: one toast the first time a session passes each mark, and the triangle beside its spend. Nothing is paused or refused — for that, give a session its own budget.</p>
        {!isDefault && <p>Defaults: {SPEND_WARN_DEFAULT.warnPct}% / {SPEND_WARN_DEFAULT.highPct}% of week, ${SPEND_WARN_DEFAULT.warnUsd} / ${SPEND_WARN_DEFAULT.highUsd}.</p>}
      </>}
    >
      {cfg.on && FIELDS.map((f) => (
        <div className="set-item" key={f.key}>
          <label className="set-lead" htmlFor={`spend-warn-${f.key}`}>
            <span className="set-lbl" style={{ color: f.key.startsWith("warn") ? "var(--warn)" : "var(--dead)" }}>{f.label}</span>
          </label>
          <div className="budget-input">
            {f.prefix && <span className="budget-affix">{f.prefix}</span>}
            <input id={`spend-warn-${f.key}`} inputMode="decimal" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              value={draft[f.key] ?? String(cfg[f.key])}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => commit(f.key)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            {f.suffix && <span className="budget-affix">{f.suffix}</span>}
          </div>
        </div>
      ))}
      {why && <div className="set-warn">{why}</div>}
    </SetSwitch>
  );
}
