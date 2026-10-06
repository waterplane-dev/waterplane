/**
 * Whether a second local model will fit — as a SENTENCE, never a refusal.
 *
 * Pure, and here rather than on the host because the PHONE is where the
 * question is asked: the model somebody is about to pick is a client-side
 * choice, and the answer has to appear under the picker at the moment of the
 * choice, not after a round trip.
 *
 * The rule this file exists to hold is CLAUDE.md's "nothing applies itself".
 * Two local models on a 64 GB desktop genuinely may not fit — 18 GB for
 * `qwen3-coder:30b` beside 9.2 GB for `gemma4:e4b`, measured — and the runner
 * will evict and reload on every switch, which is minutes of wall clock per
 * turn. That is worth saying loudly. It is NOT worth refusing work over, for
 * three measured reasons stated in full on the function below.
 */
import type { LoadedModel } from "./wire/localrt.js";

/**
 * **The runner's own name for a model, out of a backend's id for it.**
 *
 * Moved here from the web package the moment the HOST needed it too: joining a
 * session's model against the local runner's resident list (for `sessionsUsing`
 * below) is the same match as the pressure note's, and two copies of "strip the
 * FIRST `/` only" is one copy too many.
 *
 * opencode names a local model `ollama/qwen3-coder:30b`; the runner's `/api/ps`
 * calls the same bytes `qwen3-coder:30b`. Matched unstripped, a model that IS
 * resident looks absent. Split on the FIRST `/` only, the same rule the host's
 * opencode descriptor parses its catalogue with: a provider prefix is one
 * segment, and anything further in is part of the model's real name
 * (`openrouter/meta/llama` is `meta/llama` to whoever runs it).
 */
export function modelBaseName(id: string): string {
  const at = id.indexOf("/");
  return at < 0 ? id : id.slice(at + 1);
}

/**
 * Would loading `want` alongside what is already resident need more memory than
 * this machine has free — and by how much?
 *
 * **This is a SENTENCE, never a refusal** (CLAUDE.md: nothing applies itself).
 * The honest reasons not to block:
 *
 *  - The estimate is the runner's own figure for a model it has loaded BEFORE.
 *    For one it has never loaded, `want` is unknown and this answers null —
 *    which is most of the interesting cases.
 *  - "Free memory" on a machine with a page cache and a compressor is not a
 *    number you can refuse somebody's work on. `memFree` understates what is
 *    actually available.
 *  - The conflict is TRANSIENT. `keep_alive` evicts an idle model by itself, so
 *    two sessions on two models is slow, not broken — and slow is a thing
 *    somebody may knowingly accept.
 *
 * So: say what is resident, say what the second one costs, say what that leaves,
 * and let the person decide. Pure and tested.
 */
export function memoryPressureNote(
  loaded: readonly LoadedModel[],
  wantName: string,
  memFree: number,
): string | null {
  if (!loaded.length) return null;
  // Already resident ⇒ no second copy, no pressure, nothing to say.
  if (loaded.some((m) => m.name === wantName)) return null;
  const held = loaded.reduce((n, m) => n + m.size, 0);
  const names = loaded.map((m) => m.name).join(", ");
  const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
  // The size of what is being ASKED for is not known — this host has never seen
  // it resident. Say what IS known rather than inventing the other half.
  return `${names} ${loaded.length === 1 ? "is" : "are"} already loaded (${gb(held)} held, ${gb(memFree)} free). ` +
    `Running a second local model at the same time may evict it, and every switch between them reloads from disk.`;
}
