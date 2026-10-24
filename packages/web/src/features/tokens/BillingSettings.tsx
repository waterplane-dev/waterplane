/**
 * Settings › Sessions, right after the usage budget: WHICH account this desktop's
 * claude bills to, and the dollar periods (with an optional cap each) that an
 * account with no 5-hour or weekly window is judged by.
 *
 * Two rows. The profile row is a choice (auto-detect, or the person's word) and
 * says what was detected. The periods row lists the configured dollar periods,
 * each with its cap in a field that commits on blur, and one small form to add
 * another. Everything is sent back as `budget.set` (merged host-side): a cap goes
 * through `withLimit`/`withoutLimit`, which keep the legacy mirrors in step, and a
 * refusal is a sentence beside the field, never a clamp. A cap holds AUTOMATIC
 * work only; hand-sent prompts always pass — said once, in the row's fold.
 */
import { useState } from "react";
import { CircleDollarSign, Plus, UserRound, X } from "lucide-react";
import { hasScrapedWindows, withLimit, withoutLimit, type BillingProfile, type BudgetPeriod, type UsageBudget } from "@waterplane/shared";
import { useCore } from "../../sdk";
import { SetChoice, SetCustom, SetNote } from "../../SettingsKit";
import { ConfirmButton } from "../../Confirm";
import { parseBudgetInput } from "../../budgetInput";
import { buildPeriod, DOW, emptyDraft, periodCap, periodDescribe, PERIOD_KINDS, type PeriodDraft } from "../../periodWords";
import { track } from "../../usage";
import { useBilling } from "./store";
import { Button } from "../../kit";

type Pick = "auto" | Exclude<BillingProfile, "unknown">;

const PROFILE_WORD: Record<BillingProfile, string> = {
  subscription: "a Claude subscription", api: "an API key", cloud: "Bedrock or Vertex", unknown: "not detected yet",
};

