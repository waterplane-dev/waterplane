/**
 * A token bucket per key (normally the remote IP), for the few endpoints that
 * answer BEFORE the auth gate: `POST /api/lan/verify` today, pairing redeem
 * next. Those are reachable by anything on the Wi-Fi, so each one is a place a
 * peer can spend the host's CPU (an HMAC, a hash compare) or guess at a secret
 * as fast as it can send; a bucket turns "as fast as it can send" into a small
 * fixed rate.
 *
 * Memory only, on purpose: a restart forgets the buckets, which lets a
 * throttled peer have one fresh burst — cheaper than a file written on every
 * probe. The map is pruned of full buckets so a scan across many source
 * addresses cannot grow it for ever.
 */
import type { IncomingMessage } from "node:http";

export interface RateLimitOpts {
  /** Most requests one key may make in a burst. */
  burst: number;
  /** Requests per second refilled. */
  perSec: number;
  /** Past this many keys the map is pruned of full buckets. Default 1000. */
  maxKeys?: number;
}

interface Bucket { tokens: number; at: number }

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  constructor(private readonly opts: RateLimitOpts) {
    this.maxKeys = opts.maxKeys ?? 1000;
  }

  private fill(key: string, now: number): Bucket {
    const b = this.buckets.get(key) ?? { tokens: this.opts.burst, at: now };
    b.tokens = Math.min(this.opts.burst, b.tokens + Math.max(0, now - b.at) / 1000 * this.opts.perSec);
    b.at = now;
    return b;
  }

  /** Spend one token for `key`. `false` ⇒ refuse the request (429). */
  take(key: string, now = Date.now()): boolean {
    const b = this.fill(key, now);
    if (!this.buckets.has(key)) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      this.buckets.set(key, b);
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** How long until `key` may try again, in ms (0 = now). For `retry-after`. */
  retryAfterMs(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const t = this.fill(key, now).tokens;
    return t >= 1 ? 0 : Math.ceil((1 - t) / this.opts.perSec * 1000);
  }

  /** Drop every bucket that has refilled completely (it carries no memory). */
  prune(now = Date.now()): void {
    for (const [k] of this.buckets) if (this.fill(k, now).tokens >= this.opts.burst) this.buckets.delete(k);
    // Everyone is mid-burst (a real flood): forget the oldest rather than grow.
    while (this.buckets.size >= this.maxKeys) {
      const first = this.buckets.keys().next().value;
      if (first === undefined) break;
      this.buckets.delete(first);
    }
  }

  get size(): number { return this.buckets.size; }
}

/** The key a request is limited by: its remote address, IPv4-mapped prefix
 *  stripped so one peer is one key whichever family the socket reports. */
export function rateKey(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}
