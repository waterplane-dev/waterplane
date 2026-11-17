/** Every sentence of the findings: the money label, the saving, the backends, the checked-off rows. */
import type { BillingProfile } from "../billing.js";
import { priceListSource, priceSourceText } from "../pricing.js";
import { fmtCount } from "../tokens.js";
import type { Finding, FindingSaving, NotChecked, PassedCheck } from "./types.js";

/** What a dollar figure is: subscription and unknown "at list price, not a bill"; api and cloud "at list price". */
export function moneyLabel(profile: BillingProfile | undefined, source = priceSourceText(priceListSource())): string {
  const bill = profile === "api" || profile === "cloud" ? "at list price" : "at list price, not a bill";
  return `${bill} (${source})`;
}

const usdText = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : n < 100 ? `$${n.toFixed(1)}` : `$${Math.round(n)}`);

/** "about $1.2 and about 3.4M tokens a week at list price, not a bill; errs low". The approximately sign only on an estimate. */
export function savingWords(s: FindingSaving, profile?: BillingProfile): string {
  const approx = s.basis === "estimate" ? "≈" : "";
  const parts: string[] = [];
  if (s.usd !== undefined) parts.push(`${approx}${usdText(s.usd)}`);
  if (s.tokens !== undefined) parts.push(`${approx}${fmtCount(s.tokens)} tokens`);
  if (!parts.length) return "";
  let out = `${parts.join(" and ")} a week`;
  if (s.usd !== undefined) out += ` ${moneyLabel(profile)}`;
  if (s.errs === "low") out += "; errs low";
  else if (s.errs === "high") out += "; errs high";
  if (s.unpricedSessions) out += `; ${s.unpricedSessions} session${s.unpricedSessions === 1 ? "" : "s"} on models with no price are in the tokens, not the dollars`;
  return out;
}

/** What the first-party backends are called on screen; an id never is. A backend beyond these (a plugin's) is named by `labels`, else the id capitalised. */
export const BACKEND_NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", copilot: "Copilot", codex: "Codex", gemini: "Gemini" };
/** The names the desktop sent for the backends it knows (`BackendInfo.label`), by id. */
export type BackendLabels = Readonly<Record<string, string>>;
export const backendName = (id: string, labels?: BackendLabels): string => labels?.[id] ?? BACKEND_NAMES[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/** The backends line, one short line: what was read and what was not, never "fine" for an unread one. */
export function backendsWords(b: Finding["backends"], labels?: BackendLabels): string {
  const read = b.understood.length ? `read: ${b.understood.map((id) => backendName(id, labels)).join(", ")}` : "";
  const un = b.unread.length ? `not read: ${b.unread.map((u) => backendName(u.id, labels)).join(", ")}` : "";
  return [read, un].filter(Boolean).join(" · ");
}

/** The reasons behind the backends line, one sentence per unread backend (behind the card's `?`). */
export function backendsWhy(b: Finding["backends"], labels?: BackendLabels): string {
  return b.unread.map((u) => `${backendName(u.id, labels)}: ${u.why}.`).join(" ");
}

/** One checked-off row: what was checked, against which backends. A waived row says so. */
export function passedWords(p: PassedCheck, labels?: BackendLabels): string {
  const be = backendsWords(p.backends, labels);
  return `${p.waived ? `${p.what} (${p.waived})` : p.what}${be ? ` ${be}` : ""}`;
}

export function notCheckedWords(n: NotChecked): string {
  return `Not checked: ${n.why}`;
}

/** The count line every view shares: "N findings, M checks passed" and what could not run. */
export function checkedCountWords(findings: number, passed: number, notChecked: number, cutBarSaysFindings = false): string {
  const f = `${findings} finding${findings === 1 ? "" : "s"}`;
  const p = `${passed} check${passed === 1 ? "" : "s"} passed`;
  // A cut's own bar already says "n of N findings": the head then says the rest, not the same number again.
  const head = cutBarSaysFindings ? [p] : [f, p];
  return (notChecked > 0 ? [...head, `${notChecked} not checked`] : head).join(" · ");
}

/** "in 2 of 3 repos": a group's repos against the repos its rule RAN in. The CLI and the phone say it alike. */
export const groupCountWords = (n: number, ranIn: number): string => `in ${n} of ${ranIn} repo${ranIn === 1 ? "" : "s"}`;
export const groupUnreadWords = (unreadIn: number): string => (unreadIn > 0 ? `not checked in ${unreadIn}` : "");
/** A repo with nothing open: what passed, and what could not run. */
export const clearRowWords = (passed: number, notChecked = 0): string => `${passed} check${passed === 1 ? "" : "s"} passed${notChecked > 0 ? ` · ${notChecked} not checked` : ""}`;
