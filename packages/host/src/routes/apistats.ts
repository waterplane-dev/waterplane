/**
 * HTTP reads of what this desktop has spent: the token ledger off the CLI's
 * logs, each backend's own ledger, the local runner's, the same ledger folded
 * into past rate-limit windows, and the `/usage` readings this daemon took.
 * Separate documents on purpose — never summed, never merged. Moved out of
 * `api.ts` (host-architecture.md, "api.ts — the HTTP routes as tables").
 */
import type { BackendTokensDoc } from "@waterplane/shared";
import { hostStoreDir } from "../hoststore.js";
import { BACKENDS, backendInfos, storeReaderFor } from "../backends/index.js";
import { localUsageDoc } from "../localusage.js";
import { localSliceLedger, modelOwner, readUserPrices, rememberCatalogues } from "../localledger.js";
import { json } from "./apiio.js";
import { route, type ApiEntry } from "./apitable.js";

/**
 * How stale a backend's own ledger may be before `/api/tokenstats/<id>` asks
 * it again — opencode's store ledger's TTL, so the two answer a re-opened
 * screen on the same clock. `?fresh=1` passes 0.
 */
const BACKEND_LEDGER_MAX_AGE_MS = 15_000;

export const STATS_ROUTES: readonly ApiEntry[] = [
  // Token usage across every conversation log on disk — the statistics screen.
  // Read-only, derived, and cached behind a per-file cursor (`tokenstats.ts`):
  // a warm call is a 35 ms stat sweep, a cold one a few seconds. HTTP rather
  // than the socket for the same reason as the transcript: it is a document
  // somebody asked for, not a fact that arrives.
  route("GET", "/api/tokenstats", async ({ res, url }, ctx) => {
    // `fresh=1` is the sheet's re-read button: skip the "scanned recently
    // enough" shortcut and actually walk the directories again.
    const maxAge = url.searchParams.get("fresh") === "1" ? 0 : undefined;
    json(res, await ctx.tokenStats.read(maxAge));
    return true;
  }),

  // A SECOND ledger: what another backend spent on this desktop (opencode's, out
  // of its store reader). Its own route and its own document because the two are different accounting
  // for the same word — different cache tiers, a fifth token kind, and an
  // account limit that exists for one and not the other — so they are never
  // summed and never merged into one response. Same read-only posture as the
  // route above: `fresh=1` is the same re-read button, and EVERY failure
  // (no store, a Node with no SQLite, schema drift, a busy database) comes back
  // as `available: false` with a sentence at 200. A 500 here would paint a red
  // error on the statistics screen of somebody who has simply never run
  // opencode, which is the normal case.
  //
  // `/api/tokenstats/<backendId>` is the same route for EVERY backend (design
  // §2): a backend whose descriptor hands over a `sources.tokens` ledger answers
  // from it (`BackendTokensDoc`, in its own unit); one without, whose
  // `caps.transcript` names a contributed store reader with a `ledger`, answers
  // that reader's document verbatim (opencode's `OcTokenStatsDoc`). Same
  // posture throughout — a ledger that cannot be read is `available: false` with
  // a sentence at 200, never a 500 and never a zero; an id this host does not
  // know is a 404 that names the ones it does.
  // The LOCAL runner's own ledger (`localusage.ts`): compute time, tokens and
  // memory per model per day, off ollama's server log and `/api/ps`. A third
  // document beside the two token ledgers, never merged with either — it counts
  // what the RUNNER did, whichever client asked. In memory, so no `fresh`;
  // switched off or not started is `available: false` with a sentence at 200.
  route("GET", "/api/localusage", ({ res }) => {
    json(res, localUsageDoc());
    return true;
  }),

  // `:id/*`, not `*`: one segment at least, so the bare `/api/tokenstats` above
  // is never this route's — the old `startsWith("/api/tokenstats/")`.
  route("GET", "/api/tokenstats/:id/*", async ({ res, url, path }, ctx) => {
    const id = decodeURIComponent(path.slice("/api/tokenstats/".length));
    const fresh = url.searchParams.get("fresh") === "1";
    const backend = BACKENDS.find((b) => b.id === id);
    if (!backend) {
      json(res, { error: `no backend called "${id}"; this host has: ${BACKENDS.map((b) => b.id).join(", ")}` }, 404);
      return true;
    }
    const tokens = backend.sources?.tokens;
    if (tokens) {
      let doc: BackendTokensDoc;
      try { doc = await tokens.ledger(fresh ? 0 : BACKEND_LEDGER_MAX_AGE_MS); }
      catch (e) { doc = { available: false, reason: `the ${backend.label} ledger could not be read: ${(e as Error)?.message || String(e)}` }; }
      json(res, doc);
      return true;
    }
    const store = storeReaderFor(backend.caps);
    if (store?.ledger) {
      let doc: unknown;
      try { doc = await store.ledger(fresh ? 0 : undefined); }
      catch (e) { doc = { available: false, reason: `the ${backend.label} ledger could not be read: ${(e as Error)?.message || String(e)}` } satisfies BackendTokensDoc; }
      json(res, doc);
      return true;
    }
    // A claude-jsonl backend that is not claude itself (claude-local, claude-endpoint) writes into
    // CLAUDE's logs, so its ledger is a CUT of that one by model id — the
    // non-Anthropic models — never a second tally (`localSliceLedger`). Priced
    // per model from its catalogue's `zeroCost` and the person's `prices.json`.
    if (backend.caps.transcript === "claude-jsonl" && backend.id !== "claude") {
      let doc: BackendTokensDoc;
      try {
        const all = await ctx.tokenStats.read(fresh ? 0 : undefined);
        const prices = readUserPrices();
        const infos = backendInfos();
        const zero = new Set(infos.find((b) => b.id === backend.id)?.models.zeroCost ?? []);
        // Several backends write into Claude's logs: each tab keeps only the models it owns.
        // A catalogue that is down lists nothing; the remembered one keeps its models on its tab.
        const sharers = rememberCatalogues(hostStoreDir(ctx.root), BACKENDS
          .filter((b) => b.caps.transcript === "claude-jsonl" && b.id !== "claude")
          .map((b) => ({ id: b.id, ids: infos.find((i) => i.id === b.id)?.models.ids ?? [] })));
        const keep = (m: string) => modelOwner(m, sharers) === backend.id;
        doc = localSliceLedger(all, { label: backend.label, prices: prices.table, pricesFile: prices.file, zeroCost: zero, keep });
      } catch (e) {
        doc = { available: false, reason: `Claude Code's logs could not be read for ${backend.label}: ${(e as Error)?.message || String(e)}` };
      }
      json(res, doc);
      return true;
    }
    json(res, {
      available: false,
      reason: backend.caps.transcript === "claude-jsonl"
        ? `${backend.label}'s tokens are the ones /api/tokenstats counts; it keeps no second ledger`
        : `${backend.label} hands this host no ledger of its own`,
    } satisfies BackendTokensDoc);
    return true;
  }),

  // The SAME ledger folded into PAST rate-limit windows — the history behind
  // the two percentages, which `/api/tokenstats` structurally cannot answer: it
  // ships a bounded fortnight of hour buckets, and a weekly window from July is
  // four months back in a record the wire does not carry. The store keeps every
  // hour it ever saw, so the fold happens on this side and what crosses is one
  // small row per window that had anything in it.
  //
  // The GRID is the caller's: `w=<id>:<anchor ms>:<length ms>`, repeated, and
  // echoed back by id. Neither the reset instant nor the length of a window is
  // a fact about a ledger of hours — one is scraped off the CLI's own `/usage`
  // screen and the other is a property of the plan — so this route folds
  // buckets into a grid somebody else defined and asserts nothing about what
  // the grid means.
  route("GET", "/api/tokenwindows", async ({ res, url }, ctx) => {
    const specs = url.searchParams.getAll("w").map((raw) => {
      const [id, anchor, len] = raw.split(":");
      return { id: id || "", anchor: Number(anchor), lenMs: Number(len) };
    }).filter((sp) => sp.id && Number.isFinite(sp.anchor) && sp.lenMs > 0);
    // A malformed or absent grid is an EMPTY answer, not a 400: the screen
    // draws nothing where it has no grid, and an error there would paint a red
    // failure over a chart nobody could have asked for yet.
    const maxAge = url.searchParams.get("fresh") === "1" ? 0 : undefined;
    json(res, await ctx.tokenStats.windowSeries(specs, maxAge));
    return true;
  }),

  // The history behind the two live limit windows. Separate from
  // `/api/tokenstats` on purpose: that document is derived from the CLI's
  // conversation logs and is the same on every phone, while this one is a log
  // of what THIS daemon happened to observe — different provenance, different
  // caveats, and a reader must not be able to confuse the two.
  route("GET", "/api/usagelog", ({ res, url }, ctx) => {
    const hours = Number(url.searchParams.get("hours") || 0);
    const since = Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : undefined;
    json(res, ctx.usageLog.read(since, ctx.usagePollMs));
    return true;
  }),
];
