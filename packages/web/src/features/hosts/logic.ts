/**
 * The host switcher's pure half: what a host's unsent words ADD UP to (the
 * count the remove question states), and how a host is worded on a row.
 * Node-tested (`logic.test.mjs`); reads nothing — `actions.ts` hands it a
 * getter over either the bare keys (the active host) or its parked ones.
 */
import { agoText } from "../../format.ts";
import { parsePad, waitingTotal, type DeviceRow, type NotificationKind, type PairTarget, type PeerKind, type SavedHost, type WaitingAttention, type WaitingSummary } from "@waterplane/shared";

/** What "pair by code" opens on for a row: its own address, and its LAN address beside it for a phone
 *  with no tailnet (`pairAddressOf`). Both are the row's: nothing here came from a reply. */
export function rowPairTarget(host: Pick<SavedHost, "base" | "lan">): PairTarget {
  return { base: host.base, code: "", ...(host.lan ? { lan: host.lan.base } : {}) };
}

/** What a host's saved-but-unsent words are, by kind. */
export interface HostWords { drafts: number; notes: number; queued: number }

/** The storage keys that hold words, by their bare names (`storage.ts`'s `LS`). */
export interface WordKeys {
  composeDrafts: string;
  composeSheets: string;
  compose: string;
  backlogDraft: string;
  fanoutText: string;
  pad: string;
  composeOutbox: string;
  outbox: string;
}

