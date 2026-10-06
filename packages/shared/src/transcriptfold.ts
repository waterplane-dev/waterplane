/**
 * The caps and the two pure folds every conversation reader shares — claude's
 * jsonl reader (`host/transcript.ts`, `host/ctxlog.ts`) and any backend's store
 * reader a plugin contributes (`HostPluginApi.storeReader`).
 *
 * Here and not in the host because a store reader lives in an extension, which
 * reaches core only through `@waterplane/shared`: the reader view and the
 * context graph must cap, label and thin a second backend's conversation by the
 * SAME rule as claude's, and two copies of a cap are two opinions about how long
 * a turn may be. Moved verbatim from the host; the host re-exports every name.
 */
import type { ContextSample } from "./wire/session.js";
import type { TranscriptBlock } from "./wire/transcript.js";

/** Newest N turns are returned; older ones are dropped (with `truncated`). */
export const MAX_TURNS = 500;
export const TOOL_INPUT_CAP = 1200;
export const TOOL_RESULT_CAP = 4000;
export const TEXT_CAP = 200_000;
/** A row label's length, in characters. */
export const LABEL_CAP = 160;

/**
 * Context-series points returned at most.
 *
 * A 20 MB conversation measured 1,365 distinct turns, so the cap is not the
 * common case — it is the bound that keeps this response small enough to cache
 * on a phone whatever the log does next.
 */
export const MAX_SAMPLES = 1200;

/** Whitespace squashed to single spaces, capped with an ellipsis. */
export const oneLine = (s: string, cap = LABEL_CAP): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
};

/** One-line form of a prompt, for a row label. */
export function promptLabel(text: string, cap?: number): string {
  return oneLine(text, cap);
}

/**
 * A turn's gist WITHOUT an AI call: the first sentence of its last substantive
 * assistant text, markdown stripped. Deliberately dumb and instant — the point
 * of the outline is to skim a long conversation, not to re-summarize it.
 */
export function summarize(blocks: TranscriptBlock[]): string | undefined {
  const texts = blocks.filter((b): b is Extract<TranscriptBlock, { kind: "text" }> => b.kind === "text");
  for (let i = texts.length - 1; i >= 0; i--) {
    const plain = texts[i].text
      .replace(/```[\s\S]*?```/g, " ")        // fenced code says nothing useful here
      .replace(/^\s{0,3}#{1,6}\s*/gm, "")     // heading markers
      .replace(/[*_`>]/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
      .trim();
    if (!plain) continue;
    const sentence = /^[\s\S]{0,240}?[.!?](\s|$)/.exec(plain)?.[0] ?? plain;
    const line = oneLine(sentence, 200);
    if (line) return line;
  }
  return undefined;
}

/**
 * Cut a long series down to the cap WITHOUT flattening it.
 *
 * A stride sample ("every 3rd point") is the obvious way and the wrong one
 * here: the shape this graph is about is a sawtooth, and the two points that
 * carry the whole story of each tooth — the peak just before a compaction and
 * the floor just after — are exactly the ones a stride is most likely to step
 * over. So each bucket contributes its highest and its lowest reading, emitted
 * in the order they occurred, which preserves the envelope and the direction of
 * every drop while still bounding the count.
 */
export function downsample(samples: ContextSample[], cap = MAX_SAMPLES): ContextSample[] {
  if (samples.length <= cap) return samples;
  const buckets = Math.max(1, Math.floor(cap / 2));
  const per = samples.length / buckets;
  const out: ContextSample[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.floor((b + 1) * per));
    if (to <= from) continue;
    let lo = samples[from];
    let hi = samples[from];
    for (let i = from + 1; i < to; i++) {
      if (samples[i].tok < lo.tok) lo = samples[i];
      if (samples[i].tok > hi.tok) hi = samples[i];
    }
    if (lo === hi) out.push(lo);
    else if (lo.t <= hi.t) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}
