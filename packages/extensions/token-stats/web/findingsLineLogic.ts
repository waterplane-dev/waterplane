import { findingCut, type Finding } from "@waterplane/shared";

/** The findings about spend: the ONE cut that feeds this line's number and the Setup check it opens. */
export const SPEND_SCREEN = "tokens";
export const spendFindingsOf = (findings: readonly Finding[]): number => findingCut(findings, { screen: SPEND_SCREEN }).count;

/** What was looked at beside the spend findings: never a second finding count. */
export function checkedBesideWords(passed: number, notChecked: number): string {
  const p = `${passed} check${passed === 1 ? "" : "s"} passed`;
  return notChecked > 0 ? `${p} · ${notChecked} not checked` : p;
}
