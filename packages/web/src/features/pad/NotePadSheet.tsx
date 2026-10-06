/**
 * The pad, as a sheet: `PadSheet.tsx` with the core's repos, queue and link
 * handed in, files parked through the one attach path, pictures through the
 * annotator's pad round trip (`core().files.annotate(…, "pad")`).
 */
import type { OutboxEntry } from "../../outbox";
import { PadSheet } from "../../PadSheet";
import { useCore, useQueueEntries, useStore } from "../../sdk";
import { padFocus } from "./store";
import { closePad, dispatchNote, fileNote } from "./actions";

export function NotePadSheet() {
  const c = useCore();
  const entries = useQueueEntries();
  const focusId = useStore(padFocus);
  return <PadSheet
    repos={c.world.visibleRepos}
    outbox={entries as OutboxEntry[]} online={c.conn.status === "open"}
    focusId={focusId}
    repoIdForCwd={(cwd) => c.world.repoForCwd(cwd)?.id ?? null}
    onClose={closePad}
    // Files: the pad is target-less, so PadSheet asks which repo's inbox once
    // and hands the answer back here. Parking is the same path every other
    // attach takes — one implementation of "shrink it, queue it, mint the path
    // it will have".
    onAttach={(files, repo) => c.files.attachForInbox(repo, files)}
    onAnnotate={(files, repo) => c.files.annotate(repo, files, "pad")}
    onDispatch={dispatchNote}
    onFile={fileNote}
  />;
}
