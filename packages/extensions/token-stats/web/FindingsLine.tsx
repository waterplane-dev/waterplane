/**
 * One line from this spend into the Setup check: how many findings are about spend, and what was
 * checked and found fine. The checked-off count is always said, so the line is never empty once the
 * check has answered. It reads and links; nothing here diagnoses (the Setup check owns that).
 * Presentational: the phone's `TokensSheet` reads the check and hands it in; VS Code draws none.
 */
import { ListChecks } from "lucide-react";
import type { Finding, NotChecked, PassedCheck } from "@waterplane/shared";
import { Button } from "@waterplane/kit";
import { checkedBesideWords, spendFindingsOf } from "./findingsLineLogic.ts";

export interface FindingsLineData { findings: Finding[]; passed: PassedCheck[]; notChecked: NotChecked[]; pending?: boolean }

export function FindingsLine({ data, onOpen }: { data: FindingsLineData | null | undefined; onOpen: (spendFindings: number) => void }) {
  if (!data || data.pending) return null;
  const spend = spendFindingsOf(data.findings);
  return (
    <div className="empty ts-caveat" data-ev="findings-line">
      <b>{spend} finding{spend === 1 ? "" : "s"} about this spend</b> · {checkedBesideWords(data.passed.length, data.notChecked.length)}.{" "}
      <Button onClick={() => onOpen(spend)}><ListChecks size={14} /> open the setup check</Button>
    </div>
  );
}