export function BillingSettings() {
  const c = useCore();
  const status = useBilling();
  const held = c.world.budget;
  const cfg = held?.budget ?? null;
  const periods = (cfg?.periods ?? []).filter((p) => p.unit === "usd");

  const [caps, setCaps] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<PeriodDraft>(emptyDraft);
  const [newCap, setNewCap] = useState("");

  const send = (b: UsageBudget, receipt: string) => c.conn.liveSend({ t: "budget.set", budget: b }, receipt);

  const commitCap = (p: BudgetPeriod) => {
    const text = caps[p.id];
    if (text == null || !cfg) return;
    setCaps((d) => { const { [p.id]: _, ...rest } = d; return rest; });
    if (!text.trim()) {
      if (periodCap(cfg, p.id) == null) return;
      setWhy(null);
      track("action:period.cap.clear");
      send(withoutLimit(cfg, p.id), "cap cleared");
      return;
    }
    const r = parseBudgetInput("usd", text);
    if (!r.ok) { setWhy(r.reason); return; }
    setWhy(null);
    track("action:period.cap.set");
    send(withLimit(cfg, { periodId: p.id, max: r.max, unit: "usd" }), "cap saved");
  };

  const remove = (p: BudgetPeriod) => {
    if (!cfg) return;
    track("action:period.remove");
    send(withoutLimit({ ...cfg, periods: (cfg.periods ?? []).filter((x) => x.id !== p.id) }, p.id), "period removed");
  };

  const add = () => {
    if (!cfg) return;
    const built = buildPeriod(draft);
    if (!built.ok) { setWhy(built.reason); return; }
    let capMax: number | null = null;
    if (newCap.trim()) {
      const r = parseBudgetInput("usd", newCap);
      if (!r.ok) { setWhy(r.reason); return; }
      capMax = r.max;
    }
    setWhy(null);
    track("action:period.add");
    const next: UsageBudget = { ...cfg, periods: [...(cfg.periods ?? []).filter((x) => x.id !== built.period.id), built.period] };
    send(capMax != null ? withLimit(next, { periodId: built.period.id, max: capMax, unit: "usd" }) : next, "period saved");
    setAdding(false);
    setNewCap("");
    setDraft(emptyDraft());
  };

  const set = <K extends keyof PeriodDraft>(k: K, v: PeriodDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const picked: Pick = status?.source === "setting" ? (status.profile === "unknown" ? "auto" : status.profile) : "auto";
  const scraped = hasScrapedWindows(status?.profile);

  return (
    <>
      <SetChoice<Pick>
        id="billing-profile" radio label="billing profile" icon={UserRound}
        value={picked}
        options={[
          { value: "auto", label: "auto-detect" },
          { value: "subscription", label: "subscription" },
          { value: "api", label: "API key" },
          { value: "cloud", label: "Bedrock / Vertex" },
        ]}
        onChange={(v) => {
          track("action:billing.set");
          c.conn.liveSend({ t: "billing.set", profile: v === "auto" ? null : v }, v === "auto" ? "billing profile: auto-detect" : `billing profile set`);
        }}
        note={!status
          ? "This desktop has not reported one — the usage chips show the 5-hour and weekly windows."
          : status.source === "setting"
            ? <>You set this to {PROFILE_WORD[status.profile]}. Auto-detect clears it.</>
            : status.profile === "unknown"
              ? "Not detected — the usage chips show the 5-hour and weekly windows."
              : <>Detected: {PROFILE_WORD[status.profile]}.</>}
        more={<p>A subscription is read from <code>/usage</code> (two windows). An API key or a cloud account has no such windows, so the chips show dollars for the period below instead and <code>/usage</code> is not asked.</p>}
      />

      <SetCustom
        id="billing-periods" label="dollar periods and caps" icon={CircleDollarSign}
        note={scraped && periods.length === 0 ? "Optional on a subscription: a month or a span in dollars beside the two windows." : undefined}
        more={<>
          <p>Spend is this desktop's ledger at list price, not your invoice. A cap holds <b>automatic</b> work (the backlog, the queue, timed sends) until the period resets; a prompt you send by hand always goes. The hard stop is Anthropic's own spend limit.</p>
          <p>A calendar month starts on its billing day in the zone you name (the 31st means the last day of a short month). A rolling 30 days has no reset, so a schedule cannot wait for it.</p>
        </>}
      >
        {!cfg && <SetNote>Waiting for the desktop's budget.</SetNote>}
        {cfg && periods.map((p) => {
          const cap = periodCap(cfg, p.id);
          return (
            <div className="set-item" key={p.id}>
              <div className="set-lead"><span className="set-lbl">{periodDescribe(p)}</span></div>
              <div className="budget-input">
                <span className="budget-affix">cap $</span>
                <input inputMode="decimal" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  aria-label={`cap for ${periodDescribe(p)}`} placeholder="none"
                  value={caps[p.id] ?? (cap != null ? String(cap) : "")}
                  onChange={(e) => setCaps((d) => ({ ...d, [p.id]: e.target.value }))}
                  onBlur={() => commitCap(p)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                <ConfirmButton className="key" confirm="remove?" onConfirm={() => remove(p)}><X size={13} /> remove</ConfirmButton>
              </div>
            </div>
          );
        })}
        {cfg && periods.length === 0 && !adding && <SetNote>No dollar period yet — the chips have nothing to measure.</SetNote>}

        {cfg && !adding && (
          <div className="set-chips">
            <Button onClick={() => setAdding(true)}><Plus size={13} /> add a period</Button>
          </div>
        )}
        {cfg && adding && (
          <div className="set-item">
            <div className="set-chips" role="group" aria-label="period kind">
              {PERIOD_KINDS.map((k) => (
                <Button className={draft.kind === k.id ? "active" : undefined} key={k.id} onClick={() => set("kind", k.id)}>{k.label}</Button>
              ))}
            </div>
            {draft.kind === "month" && (
              <div className="budget-input">
                <span className="budget-affix">billing day</span>
                <input inputMode="numeric" aria-label="billing day of the month" value={draft.anchorDay} onChange={(e) => set("anchorDay", e.target.value)} />
              </div>
            )}
            {draft.kind === "week" && (
              <div className="set-chips" role="group" aria-label="week starts on">
                {DOW.map((d, i) => (
                  <Button className={draft.startDow === i ? "active" : undefined} key={d} onClick={() => set("startDow", i)}>{d}</Button>
                ))}
              </div>
            )}
            {(draft.kind === "month" || draft.kind === "week" || draft.kind === "day") && (
              <div className="budget-input">
                <span className="budget-affix">time zone</span>
                <input autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="time zone" value={draft.tz} onChange={(e) => set("tz", e.target.value)} />
              </div>
            )}
            {draft.kind === "span" && (
              <>
                <div className="budget-input">
                  <span className="budget-affix">first day</span>
                  <input type="date" aria-label="first day" value={draft.from} onChange={(e) => set("from", e.target.value)} />
                </div>
                <div className="budget-input">
                  <span className="budget-affix">last day</span>
                  <input type="date" aria-label="last day, included" value={draft.to} onChange={(e) => set("to", e.target.value)} />
                </div>
              </>
            )}
            <div className="budget-input">
              <span className="budget-affix">cap $</span>
              <input inputMode="decimal" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="none" aria-label="cap in dollars"
                value={newCap} onChange={(e) => setNewCap(e.target.value)} />
            </div>
            <div className="set-chips">
              <Button className="active" onClick={add}>save period</Button>
              <Button onClick={() => { setAdding(false); setWhy(null); }}>cancel</Button>
            </div>
          </div>
        )}
        {why && <div className="set-warn">{why}</div>}
      </SetCustom>
    </>
  );
}
