/**
 * The Automation sheet's foot, drawn: **"Runs on its own, no clock"**.
 *
 * Every word and every door comes from `automationLines.ts` (node-tested); this
 * only renders. One sentence and one door per line — the door opens the thing
 * where it is managed, and nothing here edits or applies anything.
 */
import { Download, Flame, Link2, ListTodo, type LucideIcon } from "lucide-react";
import { track } from "./usage";
import type { AutomationDoor, AutomationLine } from "./automationLines";
import { Button } from "./kit/Button";
import { Row, RowSub } from "./kit/Row";

const ICONS: Record<AutomationLine["icon"], LucideIcon> = {
  backlog: ListTodo,
  pull: Download,
  weekburn: Flame,
  peer: Link2,
};

export function AutomationFoot({ lines, onDoor }: { lines: readonly AutomationLine[]; onDoor: (d: AutomationDoor) => void }) {
  if (!lines.length) return null;
  return (
    <div className="section">
      <div className="sched-head">Runs on its own, no clock</div>
      {lines.map((l) => {
        const Icon = ICONS[l.icon];
        return (
          <Row kind="wrap" key={l.key}>
            <RowSub><Icon size={13} style={{ verticalAlign: "-2px" }} /> {l.text}</RowSub>
            <Button onClick={() => { track(`action:automation.${l.icon}`); onDoor(l.door); }}>{l.verb}</Button>
          </Row>
        );
      })}
    </div>
  );
}
