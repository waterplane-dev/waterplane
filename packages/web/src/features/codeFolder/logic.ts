/**
 * The code-folder dialog's pure half: how a root was picked in words, what a repo count says,
 * which guesses a person has already waved away, when to ask unprompted, and what a save
 * leaves the sheet saying. Pinned by `logic.test.mjs`.
 */
import { rootNeedsAsking, type RootInfo, type RootPicked, type RootPostReply } from "@waterplane/shared";

/** How the running root came about, as a Settings row and the sheet say it. */
export function pickedWords(picked: RootPicked, envName: string): string {
  switch (picked) {
    case "named": return `set by ${envName}`;
    case "chosen": return "chosen here";
    case "found": return "guessed — first usual code folder";
    case "fallback": return "guessed — folder missing";
    default: return "";
  }
}

/** "3 repos" · "1 repo" · "no repos" — what a scan found under a folder. */
export function reposWords(repos: number): string {
  if (repos === 1) return "1 repo";
  return repos > 0 ? `${repos} repos` : "no repos";
}

/** The current guess as one line: the path and what is under it, or that it is not there. */
export function rootLine(i: Pick<RootInfo, "root" | "rootExists" | "repos">): string {
  return i.rootExists ? `${i.root} · ${reposWords(i.repos)}` : `${i.root} · doesn't exist`;
}

/** A path as compared: no trailing slashes, so `~/dev/` and `~/dev` are one folder. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return n(a.trim()) === n(b.trim());
}

/** What "Use this folder" saves: the typed path when there is one, else the row that was tapped. */
export function targetPath(selected: string | null, typed: string): string {
  return typed.trim() || selected || "";
}

/** What can be done on the sheet: nothing (the variable names it), nothing from here (this connection), or choose. */
export type SheetMode = "named" | "locked" | "choose";
export function sheetMode(i: Pick<RootInfo, "picked" | "canChange">): SheetMode {
  if (i.picked === "named") return "named";
  return i.canChange ? "choose" : "locked";
}

export const LOCKED_WORDS = "The code folder can only be changed from the desktop itself or over Tailscale.";

export function namedWords(envName: string): string {
  return `${envName} sets the code folder where the host starts — change that variable, or unset it, to choose another here.`;
}

/** Saved but not yet scanned: the host was started by hand and has not been restarted. */
export function pendingWords(pending: string): string {
  return `Saved ${pending} — restart the host on the desktop to use it.`;
}

/** The footer, always: where it is kept and what wins over it. */
export function footerWords(i: Pick<RootInfo, "choicePath" | "envName">): string {
  return `Change it later in Settings → Code folder. It is kept in ${i.choicePath}; the ${i.envName} environment variable, if set where the host starts, wins over it.`;
}

/** The dismissal key: a guess is waved away as the guess it was, so a different folder (or a chosen one that vanished) asks again. */
export function dismissKey(i: Pick<RootInfo, "picked" | "root">): string {
  return `${i.picked}:${i.root}`;
}

const KEEP = 20;

/** Tolerant on purpose: a missing, hand-edited or older-build value reads as "nothing dismissed". */
export function parseLater(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0).slice(-KEEP);
}

export function withLater(list: readonly string[], key: string): string[] {
  return list.includes(key) ? [...list] : [...list, key].slice(-KEEP);
}

/**
 * Whether to open the dialog on its own: the folder was guessed (or a chosen one vanished), this
 * guess has not been waved away, the phone is on a plain screen (a sheet or a launch question is
 * somebody's tap in progress), and it is not the demo.
 */
export function shouldAskNow(
  i: Pick<RootInfo, "picked" | "root" | "rootExists" | "pending">,
  later: readonly string[],
  o: { overlay: string | null; demo: boolean },
): boolean {
  if (o.demo || o.overlay !== null) return false;
  if (!rootNeedsAsking(i)) return false;
  return !later.includes(dismissKey(i));
}

/** What a save leaves on the sheet. `closed` means nothing more to say; the others keep it up. */
export type AfterSave =
  | { kind: "closed" }
  | { kind: "restarting"; text: string }
  | { kind: "manual"; text: string }
  | { kind: "refused"; text: string };

export function afterSave(reply: RootPostReply): AfterSave {
  if (!reply.ok) return { kind: "refused", text: reply.error };
  if (!reply.saved) return { kind: "refused", text: "The desktop answered a check, not a save — update the host and try again." };
  if (reply.restart === "none") return { kind: "closed" };
  if (reply.restart === "auto") return { kind: "restarting", text: `Restarting the host to scan ${reply.root}…` };
  return { kind: "manual", text: `Saved. Restart the host on the desktop to scan ${reply.root}.` };
}

/** A check's answer as a line: the count, or the host's own sentence. */
export function checkWords(reply: RootPostReply): string {
  return reply.ok ? `${reply.root} · found ${reposWords(reply.repos)}` : reply.error;
}
