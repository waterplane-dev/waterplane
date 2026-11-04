/**
 * "zenbook · 1 waiting" — the launcher bar's mark that ANOTHER of the person's desktops waits on
 * them (a vault approval, a session on a question), beside the host key. Drawn only when
 * `elsewhereChipText` has words (something fresh is waiting, or a desktop signed this phone out).
 * The count is the filter: a tap opens the `elsewhere` sheet on exactly the rows it counted.
 * Never switches by itself.
 */
import { MonitorDot } from "lucide-react";
import { realHosts } from "../../hosts";
import { useNow } from "../../useNow";
import { openElsewhere } from "./actions";
import { elsewhereChipText, elsewhereChipTitle, elsewhereRows } from "./logic";
import { useElsewhere, useHosts } from "./store";

export function ElsewhereChip() {
  const { hosts, activeId } = useHosts();
  const reads = useElsewhere();
  // Re-cut every 15 s, so a read that went stale stops counting without a new poll.
  const now = useNow(15_000);
  const rows = elsewhereRows(realHosts(hosts), activeId, reads, now);
  const text = elsewhereChipText(rows);
  if (!text) return null;
  return (
    // A BUTTON, not a label: a count on a control is the way to those rows.
    <button className="head-wait" title={elsewhereChipTitle(rows)} onClick={openElsewhere}>
      <MonitorDot size={13} /> {text}
    </button>
  );
}
