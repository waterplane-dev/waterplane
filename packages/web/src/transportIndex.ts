/**
 * What is in a repo's transport dirs, so the reader can resolve a file named
 * without its path.
 *
 * The reader recognises `.claude/outbox/x.gif` on sight — that is a regex over
 * the text and costs nothing (`fileRefs.ts`). A bare `x.gif` in backticks is a
 * different question: it is a file reference only if that file EXISTS, and the
 * only thing that knows is the host. So this is the listing, read once per repo
 * while the reader is open, and handed to the renderer as `FileRefCtx.known`.
 *
 * Deliberately NOT cached to disk. Every other listing in this app is, because
 * a stale listing labelled stale beats an empty screen — but nothing here is
 * ever shown to a person. A miss costs one code span staying a code span, which
 * is what it was before this existed, and a cached listing from last week would
 * instead turn a name into a thumbnail of a file that is no longer there. The
 * offline answer is "resolve nothing", stated once, here.
 */
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";

/** Both directions: a prompt names what the phone uploaded, a report names what
 *  the agent wrote back, and a reader shows both halves of that conversation. */
async function listTransport(repoId: string): Promise<string[]> {
  const [outbox, inbox] = await Promise.all([
    api.artifacts(repoId, "outbox").then((d) => d.files).catch(() => []),
    api.inbox(repoId).catch(() => []),
  ]);
  return [...outbox, ...inbox].map((f) => f.relPath).filter(Boolean);
}

/**
 * @param repoId  The repo the text belongs to; null while there isn't one.
 * @param enabled Read only when something is actually going to render these —
 *                the reader being on screen. A listing per repo per terminal
 *                session would be a request nobody asked for.
 */
export function useTransportIndex(repoId: string | null, enabled: boolean): readonly string[] | undefined {
  const res = useRemoteResource<string[]>(
    repoId ?? "",
    () => listTransport(repoId as string),
    { enabled: enabled && !!repoId },
  );
  return res.data ?? undefined;
}
