/**
 * The logins cheat sheet: commands that log a CLI in from a phone. A row adds
 * its command to the compose box (never sends it); one count is a filter.
 */
import { useState } from "react";
import { AlertTriangle, BookKey, Plus } from "lucide-react";
import { Sheet } from "../../Sheet";
import { CountChips, FilterBar, Row, RowTitle, RowSub, Hint } from "../../kit";
import { closeLogins, insertLogin } from "./actions";
import { LOGINS_HEADER, LOGIN_ROWS, cutRows, cutWords, localhostCount, rowWords } from "./logic";

export function LoginsSheet() {
  const [onlyLocal, setOnlyLocal] = useState(false);
  const total = LOGIN_ROWS.length;
  const rows = cutRows(onlyLocal);
  return (
    <Sheet title="logins" icon={<BookKey size={16} />} onClose={closeLogins}>
      <Hint>{LOGINS_HEADER}</Hint>
      <CountChips className="annot-tools" keys={["local"] as const}
        bucket={() => ({ count: localhostCount() })} label={() => "redirect to localhost"}
        active={onlyLocal ? "local" : null} onPick={(k) => setOnlyLocal(k === "local")} />
      {onlyLocal && (
        <FilterBar onClear={() => setOnlyLocal(false)} clearLabel="show all">
          {cutWords(rows.length, total)}
        </FilterBar>
      )}
      {rows.map((r) => (
        <Row key={r.id} kind="wrap">
          <Row as="button" kind="grow" title="add this command to the compose box" onClick={() => insertLogin(r)}>
            <RowTitle className="mono">{r.command}</RowTitle>
            <RowSub>{rowWords(r)}</RowSub>
            {r.redirectsToLocalhost && (
              <RowSub><AlertTriangle size={12} /> plain login redirects to localhost</RowSub>
            )}
          </Row>
          <span className="row-act" aria-hidden><Plus size={16} /></span>
        </Row>
      ))}
    </Sheet>
  );
}
