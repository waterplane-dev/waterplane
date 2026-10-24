import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { SheetHead } from "../Sheet";
import { Button } from "./Button";
import { ago } from "../format";
import { useNow } from "../useNow";

/** "4m ago", re-rendered every 10 s so an age on a long-open sheet stays true. */
function Age({ at }: { at: number }) {
  useNow(10_000);
  return <span className="muted">{ago(at)}</span>;
}

/**
 * A sheet header with a refresh button and, when `at` is given, how old what is
 * on screen is. The button is always a button — a read in flight is shown by the
 * caller's own spinner/text, never by greying this out.
 */
export function StaleHead({ title, onClose, onRefresh, refreshTitle, at, iconSize = 16, bare = false, children }: {
  title: ReactNode;
  onClose: () => void;
  onRefresh: () => void;
  refreshTitle: string;
  /** When the shown data was read (ms). Absent: no age drawn. */
  at?: number | null;
  iconSize?: number;
  /** No `.head-acts tight` wrapper around the controls. */
  bare?: boolean;
  /** Extra controls, drawn before the refresh button. */
  children?: ReactNode;
}) {
  const acts = (
    <>
      {at != null && <Age at={at} />}
      {children}
      <Button title={refreshTitle} onClick={onRefresh}><RefreshCw size={iconSize} /></Button>
    </>
  );
  return (
    <SheetHead title={title} onClose={onClose}>
      {bare ? acts : <span className="head-acts tight">{acts}</span>}
    </SheetHead>
  );
}
