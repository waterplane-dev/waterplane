/**
 * How many tokens this desktop has ever used — the statistics screen.
 *
 * ── The one thing this screen must not do ───────────────────────────────────
 *
 * Show a single enormous number and let it be read as money. Measured on the
 * machine this was built against: 13.6 billion tokens, of which 96% are cache
 * reads — the conversation being re-read out of the prompt cache on every turn.
 * A reader who takes the headline for "what I spent" is out by two orders of
 * magnitude. So the hero figure never appears without the composition strip
 * under it, the strip is a part-to-whole with every kind visible however small
 * (`statsPlot`'s `compose`), and `TOKEN_KINDS` supplies a sentence per kind so
 * this file invents no wording of its own.
 *
 * ── Money, and where it is allowed ──────────────────────────────────────────
 *
 * This header used to say there were no prices anywhere on this screen. There
 * are now, on the CLAUDE view only, and the distinction is the whole rule: the
 * *cost* metric is an explicit COUNTERFACTUAL — what this traffic would have
 * cost billed through the API at published pay-as-you-go rates — labelled as
 * one in the caveat under the hero, priced from one dated table
 * (`shared/pricing.ts`), and showing "no list price" rather than a $0 for any
 * model that table does not name.
 *
 * A tab another extension contributes (`LedgerViewDef`, sdk) draws its own
 * document and owns its own money rule; `pricing.ts` is claude's table and is
 * never lent to another vendor's models, so the rule above holds there too —
 * absent rather than a plausible mistake.
 *
 * The one other place money appears is a generic ledger tab whose host doc
 * carries `cost` (claude-local today): priced per model by the backend's own
 * catalogue zero or by the person's `prices.json`, one total per currency, and
 * an unpriced model as a sentence on how to add a price — the same rule again.
 *
 * ── Several sources, never merged ───────────────────────────────────────────
 *
 * The claude ledger (`host/tokenstats.ts`) reads the CLI's conversation logs.
 * Another CLI writes to its own store, and was therefore entirely missing from
 * a screen calling itself *every token this desktop has used*. The answer is a
 * SOURCE PICKER, not a merge: one chip per ledger at the top, each view
 * carrying its own scope sentence, no combined hero, no "all sources" chip and
 * no summed row anywhere. The documents never meet in one reducer.
 *
 * A source other than Claude is CONTRIBUTED: the extension that knows its
 * document's shape registers a ledger view (`FeatureManifest.ledgerViews`),
 * the host answers `GET /api/tokenstats/<id>` from that backend's store reader,
 * and this sheet reads it beside claude's and hands the view its own widgets.
 * A chip is drawn ONLY when its source answered with something in it — one
 * source is furniture implying a decision nobody has (the `showBackendPicker`
 * rule), so a desktop with no such ledger, or no such extension, renders this
 * screen exactly as it did before. It is never greyed out; when the source is
 * absent, the choice is not there.
 *
 * ── Forms ───────────────────────────────────────────────────────────────────
 *
 * Hero figure → cumulative area (the question that was actually asked) → daily
 * columns → composition strip → horizontal bars by model and by repo → a table
 * twin. A contributed view reuses those same forms over its own document.
 *
 * ── Two scope controls, because there are two kinds of window ───────────────
 *
 * The `RANGES` row scopes the two TIME CHARTS and nothing else: those are
 * calendar windows ending at today, and the totals above them stay all-time,
 * because "cumulative over all sessions" is the point and a calendar chip that
 * silently rewrote the hero would defeat it.
 *
 * The SCOPE row under the hero is the other kind: the two live rate-limit
 * windows, which are not calendar anything — a rolling five hours, and a week
 * that resets on a Thursday evening. Those two are the only windows a reader
 * has a live percentage for and no idea what it is a percentage OF, so they
 * are the two the READOUTS restate for: hero, composition, cache verdict,
 * tiles, and the by-model bars. What the cut cannot answer it says so about
 * (`usageCut.ts`) — there are no repo or conversation counts inside an hour
 * bucket, so those sections are ABSENT with a sentence rather than quietly
 * showing an all-time figure under a window heading.
 *
 * Each row is labelled with what it scopes, and one bucketing function
 * (`windowCut`) feeds both the line under the limit bar and the cut the chip
 * takes — a second copy of that edge is how a number and the view it opens
 * start disagreeing.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { BackendInfo, TokenConvo, TokenStatsDoc, UsageInfo, UsageReading } from "@waterplane/shared";
import { ledgers, type LedgerViewDef } from "@waterplane/sdk";
import { useRemoteResource } from "@waterplane/kit";
import { TokenStatsBody, type SpendView } from "./TokenStatsBody.tsx";
import type { GuestLedger } from "./guests.ts";

/** One view's read, as `GuestRead` lifts it into the sheet. */
type GuestReadState = Omit<GuestLedger, "def" | "backend">;

