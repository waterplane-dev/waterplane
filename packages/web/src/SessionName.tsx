/**
 * **What the desktop called this conversation, on a row that picks a session.**
 *
 * The host derives a ≤4-word name per session (`SessionInfo.tabTitle`) and the
 * app shows it in the three places you LOOK at a session: the tab strip, the
 * session header, the launcher row. Every place you CHOOSE one — the send
 * sheet's *Which session?*, the queue's re-aim, Activity's re-aim, the hidden
 * list — drew `s.title` alone, which in a repo with four sessions open is the
 * word `myapp` four times and the answer never. The name is generated already;
 * only the choosing screens were not reading it.
 *
 * Drawn the launcher's way, because it is the same fact: a muted, lighter span
 * beside the title rather than a second line, marked with the sparkle that
 * means *a machine read this and wrote it*, and CLIPPED — a picker row is
 * scanned, and the session's own header is where the name is read whole.
 *
 * Returns null when the host has not derived one. A picker row is never given
 * an invented name, and never an empty span that costs a gap.
 */
import { Sparkles } from "lucide-react";
import { sessionName } from "@waterplane/shared";

export function SessionName({ s }: { s: { tabTitle?: string } }) {
  const name = sessionName(s);
  if (!name) return null;
  return (
    <span className="row-name" title="what the desktop called this conversation">
      <Sparkles size={11} aria-hidden="true" /> {name}
    </span>
  );
}
