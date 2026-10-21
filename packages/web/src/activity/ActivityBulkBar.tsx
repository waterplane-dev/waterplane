import { ArchiveRestore, Inbox, SendHorizontal, Square, SquareCheck } from "lucide-react";
import { track } from "../usage";
import { Unavailable } from "../Unavailable";
import type { ActivityModel } from "./useActivityModel";
import type { ActivitySheetProps } from "./activitySheetTypes";
import { Button } from "../kit/Button";

/** The bulk bar under the list: what each of the two decisions would cover. Null when not selecting. */
export function ActivityBulkBar({ m, p }: { m: ActivityModel; p: ActivitySheetProps }) {
  const { selecting, pickedRows, shown, selectVisible, clearSelection, refire, file, restorable, filter } = m;
  if (!selecting) return null;
  const filed = filter === "dismissed";
  // A decision that would cover nothing is not drawn — never a greyed button. With rows
  // ticked, why it is missing is a sentence; with none, "none selected" is the reason for all.
  const cants = !pickedRows.length ? [] : [
    ...(refire.go.length ? [] : [{ label: "send again", reason: "none of the selected rows can be sent again — each says why on its own row" }]),
    ...(filed || file.go.length ? [] : [{ label: "file away", reason: "the selected rows are running — stopping one is “cancel”" }]),
  ];
  return (
    <div className="act-bulk">
      <span className="act-bulk-n">{pickedRows.length ? `${pickedRows.length} selected` : "none selected — tick rows to act on them"}</span>
      {shown.length ? (
        <Button title={`select all ${shown.length} rows on screen`} onClick={selectVisible}>
          <SquareCheck size={14} /> all {shown.length}
        </Button>
      ) : null}
      {pickedRows.length ? <Button title="clear the selection" onClick={clearSelection}><Square size={14} /> none</Button> : null}
      {/* The two decisions the 84 rows are read for. Both restate their count, and both are
          confirmed with a sample before anything happens. */}
      {refire.go.length ? (
        <Button variant="primary" data-hint="activity.bulkRefire"
          title={`send ${refire.go.length} again as backlog items, each in the repo it was written for${refire.skip.length ? ` — ${refire.skip.length} left alone` : ""}`}
          onClick={() => { track("action:activity.bulk.refire"); p.onBulk("refire", refire.go); }}>
          <SendHorizontal size={14} /> send {refire.go.length} again
        </Button>
      ) : null}
      {filed ? (restorable.length ? (
        <Button title={`put ${restorable.length} back in the list`}
          onClick={() => { track("action:activity.bulk.restore"); p.onBulk("restore", restorable); }}>
          <ArchiveRestore size={14} /> bring {restorable.length} back
        </Button>
      ) : null) : file.go.length ? (
        <Button data-hint="activity.bulkDismiss"
          title={`file ${file.go.length} away as dealt with — nothing is deleted, and “dismissed” brings them back`}
          onClick={() => { track("action:activity.bulk.dismiss"); p.onBulk("dismiss", file.go); }}>
          <Inbox size={14} /> file {file.go.length} away
        </Button>
      ) : null}
      <Unavailable cants={cants} />
    </div>
  );
}
