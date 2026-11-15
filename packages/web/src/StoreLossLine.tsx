/**
 * The one line an owning sheet shows at its top when the desktop lost the
 * store behind its reading (budget, feature usage, sent log). Text, with a tap
 * to Settings › storage where the record can be hidden — nothing here applies
 * itself. The wording is `lossLineText` over `storeLossText`.
 */
import { AlertTriangle } from "lucide-react";
import type { StoreLoss } from "@waterplane/shared";
import { ago } from "./format";
import { Hint } from "./kit/Hint";
import { Button } from "./kit/Button";
import { lossLineText } from "./storeLoss";

export function StoreLossLine({ loss, onOpenStorage }: { loss: StoreLoss; onOpenStorage?: () => void }) {
  return (
    <Hint tone="warn">
      <AlertTriangle size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
      {lossLineText(loss, (ts) => ago(ts))}
      {onOpenStorage && <> <Button onClick={onOpenStorage} title="open Settings › storage">open storage</Button></>}
    </Hint>
  );
}
