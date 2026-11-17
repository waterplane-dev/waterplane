/**
 * The probe's question pool: the committed file's shape, the seeded draw and the
 * interleaved order the runner asks in. Pure.
 */
import { sharedRel } from "../brand.js";
import type { ProbeArm, ProbePool, ProbeQuestion } from "../wire/probe.js";

/** Where a repo keeps its pool, relative to its root. Committed; the runner strips it from the scratch worktree. */
export const PROBE_POOL_PATH = sharedRel("probe.json");
/** Questions drawn per comparison (both arms get the same draw). */
export const PROBE_DRAW = 20;
/** Repeats per arm by default: 3 resolves about ±8% on tokens at 20 paired questions (pilot, 2026-11-14). */
export const PROBE_REPEATS = 3;
export const PROBE_MAX_REPEATS = 5;
/** The turn cap: a run that hits it is scored wrong. */
export const PROBE_MAX_TURNS = 12;
/** A pool smaller than this draws everything and says the comparison is weaker. */
export const PROBE_MIN_POOL = 10;

/** The line a repo with no pool shows. */
export function probeNoPoolText(): string {
  return `This repo has no probe questions. Add ${PROBE_POOL_PATH} with lookup questions whose answers are known (each with the patterns an answer must match and an owner who keeps them true), then a probe can run here.`;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * Read a pool file's parsed JSON. Refuses the whole file in words on any bad question, rather than
 * running a pool with a hole in it: a pattern that does not compile would score every answer wrong.
 */
export function parseProbePool(raw: unknown): { pool: ProbePool } | { refused: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { refused: `${PROBE_POOL_PATH} is not a JSON object.` };
  const r = raw as Record<string, unknown>;
  const owner = typeof r.owner === "string" ? r.owner.trim() : "";
  if (!owner) return { refused: `${PROBE_POOL_PATH} has no "owner": say who keeps the answers true, since a stale answer reads as a worse setup.` };
  if (!Array.isArray(r.questions) || r.questions.length === 0) return { refused: `${PROBE_POOL_PATH} has no "questions".` };
  const seen = new Set<string>();
  const questions: ProbeQuestion[] = [];
  for (const [i, q] of r.questions.entries()) {
    const at = `question ${i + 1}`;
    if (!q || typeof q !== "object") return { refused: `${PROBE_POOL_PATH}: ${at} is not an object.` };
    const o = q as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return { refused: `${PROBE_POOL_PATH}: ${at} has no usable "id".` };
    if (seen.has(o.id)) return { refused: `${PROBE_POOL_PATH}: the id ${o.id} is used twice.` };
    seen.add(o.id);
    if (typeof o.q !== "string" || !o.q.trim()) return { refused: `${PROBE_POOL_PATH}: ${o.id} has no question ("q").` };
    if (!Array.isArray(o.all) || o.all.length === 0 || !o.all.every((p) => typeof p === "string" && p.length > 0)) {
      return { refused: `${PROBE_POOL_PATH}: ${o.id} has no answer patterns ("all").` };
    }
    for (const p of o.all as string[]) {
      try { new RegExp(p, "i"); } catch { return { refused: `${PROBE_POOL_PATH}: ${o.id}'s pattern ${JSON.stringify(p)} does not compile.` }; }
    }
    questions.push({
      id: o.id, q: o.q.trim(), all: [...(o.all as string[])],
      ...(typeof o.kind === "string" && o.kind ? { kind: o.kind } : {}),
      ...(typeof o.key === "string" && o.key ? { key: o.key } : {}),
    });
  }
  return { pool: { owner, questions } };
}

/** mulberry32: a small seeded generator, the same draw on every desktop for the same seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` question ids drawn from the pool with `seed` (Fisher-Yates over the pool's order). */
export function drawProbeQuestions(pool: ProbePool, seed: number, n = PROBE_DRAW): string[] {
  const ids = pool.questions.map((q) => q.id);
  const rnd = seededRandom(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids.slice(0, Math.min(n, ids.length));
}

/** One ask in the run order. */
export interface ProbeStep { readonly id: string; readonly arm: string; readonly model: string; readonly rep: number }

/**
 * The order the runner asks in: question by question, each repeat, the arms INTERLEAVED and their
 * order rotated per question and repeat (A1 B1, B2 A2, …), so neither arm always meets the cold cache.
 */
export function probeSchedule(questions: readonly string[], arms: readonly ProbeArm[], repeats: number): ProbeStep[] {
  const out: ProbeStep[] = [];
  if (arms.length === 0) return out;
  questions.forEach((id, qi) => {
    for (let rep = 1; rep <= repeats; rep++) {
      const k = (qi + rep - 1) % arms.length;
      for (const a of [...arms.slice(k), ...arms.slice(0, k)]) out.push({ id, arm: a.arm, model: a.model, rep });
    }
  });
  return out;
}

/** The last `ANSWER:` line of a reply, or "". */
export function probeFinalAnswer(text: string): string {
  // Line by line, no `.*$` scan: the same answer as /ANSWER:(.*)$/gim's last match (the text after
  // the first `ANSWER:` on the last line holding one), with nothing for a ReDoS scanner to flag.
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const m = /ANSWER:/i.exec(line);
    if (m) return line.slice(m.index + m[0].length).trim();
  }
  return "";
}

/** Every pattern matches the final answer line. A cap hit or no answer line is wrong. */
export function probeCorrect(final: string, all: readonly string[], capHit = false): boolean {
  if (capHit || !final) return false;
  return all.every((p) => { try { return new RegExp(p, "i").test(final); } catch { return false; } });
}
