/**
 * The line between the pinned repos and the rest on Home — drawn only when at
 * least one repo is pinned, so a person who never pins sees nothing new.
 *
 * It says what the rows below are (not pinned) and how they are ordered, and
 * the order is switched right here: the two orders are `REPO_ORDERS`, the same
 * pref the Settings row writes (`repoSort`), so the two can never disagree.
 */
import { setPref, usePref } from "../prefs";
import { track } from "../../usage";
import { showToast } from "../../toast";
import { REPO_ORDERS, type RepoOrder } from "./model";

// closed: a phone-local pref, never on the wire
const SHORT: Record<RepoOrder, string> = { sessions: "open sessions", name: "name" };

export function UnpinnedHead({ n }: { n: number }) {
  const sort = usePref("repoSort");
  return (
    <div className="unpinned-head" role="group" aria-label="repos not pinned, and their order">
      <span className="unpinned-words">{n} not pinned{n > 1 ? " · by" : ""}</span>
      {/* One row has no order to choose. */}
      {n > 1 && REPO_ORDERS.map((o) => (
        <button key={o} className={`unpinned-sort${o === sort ? " on" : ""}`} aria-pressed={o === sort}
          onClick={() => {
            if (o === sort) return;
            track(`action:repo.sort.${o}`);
            setPref("repoSort", o);
            showToast(o === "name" ? "repos not pinned: by name" : "repos not pinned: most open sessions first");
          }}>
          {SHORT[o]}
        </button>
      ))}
    </div>
  );
}