function json(raw: string | null): unknown {
  if (raw == null || raw === "") return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** A stored text draft: a JSON string or a raw one. Blank counts as nothing. */
function textDraft(raw: string | null): number {
  const v = json(raw);
  return typeof v === "string" && v.trim() ? 1 : 0;
}

/** A `{key: text}` map of drafts: the non-blank ones. */
function mapDrafts(raw: string | null): number {
  const v = json(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) return 0;
  return Object.values(v as Record<string, unknown>).filter((t) => typeof t === "string" && t.trim()).length;
}

function listLen(raw: string | null): number {
  const v = json(raw);
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Count one host's words. Every queue row counts, `failed` included — a failed
 * row is kept in full for ever, so it is exactly a word that would be missed.
 */
export function countHostWords(get: (bareKey: string) => string | null, k: WordKeys): HostWords {
  return {
    drafts: mapDrafts(get(k.composeDrafts)) + mapDrafts(get(k.composeSheets))
      + textDraft(get(k.compose)) + textDraft(get(k.backlogDraft)) + textDraft(get(k.fanoutText)),
    notes: parsePad(get(k.pad)).notes.length,
    queued: listLen(get(k.composeOutbox)) + listLen(get(k.outbox)),
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3 drafts, 2 pad notes and 1 queued prompt" — or null when there is nothing. */
export function wordsText(w: HostWords): string | null {
  const parts = [
    w.drafts ? plural(w.drafts, "draft", "drafts") : null,
    w.notes ? plural(w.notes, "pad note", "pad notes") : null,
    w.queued ? plural(w.queued, "queued prompt", "queued prompts") : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The remove question's lines: what stays, and — for the active host — where
 *  the app goes instead. Nothing here is ever deleted, and the lines say so. */
export function removeLines(w: HostWords, active: boolean, next: SavedHost | null): string[] {
  const what = wordsText(w);
  const n = w.drafts + w.notes + w.queued;
  const lines = [what
    ? `${what} ${n === 1 ? "stays" : "stay"} saved on this device; re-add the host to see them.`
    : "Nothing unsent is saved for it on this device."];
  if (active) {
    lines.push(next
      ? `It is the host in use: the app switches to ${next.name} first, then reloads.`
      : "It is the only host: the app goes back to the connect screen.");
  }
  return lines;
}

/** An address as a row shows it: no scheme, no default port. */
export function hostAddress(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/:8770$/, "");
}

/** The session header names the host only when there is more than one — a
 *  single desktop is not a fact worth a line. */
export function showHostName(hosts: readonly SavedHost[]): boolean {
  return hosts.length > 1;
}

/** The launcher bar's switch key names the desktop in a few letters — its
 *  first word ("DeskMini-von-Alex" → "DeskM…"), capped so the key fits
 *  beside the settings cog instead of wrapping onto a row of its own. The
 *  full name is the title and the menu row. */
/** What "use plain HTTP" says first. `changed`: this phone refused a key at this desktop's address,
 *  where the safe answer is pairing by code and the plain route proves nothing. */
export function plainHttpLines(changed: boolean): string[] {
  const cost = "Anyone on this Wi-Fi could read what goes to this desktop, and could pretend to be it.";
  const back = "It stays that way until you pair again by code.";
  return changed
    ? ["This device was shown a different key for this desktop. Its key changed, or someone is in between.", "Pairing by code proves it is your desktop. Plain HTTP proves nothing.", cost, back]
    : ["For a desktop whose encrypted link was turned off.", cost, back];
}

/** The line a row on plain HTTP by the person's own choice carries. */
export const PLAIN_BY_CHOICE_TEXT = "Plain HTTP, by your choice. Pair by code to encrypt it again.";

/** The toast after the switch: what changed, and the way back. */
export function plainHttpDoneText(name: string): string {
  return `${name} now uses plain HTTP. Pair by code to encrypt it again.`;
}

export const SHORT_HOST_MAX = 6;
export function shortHostName(name: string): string {
  const first = name.trim().split(/[\s\-_.·]+/).find((w) => w.length > 0) ?? "";
  return first.length > SHORT_HOST_MAX ? `${first.slice(0, SHORT_HOST_MAX - 1)}…` : first;
}

/** The toggle half of that key: the next of the person's own desktops after
 *  the one in use, wrapping — so two hosts flip and three go round. `hosts`
 *  arrives without the demo row (`realHosts`). Fewer than two, or nothing but
 *  the one in use ⇒ null, and the key is not drawn. */
export function nextHostId(hosts: readonly SavedHost[], activeId: string | null): string | null {
  if (hosts.length < 2) return null;
  const i = hosts.findIndex((h) => h.id === activeId);
  return hosts[(i + 1) % hosts.length].id;
}

/** Active first, then the order they were added — so the row a thumb wants
 *  (another one) is never under the one it is on. */
export function hostRows(hosts: readonly SavedHost[], activeId: string | null): SavedHost[] {
  const a = hosts.filter((h) => h.id === activeId);
  return [...a, ...hosts.filter((h) => h.id !== activeId)];
}

// ── Pair another phone: the QR ──────────────────────────────────────────

/**
 * An SVG path drawing every dark module of an `n`×`n` QR, one unit per
 * module, runs along a row merged into one rectangle (a 57-module code is a
 * few hundred subpaths, not three thousand). The caller adds the quiet zone
 * through the viewBox.
 */
export function qrPath(n: number, isDark: (row: number, col: number) => boolean): string {
  const out: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!isDark(r, c)) { c++; continue; }
      let e = c;
      while (e < n && isDark(r, e)) e++;
      out.push(`M${c} ${r}h${e - c}v1h${c - e}z`);
      c = e;
    }
  }
  return out.join("");
}

/** `9:41 left`, or null once it is spent. Whole seconds, rounded UP — a
 *  code must not read `0:00 left` while it still works. */
export function codeLeftText(msLeft: number): string | null {
  if (!(msLeft > 0)) return null;
  const s = Math.ceil(msLeft / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

// ── Paired devices ──────────────────────────────────────────────────────

/** How the device last came in, as a clause. */
export function deviceRouteText(kind: PeerKind | null): string {
  switch (kind) {
    case "tailscale": return "over the tailnet";
    case "lan": return "over the Wi-Fi (LAN)";
    case "loopback": return "on the desktop itself";
    case "public": return "over a public address";
    default: return "route not recorded";
  }
}

/** `just now` · `4 min ago` · `3 h ago` · `2 d ago` — `agoText`, under the name this screen uses. */
export const seenAgo = agoText;

/** The revoke question's lines. Revoking THIS phone is allowed, and says what it does. */
export function revokeLines(row: Pick<DeviceRow, "name" | "current">): string[] {
  return row.current
    ? [
        "This is the device you are holding. Revoking it signs this device out of this desktop at once.",
        "It will need a new pairing code (or the password) to connect again.",
      ]
    : [`${row.name} will need a new pairing code to connect again.`];
}

/** What the list says when it has no rows — or why there can be none. */
export function devicesEmptyText(passwordSet: boolean): string {
  return passwordSet
    ? "No phone has its own sign-in yet. Pair one with \"pair another phone\" — each gets a row here you can revoke."
    : "Set a host password to give each phone its own sign-in. Without one, this desktop keeps no per-phone sign-ins to list or revoke.";
}

/**
 * The sentence for a host switch that ran out of room on this phone
 * (`hosts.ts` `takeSwitchFailure`). `park`: nothing moved, so it says which
 * desktop the phone is STILL on — the switch key showing that name is not a
 * stuck tap. `restore`: the phone is on the new desktop and some of its parked
 * words are not back yet; they are kept and come back once there is room.
 * A host no longer in the list is "the other desktop", never an id.
 */
export function switchFailText(
  f: { stage: "park" | "restore"; from: string | null; to: string | null },
  hosts: readonly SavedHost[],
): string {
  const name = (id: string | null, fallback: string) => hosts.find((h) => h.id === id)?.name ?? fallback;
  const to = name(f.to, "the other desktop");
  if (f.stage === "park") {
    return `Could not switch to ${to}: this device's storage is full. Still on ${name(f.from, "the same desktop")} — free room under Storage on this device, then switch again.`;
  }
  return `On ${to}, but this device's storage is full: some of its saved drafts are not back yet. They are kept and return once there is room — see Storage on this device.`;
}

// ── Waiting elsewhere ──────────────────────────────────────────────────
//
// What the person's OTHER desktops wait on them for, as rows and as the launcher chip's words.
// The poll that fills the reads is `actions.ts`; each read holds `GET /api/attention`'s summary
// (`shared/waiting.ts`).
//
// **One function feeds the chip and the sheet** (CLAUDE.md, a count on a control is a filter):
// `elsewhereRows` is called by both, the chip's number is `elsewhereTotal` over those rows, and the
// sheet draws exactly those rows. **A number is only ever shown from a FRESH read**: a desktop that
// stopped answering keeps a sentence ("not answering — …"), never a count, and one that has never
// answered is absent.

/** How often another desktop is asked while the app is on screen. */
export const ELSEWHERE_POLL_MS = 45_000;
/** A failing desktop is asked less and less often, up to this. */
export const ELSEWHERE_BACKOFF_MAX_MS = 5 * 60_000;
/** A read older than this is not fresh: its number is no longer shown. */
export const ELSEWHERE_FRESH_MS = 2 * ELSEWHERE_POLL_MS;

/** Why the last ask of a desktop got no summary. */
export type ElsewhereFailure = "offline" | "signedOut" | "refused" | "unreadable";

/** The poll's memory of one desktop. */
export interface ElsewhereRead {
  /** The last good summary and when this PHONE got it (never the host's clock). */
  ok: { at: number; summary: WaitingSummary } | null;
  /** The last failure, when it came after the last good read. */
  fail: { at: number; why: ElsewhereFailure } | null;
  /** Failures in a row (the backoff). */
  fails: number;
}

export type ElsewhereRow =
  | { host: SavedHost; state: "waiting"; at: number; summary: WaitingSummary; total: number }
  | { host: SavedHost; state: "signedOut" }
  | { host: SavedHost; state: "stale"; since: number; lastTotal: number };

/**
 * One row per other desktop of the person's (`hosts` is `realHosts`, the demo out) that has
 * something to say: a fresh read with something waiting, a refused token, or a desktop that
 * stopped answering after its last good read said something was waiting. Waiting rows first,
 * most waiting first; then the sentences.
 */
export function elsewhereRows(hosts: readonly SavedHost[], activeId: string | null,
  reads: Readonly<Record<string, ElsewhereRead | undefined>>, now: number): ElsewhereRow[] {
  const waiting: ElsewhereRow[] = [];
  const said: ElsewhereRow[] = [];
  for (const host of hosts) {
    if (host.id === activeId) continue;
    const r = reads[host.id];
    if (!r) continue;
    if (r.fail?.why === "signedOut") { said.push({ host, state: "signedOut" }); continue; }
    const ok = r.ok;
    if (!ok) continue;
    const total = waitingTotal(ok.summary);
    const fresh = !r.fail && now - ok.at <= ELSEWHERE_FRESH_MS;
    if (fresh) {
      if (total > 0) waiting.push({ host, state: "waiting", at: ok.at, summary: ok.summary, total });
    } else if (total > 0) {
      said.push({ host, state: "stale", since: ok.at, lastTotal: total });
    }
  }
  waiting.sort((a, b) => (b.state === "waiting" ? b.total : 0) - (a.state === "waiting" ? a.total : 0));
  return [...waiting, ...said];
}

/** The chip's number: what the fresh rows wait for, summed. Never a stale or refused one. */
export function elsewhereTotal(rows: readonly ElsewhereRow[]): number {
  return rows.reduce((n, r) => n + (r.state === "waiting" ? r.total : 0), 0);
}

/**
 * The chip's words, or null for no chip: "zenbook · 1 waiting", "2 desktops · 3 waiting", and
 * with nothing waiting but a desktop that signed this phone out, "zenbook · signed out" — a
 * sentence the person can act on. A stale desktop alone draws no chip (its number is not shown).
 */
export function elsewhereChipText(rows: readonly ElsewhereRow[]): string | null {
  const waiting = rows.filter((r) => r.state === "waiting");
  const total = elsewhereTotal(rows);
  if (total > 0) {
    const who = waiting.length === 1 ? shortHostName(waiting[0].host.name) : `${waiting.length} desktops`;
    return `${who} · ${total} waiting`;
  }
  const out = rows.filter((r) => r.state === "signedOut");
  if (out.length === 0) return null;
  return `${out.length === 1 ? shortHostName(out[0].host.name) : `${out.length} desktops`} · signed out`;
}

/** The chip's `title`: the whole sentence and what a tap does. */
export function elsewhereChipTitle(rows: readonly ElsewhereRow[]): string {
  const names = rows.map((r) => r.host.name).join(", ");
  return `waiting on you on another desktop (${names}) — tap to see what and switch there`;
}

/** One kind, as the row words it. */
const KIND_WORD: Partial<Record<NotificationKind, [string, string]>> = {
  approval: ["approval request", "approval requests"],
  prompt: ["question", "questions"],
  signin: ["sign-in", "sign-ins"],
  cli: ["CLI problem", "CLI problems"],
  disk: ["disk warning", "disk warnings"],
  undelivered: ["prompt not delivered", "prompts not delivered"],
  followup: ["follow-up", "follow-ups"],
};
const kindWord = (k: NotificationKind, n: number): string => {
  const w = KIND_WORD[k] ?? ["alert", "alerts"];
  return n === 1 ? w[0] : w[1];
};

/** What one item is, in a few words: "approval request (vault)". */
export function itemWord(i: Pick<WaitingAttention, "kind" | "plugin">): string {
  return `${kindWord(i.kind, 1)}${i.plugin ? ` (${i.plugin})` : ""}`;
}

/**
 * A desktop's summary as one line: "1 approval request (vault) · 1 question". Sessions on a
 * question are "questions"; listed items are grouped by kind and plugin; items past the list's
 * cap are "n more".
 */
export function elsewhereRowText(s: WaitingSummary): string {
  const parts: string[] = [];
  const groups = new Map<string, { kind: NotificationKind; plugin?: string; n: number }>();
  for (const i of s.attention.items) {
    const k = `${i.kind}|${i.plugin ?? ""}`;
    const g = groups.get(k) ?? { kind: i.kind, ...(i.plugin ? { plugin: i.plugin } : {}), n: 0 };
    g.n++;
    groups.set(k, g);
  }
  for (const g of groups.values()) parts.push(`${g.n} ${kindWord(g.kind, g.n)}${g.plugin ? ` (${g.plugin})` : ""}`);
  const more = s.attention.n - s.attention.items.length;
  if (more > 0) parts.push(`${more} more`);
  if (s.sessions.n > 0) parts.push(`${s.sessions.n} session${s.sessions.n === 1 ? "" : "s"} on a question`);
  return parts.join(" · ") || "nothing waiting";
}

/** The sentence a row says in place of a number. */
export function elsewhereSaidText(r: ElsewhereRow, now: number): string {
  if (r.state === "signedOut") return `This device is signed out on ${r.host.name} — pair again to see what waits there.`;
  if (r.state === "stale") return `${r.host.name} is not answering — its last answer, ${agoText(now - r.since)}, said ${r.lastTotal} waiting.`;
  return elsewhereRowText(r.summary);
}

/** The one toast when a desktop's waiting total ROSE: "zenbook: 1 approval request (vault) waiting". */
export function elsewhereRiseText(host: Pick<SavedHost, "name">, s: WaitingSummary): string {
  return `${host.name}: ${elsewhereRowText(s)} waiting — the chip beside the desktop key shows it`;
}

/**
 * Should the poll say so: the total rose against the last number this page saw. The first
 * read of a desktop only sets the baseline (the chip is what an app start shows).
 */
export function elsewhereRose(prev: number | undefined, next: number): boolean {
  return prev !== undefined && next > prev;
}

/** Where a tap on one item lands after the switch (a `shellOpen` string), or undefined. */
export function itemOpenTarget(i: Pick<WaitingAttention, "plugin" | "sessionId">): string | undefined {
  if (i.plugin) return `plugin:${i.plugin}`;
  return i.sessionId || undefined;
}

/** The next time a desktop is asked: the interval when it answered, doubling per failure up to the cap. */
export function nextAskIn(fails: number): number {
  if (fails <= 0) return ELSEWHERE_POLL_MS;
  return Math.min(ELSEWHERE_BACKOFF_MAX_MS, ELSEWHERE_POLL_MS * 2 ** Math.min(fails, 8));
}

/** A read's next state after one ask. `status` 0 = the fuse / network failed. */
export function nextRead(prev: ElsewhereRead | undefined, now: number,
  res: { status: number; summary: WaitingSummary | null }): ElsewhereRead {
  const base: ElsewhereRead = prev ?? { ok: null, fail: null, fails: 0 };
  if (res.summary) return { ok: { at: now, summary: res.summary }, fail: null, fails: 0 };
  const why: ElsewhereFailure = res.status === 0 ? "offline" : res.status === 401 ? "signedOut"
    : res.status === 403 ? "refused" : res.status >= 200 && res.status < 300 ? "unreadable" : "offline";
  return { ok: base.ok, fail: { at: now, why }, fails: base.fails + 1 };
}
