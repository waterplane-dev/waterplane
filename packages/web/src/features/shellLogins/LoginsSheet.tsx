/**
 * The logins cheat sheet: commands that log a CLI in from a phone. A row adds
 * its command to the compose box (never sends it); one count is a filter.
 */
import { useState } from "react";
import { AlertTriangle, BookKey, Plus } from "lucide-react";
import { Sheet } from "../../Sheet";
import { CountChips, FilterBar } from "../../kit";
import { closeLogins, insertLogin } from "./actions";
import { LOGINS_HEADER, LOGIN_ROWS, cutRows, cutWords, localhostCount, rowWords } from "./logic";

export function LoginsSheet() {
  const [onlyLocal, setOnlyLocal] = useState(false);
  const total = LOGIN_ROWS.length;
  const rows = cutRows(onlyLocal);
  return (
    <Sheet title="logins" icon={<BookKey size={16} />} onClose={closeLogins}>
      <div className="form-hint">{LOGINS_HEADER}</div>
      <CountChips className="annot-tools" keys={["local"] as const}
        bucket={() => ({ count: localhostCount() })} label={() => "redirect to localhost"}
        active={onlyLocal ? "local" : null} onPick={(k) => setOnlyLocal(k === "local")} />
      {onlyLocal && (
        <FilterBar onClear={() => setOnlyLocal(false)} clearLabel="show all">
          {cutWords(rows.length, total)}
        </FilterBar>
      )}
      {rows.map((r) => (
        <div key={r.id} className="row-wrap">
          <button className="row grow" title="add this command to the compose box" onClick={() => insertLogin(r)}>
            <span className="row-title mono">{r.command}</span>
            <span className="row-sub">{rowWords(r)}</span>
            {r.redirectsToLocalhost && (
              <span className="row-sub"><AlertTriangle size={12} /> plain login redirects to localhost</span>
            )}
          </button>
          <span className="row-act" aria-hidden><Plus size={16} /></span>
        </div>
      ))}
    </Sheet>
  );
}
