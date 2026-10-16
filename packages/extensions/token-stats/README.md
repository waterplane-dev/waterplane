# token-stats — the token statistics screen

The all-sessions token ledger sheet: every token this desktop has used, per day, by model and by
repo (two ledgers, never one number), the live `/usage` windows with their history, insights and
$/request. Web only — the host's `tokenstats.ts` and the `usage.status` store stay core
(`features/tokens`). The numbers rules are `web-numbers`'.

Layers, import rule (`@waterplane/sdk`, `@waterplane/kit`, `@waterplane/shared`, react, lucide-react, this folder),
the 900-line cap and the cut order: [token-stats-architecture.md](../../../docs/notes/token-stats-architecture.md).

- `web/index.ts` — manifest `token-stats`; declares the core sheet id `tokens` (persisted).
- `web/TokensSheet.tsx` — wires the viewer to the core: `world.usage`, `ledgers.refreshUsage`, and the
  costliest-conversations doors (`explainConvoCost`: track `action:tokens.explainCost`).
- `web/TokenStatsSheet.tsx` — the viewer; reads through `ledgers.*` (sdk) only.
- `web/{TokenInsights,PerRequestSection}.tsx`, `web/{usageCut,perRequest,statsInsights}.ts` and their tests.
- **Contributed tabs** — another extension's ledger, drawn by that extension: it lists a
  `LedgerViewDef` in its manifest's `ledgerViews` (`@waterplane/sdk`: id = backend id, label,
  `hasData`, `summary` for the "All backends" card, `rescanTitle`, `cache` shape + `usable`, and the
  `View`). This sheet reads `GET /api/tokenstats/<id>` for each (`TokenStatsSheet.tsx`'s `GuestRead`,
  cached under the id by `ledgers.viewDoc`), draws the chip only when `hasData`, the card always, and
  hands the view its own widgets (`LedgerViewParts`: `DayChart`, `ScopeCard`, `ScopeTag`) plus the
  shared chart/values switch. `web/guests.ts` is the picker rule and Claude's scope sentence. A backend
  with a view gets no generic ledger tab. With no such extension installed the sheet is unchanged.
- **Generic ledger tabs** (`web/BackendLedgerView.tsx` + `backendLedger.ts`) — every other backend
  (Copilot, Codex, a local model…), drawn in the Claude Code tab's grammar from its own pieces: the
  account's quota first when the source has a reading (`SourceWindows`, its history on Claude's
  `UsageSpark`), hero + split, the shared chart/values switch, `DayChart` columns per day for tokens
  and the billing unit with the 7-day mean, models as split bars. A launcher-chip tap on a source
  lands on its own view — guest, ledger tab or reading chip (`sourceWords.ts`'s `openedTarget`).
- `web/localSplit.ts` — the Claude Code tab's Anthropic-only cut of the ledger (local models are on
  the claude-local tab, a host-side cut of the same buckets); `web/overview.ts` + `AllBackendsView.tsx`
  — the "All backends" cards, one unit each, never summed. Why and the price file:
  [token-stats-architecture.md](../../../docs/notes/token-stats-architecture.md#local-models-all-backends-and-your-own-prices).
