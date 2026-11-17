/** One quiet line under the totals card: waterplane's own metered calls. Nothing when there are none. */
import type { MeterSummary } from "@waterplane/shared";
import { hostSpendWords } from "./hostSpendWords.ts";

export function HostSpendLine({ meter }: { meter: MeterSummary | null | undefined }) {
  const v = hostSpendWords(meter);
  if (!v) return null;
  return <div className="empty ts-caveat"><b>{v.lead}</b>: {v.text}.</div>;
}