/**
 * One contributed ledger, read on every open whether or not anybody asks for it.
 *
 * It has to be: the ANSWER is what decides whether its chip exists at all, and
 * a chip that appears a second after you look at the screen is worse than one
 * that never appears. A host with no such store answers `available: false` at
 * 200 in microseconds; an older host 404s, which lands as `error` and is
 * treated the same way — by not offering the choice. Cached, so the decision
 * survives a dead tunnel rather than silently removing a source the phone has
 * seen before. A component per view rather than a hook in a loop: the number
 * of views is the registry's, and the read lifts into the sheet's state.
 */
function GuestRead({ def, fresh, online, onRead }: {
  def: LedgerViewDef<any>;
  fresh: number;
  online: boolean;
  onRead: (id: string, r: GuestReadState) => void;
}) {
  const doc = ledgers.viewDoc(def);
  const r = useRemoteResource<unknown>(
    `ledgerview:${def.id}:${fresh}`,
    () => doc.read(fresh > 0),
    { offline: !online, fromCache: doc.fromCache, toCache: doc.toCache },
  );
  useEffect(() => {
    onRead(def.id, { doc: r.data ?? null, res: { state: r.state, age: r.age, error: r.error } });
  }, [def.id, r.data, r.state, r.age, r.error, onRead]);
  return null;
}

export function TokenStatsSheet({ online, ledgerTabs, usage, spend, onRefreshUsage, onClose, nameOf, onExplain, isLive, onOpenConvo, views = [], backends, readings, openedOn, onClearOn, doors }: {
  /** Usage readings per source, and the one the launcher chip opened this sheet on (see `TokenStatsBody`). */
  readings?: readonly UsageReading[];
  openedOn?: string | null;
  /** Doors drawn first in the body — see `TokenStatsBody`. */
  doors?: ReactNode;
  onClearOn?: () => void;
  /** The socket's verdict, not `navigator.onLine` — see `useRemoteResource`. */
  online: boolean;
  /** Backends beyond claude and the contributed views, each a generic ledger tab (`ledgerBackends`). */
  ledgerTabs?: { id: string; label: string }[];
  /** The live rate-limit windows, pushed on every host snapshot. */
  usage: UsageInfo | null;
  /** The billing profile, the budget and its dollar periods (`world.billing` / `world.budget`). */
  spend?: SpendView;
  /** Re-scrape `/usage` on the desktop. `quiet` suppresses the toast, for the
   *  automatic refresh this screen does on open. */
  onRefreshUsage: (quiet?: boolean) => void;
  onClose: () => void;
  /** The ledger views other extensions contribute (`ledgers.views()`). */
  views?: readonly LedgerViewDef<any>[];
  /** The host's backend list, for each view's own entry (its model catalogue). */
  backends?: readonly BackendInfo[] | null;
  /** The costliest-conversations list's doors — see `TokenStatsBody`. */
  nameOf?: (id: string) => string | undefined;
  onExplain?: (c: TokenConvo, title: string) => void;
  isLive?: (id: string) => boolean;
  onOpenConvo?: (id: string) => void;
}) {
  const [fresh, setFresh] = useState(0);
  const res = useRemoteResource<TokenStatsDoc>(
    `tokenstats:${fresh}`,
    () => ledgers.tokenStats.read(fresh > 0),
    {
      offline: !online,
      fromCache: ledgers.tokenStats.fromCache,
      toCache: ledgers.tokenStats.toCache,
    },
  );
  const [reads, setReads] = useState<ReadonlyMap<string, GuestReadState>>(new Map());
  const [onRead] = useState(() => (id: string, r: GuestReadState) =>
    setReads((m) => new Map(m).set(id, r)));
  const guests: GuestLedger[] = views.map((def) => ({
    def, doc: null, ...reads.get(def.id), backend: backends?.find((b) => b.id === def.id),
  }));
  return (
    <div className="sheet">
      {views.map((def) => <GuestRead key={def.id} def={def} fresh={fresh} online={online} onRead={onRead} />)}
      <TokenStatsBody doc={res.data} res={res} guests={guests} usage={usage} spend={spend} online={online}
        onRefreshUsage={onRefreshUsage}
        onClose={onClose} onRescan={() => setFresh((n) => n + 1)}
        nameOf={nameOf} onExplain={onExplain} isLive={isLive} onOpenConvo={onOpenConvo} ledgerTabs={ledgerTabs} fresh={fresh}
        readings={readings} openedOn={openedOn} onClearOn={onClearOn} doors={doors} />
    </div>
  );
}
