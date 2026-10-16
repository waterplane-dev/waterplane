/**
 * The sheet's folds and pick lists: the re-time pick list and its When editor,
 * and the per-row open sets. All of it
 * closes with the sheet — none of it is a setting.
 */
import { useState } from "react";

export function useBacklogUi() {
  /**
   * **The pick list for re-timing many rows at once.** Off by default — a
   * checkbox on every row is noise for the person who came to read the list —
   * and never a setting: it closes with the sheet. `picked` may hold ids the
   * current cut hides; only the ticked AND eligible AND on-screen rows are
   * counted and sent (`retimeIds` below), so a filter change can never make the
   * button act on a row the reader cannot see.
   */
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  /** The When editor is open over the list. */
  const [choosing, setChoosing] = useState(false);
  const [openDetail, setOpenDetail] = useState<Set<string>>(new Set());
  const toggleDetail = (id: string) => setOpenDetail((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [openValidate, setOpenValidate] = useState<Set<string>>(new Set());
  const toggleValidate = (id: string) => setOpenValidate((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Row-level expand: reveal the full instruction text + a "continue in a session"
  // action, independent of whether a check/validate pass has been run.
  const [openText, setOpenText] = useState<Set<string>>(new Set());
  // Which held rows have their *close one to make room* list open.
  const [slotOpen, setSlotOpen] = useState<Set<string>>(new Set());
  // Which rows have their session-budget editor open (`RowBudgetEdit`).
  const [budgetOpen, setBudgetOpen] = useState<Set<string>>(new Set());
  const toggleBudget = (id: string) => setBudgetOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleText = (id: string) => setOpenText((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return {
    picking,
    setPicking,
    picked,
    setPicked,
    choosing,
    setChoosing,
    openDetail,
    toggleDetail,
    openValidate,
    toggleValidate,
    openText,
    toggleText,
    slotOpen,
    setSlotOpen,
    budgetOpen,
    toggleBudget,
  };
}
