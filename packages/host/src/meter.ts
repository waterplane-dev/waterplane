/**
 * Lightweight LLM metering — call counting, token tracking, and estimated cost
 * for the API calls waterplane itself makes (plugins, kind `plugin:<id>`). Modeled on the podcast app's pattern, trimmed to a single JSON file:
 *
 *  - One MeterEvent per call: service, model, kind, in/out tokens, cost, ts.
 *  - Token counts come from the provider response (Gemini usageMetadata); cost
 *    from a per-model price table ($/1M tokens).
 *  - Persisted to <STATE_DIR>/usage-meter.json (rolling, capped). Aggregated on
 *    read into all-time + today + per-model totals.
 *
 * Unknown models cost $0 (counted, not priced) rather than guessed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MeterEvent, MeterSummary, MeterModelStat } from "@waterplane/shared";
import { env } from "./env.js";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** Per-1M-token prices (input, output) in USD, matched by model-id prefix. */
const PRICES: { prefix: string; in: number; out: number }[] = [
  { prefix: "gemini-3.5-flash", in: 1.5, out: 9.0 },
  { prefix: "gemini-2.5-pro", in: 1.25, out: 10.0 },
  { prefix: "gemini-2.5-flash-lite", in: 0.075, out: 0.3 },
  { prefix: "gemini-2.5-flash", in: 0.15, out: 3.5 },
  { prefix: "gemini-2.0-flash-lite", in: 0.075, out: 0.3 },
  { prefix: "gemini-2.0-flash", in: 0.1, out: 0.4 },
  { prefix: "gemini-1.5-flash", in: 0.075, out: 0.3 },
  { prefix: "gemini-1.5-pro", in: 1.25, out: 5.0 },
];

/** Estimated USD cost for a call; 0 if the model isn't in the price table. */
export function priceCall(model: string, inTok: number, outTok: number): number {
  const p = PRICES.find((x) => model.startsWith(x.prefix));
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

const MAX_EVENTS = 5000; // rolling cap; summary is what matters, not deep history

export class Meter {
  private events: MeterEvent[] = [];
  private path: string;
  /** Off switch: WATERPLANE_METER=0 makes record() a no-op (existing history still readable). */
  readonly enabled = env("METER") !== "0";

  constructor(root: string, private onChange?: (s: MeterSummary) => void) {
    this.path = join(hostStateDir(root), "usage-meter.json");
    try {
      if (existsSync(this.path)) {
        const data = readJsonGuarded<any>(this.path, null);
        if (Array.isArray(data?.events)) this.events = data.events;
      }
    } catch { /* start empty */ }
  }

  /** Record one call. Cost is computed from the price table. */
  record(e: { service: string; model: string; kind: string; inTok: number; outTok: number; ts: number }): void {
    if (!this.enabled) return;
    const ev: MeterEvent = {
      ts: e.ts,
      service: e.service,
      model: e.model,
      kind: e.kind,
      inTok: Math.max(0, e.inTok | 0),
      outTok: Math.max(0, e.outTok | 0),
      costUsd: priceCall(e.model, e.inTok, e.outTok),
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.save();
    this.onChange?.(this.summary());
  }

  /** All-time + today + per-model rollup. `now` is injected so callers control the clock. */
  summary(now = Date.now()): MeterSummary {
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const dayMs = startOfDay.getTime();

    const total = { calls: 0, inTok: 0, outTok: 0, costUsd: 0 };
    const today = { calls: 0, inTok: 0, outTok: 0, costUsd: 0 };
    const models = new Map<string, MeterModelStat>();
    let lastAt = 0;

    for (const ev of this.events) {
      total.calls++; total.inTok += ev.inTok; total.outTok += ev.outTok; total.costUsd += ev.costUsd;
      if (ev.ts >= dayMs) { today.calls++; today.inTok += ev.inTok; today.outTok += ev.outTok; today.costUsd += ev.costUsd; }
      if (ev.ts > lastAt) lastAt = ev.ts;
      let m = models.get(ev.model);
      if (!m) { m = { model: ev.model, calls: 0, inTok: 0, outTok: 0, costUsd: 0 }; models.set(ev.model, m); }
      m.calls++; m.inTok += ev.inTok; m.outTok += ev.outTok; m.costUsd += ev.costUsd;
    }

    return {
      ...total,
      today,
      byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
      lastAt,
    };
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, { events: this.events }, { space: 2 });
    } catch { /* non-fatal */ }
  }
}
