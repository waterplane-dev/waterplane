/**
 * Failed-password guard for `POST /api/auth/login` (the LAN password gate, `auth.ts`).
 *
 * `ratelimit.ts` caps how FAST a source may ask; this caps how often it may be WRONG.
 * Per source address: the first FREE_FAILS wrong guesses cost nothing (a typo), each
 * one after that doubles a wait (2 s, 4 s … up to MAX_WAIT_MS), and LOCK_AT wrong
 * guesses in a row lock that source for LOCK_MS. A correct password clears the source.
 *
 * It applies to every source the gate makes present a password (`guarded`): lan/other,
 * and Tailscale when the gate is on for it (`auth.needsToken("tailscale")`: the toggle,
 * or a paired passive device). Loopback, and an ungated Tailscale caller, are never
 * delayed or locked. A source's failures are keyed by its own address, so one attacker
 * can lock only itself, never the owner's loopback path.
 * Memory only: a restart forgets it (the same trade as `ratelimit.ts`).
 */
import type { PeerKind } from "./net.js";

export const FREE_FAILS = 3;
export const BASE_WAIT_MS = 2000;
export const MAX_WAIT_MS = 5 * 60_000;
export const LOCK_AT = 10;
export const LOCK_MS = 15 * 60_000;
/** An idle source is forgotten after this long. */
const FORGET_MS = 60 * 60_000;
const MAX_KEYS = 500;
/** How long a failure counts in the reading (a duration, not a calendar day). */
const FAIL_MEMORY_MS = 12 * 60 * 60_000;

interface Entry { fails: number; until: number; last: number; locked: boolean }

export interface GuardVerdict { allowed: boolean; retryAfterMs: number; locked: boolean }
export interface GuardReading { lockedNow: number; waitingNow: number; recentFailures: number; lastFailureAt: number | null }

/** A source is guarded when the gate demands a password from it: `tokenNeeded` is `auth.needsToken(kind)`. Loopback never is. */
export function guarded(kind: PeerKind, tokenNeeded: boolean): boolean {
  return kind !== "loopback" && tokenNeeded;
}

export class LoginGuard {
  private entries = new Map<string, Entry>();
  private failTimes: number[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}

  check(key: string, now = Date.now()): GuardVerdict {
    const e = this.entries.get(key);
    if (!e || e.until <= now) return { allowed: true, retryAfterMs: 0, locked: false };
    return { allowed: false, retryAfterMs: e.until - now, locked: e.locked };
  }

  fail(key: string, now = Date.now()): GuardVerdict {
    this.sweep(now);
    const e = this.entries.get(key) ?? { fails: 0, until: 0, last: now, locked: false };
    // A lock that ran out starts the count over from the edge of the free tries.
    if (e.locked && e.until <= now) { e.fails = FREE_FAILS; e.locked = false; }
    e.fails += 1;
    e.last = now;
    this.failTimes.push(now);
    if (e.fails >= LOCK_AT) {
      e.locked = true;
      e.until = now + LOCK_MS;
      this.log(`login guard: ${key} locked for ${LOCK_MS / 60_000} min after ${e.fails} wrong passwords`);
    } else if (e.fails > FREE_FAILS) {
      e.until = now + Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** (e.fails - FREE_FAILS - 1));
      this.log(`login guard: ${key} wrong password #${e.fails}, waits ${Math.round((e.until - now) / 1000)} s`);
    }
    this.entries.set(key, e);
    return this.check(key, now);
  }

  /**
   * One guarded guess. `check` alone at the headers is check-then-act across the body
   * read: a source that parks many requests passes them all before the first failure is
   * counted. So the verdict is re-read here, synchronously with `verify` and the count,
   * after the body has arrived. A refused guess is never verified.
   */
  attempt(key: string, verify: () => boolean, now = Date.now()): { verdict: GuardVerdict; ok: boolean; refused: boolean } {
    const v = this.check(key, now);
    if (!v.allowed) return { verdict: v, ok: false, refused: true };
    if (verify()) { this.success(key); return { verdict: v, ok: true, refused: false }; }
    return { verdict: this.fail(key, now), ok: false, refused: false };
  }

  success(key: string): void { this.entries.delete(key); }

  /** What the phone may show a trusted caller: counts only, never an address. */
  reading(now = Date.now()): GuardReading {
    this.sweep(now);
    let lockedNow = 0, waitingNow = 0;
    for (const e of this.entries.values()) if (e.until > now) { if (e.locked) lockedNow++; else waitingNow++; }
    const day = this.failTimes.filter((t) => t > now - FAIL_MEMORY_MS);
    return { lockedNow, waitingNow, recentFailures: day.length, lastFailureAt: day.length ? day[day.length - 1] : null };
  }

  private sweep(now: number): void {
    this.failTimes = this.failTimes.filter((t) => t > now - FAIL_MEMORY_MS).slice(-1000);
    for (const [k, e] of this.entries) if (e.until <= now && e.last < now - FORGET_MS) this.entries.delete(k);
    while (this.entries.size >= MAX_KEYS) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
  }
}
