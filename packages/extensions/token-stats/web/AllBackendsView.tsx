/**
 * "All backends" — one card per ledger, side by side (`overview.ts`).
 *
 * No cross-backend sum anywhere on this view and no shared axis: each card is
 * its own unit, its own total with the split it is made of, and the last day it
 * was active. A ledger that cannot be read shows its sentence. Tapping a card
 * opens that backend's own tab — the card is a door, not a filter, so it
 * carries no count of its own.
 */
import { fmtCount, fmtExact, type BackendTokensDoc, type LocalUsageDoc, type TokenStatsDoc } from "@waterplane/shared";
import { ledgers } from "@waterplane/sdk";
import { useRemoteResource, Button } from "@waterplane/kit";
import { runnerCardLines } from "./localRunner.ts";
import { KindBars, NumRow } from "./LedgerParts.tsx";
import { claudeCard, guestCard, lastDayWords, ledgerCard, type OverviewCard } from "./overview.ts";
import type { GuestLedger } from "./guests.ts";

const KIND_NAME: Record<string, string> = {
  input: "input", output: "output", reasoning: "reasoning", cacheRead: "cache read", cacheWrite: "cache write",
};

const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A card's head: the backend's name and its door. `.section` gives it the
 *  padding and the band that separates one card from the next. */
function Head({ label, onOpen }: { label: string; onOpen?: () => void }) {
  return (
    <div className="section section-head">
      <span>{label}</span>
      {onOpen && <Button onClick={onOpen}>open</Button>}
    </div>
  );
}

function Card({ c, onOpen }: { c: OverviewCard; onOpen?: () => void }) {
  return (
    <>
      <Head label={c.label} onOpen={onOpen} />
      {c.scope && <div className="empty ts-caveat">{c.scope}</div>}
      {c.absent ? (
        <div className="empty ts-caveat">{c.absent}</div>
      ) : (
        <>
          {c.total != null && c.rows && (
            <>
              <div className="ts-hero-wrap">
                <div className="ts-hero" title={`${fmtExact(c.total)} ${c.unit}`}>{fmtCount(c.total)}</div>
                <div className="ts-hero-sub">
                  {c.unit}{c.turns != null ? ` over ${c.turns.toLocaleString()} turns` : ""}, in {c.label}’s own kinds — of which:
                </div>
              </div>
              <KindBars rows={c.rows} name={(k) => KIND_NAME[k] ?? k} />
            </>
          )}
          {c.billed && (
            <NumRow label={c.billed.name} value={fmtCount(c.billed.total)} subs={[`the unit ${c.label} is billed in, not tokens`]} />
          )}
          <div className="empty ts-foot">{lastDayWords(c.lastDay, fmtDay)}</div>
        </>
      )}
    </>
  );
}

function LedgerCard({ id, label, online, fresh, onOpen }: { id: string; label: string; online: boolean; fresh: number; onOpen: () => void }) {
  const res = useRemoteResource<BackendTokensDoc>(
    `backendtokens:${id}:${fresh}`,
    () => ledgers.backendTokens(id, fresh > 0),
    { offline: !online },
  );
  const card = res.data
    ? ledgerCard(id, label, res.data)
    : { id, label, unit: "tokens", absent: res.state === "offline" ? `${label}’s ledger cannot be read while the desktop is out of reach.` : res.state === "error" ? `${label}’s ledger did not answer${res.error ? `: ${res.error}` : ""}.` : `Reading ${label}’s ledger…` };
  return <Card c={card} onOpen={onOpen} />;
}

/**
 * The local runner's card: not a backend's ledger but what the RUNNER did,
 * whichever backend asked — so it says so, carries no token total to set beside
 * the others, and lists per model the busy time and tokens WITH their splits.
 */
function RunnerCard({ doc, onOpen }: { doc: LocalUsageDoc | null; onOpen: () => void }) {
  const c = runnerCardLines(doc);
  return (
    <>
      <Head label="Local runner" onOpen={onOpen} />
      <div className="empty ts-caveat">What ollama itself did, per model — compute time, tokens and memory, whichever backend asked. Overlaps the cards above; never add it to them.</div>
      {c.absent ? <div className="empty ts-caveat">{c.absent}</div> : (
        <>
          {(c.lines ?? []).map((l) => <div key={l} className="empty ts-caveat">{l}</div>)}
          <div className="empty ts-foot">{lastDayWords(c.lastDay, fmtDay)}</div>
        </>
      )}
    </>
  );
}

export function AllBackendsView({ claude, claudeScope, guests = [], shownIds = [], ledgerTabs, online, fresh, onOpen, runner, runnerTab }: {
  /** Claude's document — the Anthropic-only cut where local models were taken out. */
  claude: TokenStatsDoc | null;
  claudeScope?: string;
  /** The ledgers other extensions draw (`LedgerViewDef`): a card each, whether or not it has a tab. */
  guests?: readonly GuestLedger[];
  /** Which of them have a tab; a card without one still says why, with no door. */
  shownIds?: readonly string[];
  ledgerTabs: { id: string; label: string }[];
  online: boolean;
  fresh: number;
  /** Open one backend's own tab: "claude", a guest's id, or a ledger tab id. */
  onOpen: (id: string) => void;
  /** The local runner's ledger; undefined = no card (no runner seen, or an older host). */
  runner?: LocalUsageDoc | null;
  runnerTab?: string;
}) {
  return (
    <div className="list ts-list">
      <div className="empty ts-caveat">
        One card per backend, each in its own unit and its own kinds. They are different accounting, so
        there is no total across them and no shared scale.
      </div>
      <Card c={claudeCard(claude, claudeScope)} onOpen={() => onOpen("claude")} />
      {guests.map((g) => (
        <Card key={g.def.id} c={guestCard(g.def.id, g.def.label, g.def.summary(g.doc ?? null))}
          onOpen={shownIds.includes(g.def.id) ? () => onOpen(g.def.id) : undefined} />
      ))}
      {ledgerTabs.map((t) => (
        <LedgerCard key={t.id} id={t.id} label={t.label} online={online} fresh={fresh} onOpen={() => onOpen(t.id)} />
      ))}
      {runner !== undefined && runnerTab && <RunnerCard doc={runner} onOpen={() => onOpen(runnerTab)} />}
    </div>
  );
}
