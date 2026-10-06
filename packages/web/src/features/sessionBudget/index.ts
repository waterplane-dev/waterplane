/**
 * A cap on what ONE session may spend: the `sessionBudget` sheet.
 * README.md says what it owns; the shared wording is `@waterplane/shared`'s
 * `sessionbudget.ts` and the field the Send sheet and launch ask also draw is
 * the top-level `BudgetField.tsx`.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { budgetSid } from "../../sessionBudgetDoor";
import { SessionBudgetSheet } from "./SessionBudgetSheet";
import { budgetSubject } from "./logic";

export { openSessionBudget, closeSessionBudget } from "./actions";
export { budgetTagFacts, budgetToast, shouldNoticeBudget } from "./logic";

export const manifest: FeatureManifest = {
  id: "sessionBudget",
  sheets: [
    // Guarded rather than defaulted, like every scoped sheet: no subject returns
    // null and the screen underneath paints, never an empty sheet.
    { id: "sessionBudget", persisted: false, render: (c) => {
      const subject = budgetSubject(budgetSid.get(), c.world.sessions, c.world.active);
      return subject ? createElement(SessionBudgetSheet, { subject, title: c.world.sessionRowTitle(subject) }) : null;
    } },
  ],
};
