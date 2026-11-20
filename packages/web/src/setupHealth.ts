/**
 * Setup & health: ONE screen (whole-app journey spec D7a) over what were five sibling sheets — the
 * Setup check (`features/setupCheck`), Repo readings and its `repohealth` alias (`features/setup`),
 * and Skills & plugins (`features/skills`). Tabs `This repo` and `This desktop`; This repo has the
 * sections `Checks`, `Health score`, `Watch`, `Opt-ins`, `Skills`, `Sessions`.
 *
 * A feature may not import another feature, so the frame (`SetupHealthSheet.tsx`) never imports a
 * body: each of the three features REGISTERS its body here when its index loads (the registry is
 * eager, `features/registry.ts`). The old overlay ids stay (stored routes, viewer `returnTo`s and the
 * 40-odd callers keep working); each now renders this one frame, on its own tab and section.
 *
 * Where the frame stands is `healthPlace`: a tap, never a setting. A door writes it with the overlay
 * it opens; a section tap rewrites it without changing the overlay, so a section switch is never a
 * Back step (Back from any section leaves the screen). A stale place (another overlay's) is ignored
 * and the opening overlay's own landing used instead.
 */
import type { ReactNode } from "react";
import { core, createStore } from "./sdk";
import type { HealthSection, HealthTab, Overlay } from "./routing";

export interface HealthPlace { tab: HealthTab; section: HealthSection }

/** This repo's sections, in the order the chip row draws them. */
export const REPO_SECTIONS: readonly HealthSection[] = ["checks", "score", "watch", "optins", "skills", "sessions"];

/** Which feature draws a place: the checks (both tabs), the readings regions, or the skills. */
export type HealthOwner = "checks" | "readings" | "skills";

export function ownerOf(p: HealthPlace): HealthOwner {
  if (p.tab === "desktop" || p.section === "checks") return "checks";
  return p.section === "skills" ? "skills" : "readings";
}

/** The readings sheet's region for a section, and back (`SetupSheet.tsx`'s `ReadingsRegion`). */
export type ReadingsRegionId = "series" | "watch" | "optins" | "agents";
export function regionOfSection(s: HealthSection): ReadingsRegionId {
  return s === "watch" ? "watch" : s === "optins" ? "optins" : s === "sessions" ? "agents" : "series";
}
export function sectionOfRegion(r: string | undefined): HealthSection {
  return r === "watch" ? "watch" : r === "optins" ? "optins" : r === "agents" ? "sessions" : "score";
}

export interface HealthBody {
  /** The body for this place, drawn under the frame's tabs (no sheet frame of its own). */
  render(place: HealthPlace): ReactNode;
  /** The repo this body is on now, carried to the next section so a switch keeps the repo. */
  repoId(): string | null;
  /** Aim this body at a repo (null = its own choice) and place before it is drawn. */
  enter(repoId: string | null, place: HealthPlace): void;
}

const bodies: Partial<Record<HealthOwner, HealthBody>> = {};

/** Called once by each owning feature's index. */
export function registerHealthBody(owner: HealthOwner, body: HealthBody): void { bodies[owner] = body; }
export function healthBody(owner: HealthOwner): HealthBody | null { return bodies[owner] ?? null; }

/** Where the frame stands, and which overlay it stands on. ONE writer per door: `placeHealth`. */
export const healthPlace = createStore<{ self: Overlay; place: HealthPlace } | null>(null);

/**
 * Where each frame UNDER the top one was standing. The store holds one place, so a door that opens the
 * frame under another id (the Checks' always-on list door opens `setup` over `repohealth`, `health`,
 * `setupcheck`) wrote over the place of the frame it covered — and the sheet keeper's snapshot, taken at
 * the push, already held the new place. Back then drew the covered frame on its landing section, not on
 * Checks where the door was tapped (review 2026-11-18). A place is parked here when another overlay
 * takes the store, and read back when its own overlay is on top again.
 */
const parked = new Map<Overlay, HealthPlace>();

export function placeHealth(self: Overlay, place: HealthPlace): void {
  const cur = healthPlace.get();
  if (cur && cur.self !== self) parked.set(cur.self, cur.place);
  parked.delete(self);
  healthPlace.set({ self, place });
}

/** Where `self` stood when another overlay took the store, if it did. */
export const parkedPlace = (self: Overlay): HealthPlace | null => parked.get(self) ?? null;

/** The place to draw for `self`: the stored one when it is this overlay's, else where it was parked, else its landing. */
export function placeFor(stored: { self: Overlay; place: HealthPlace } | null, self: Overlay, landing: HealthPlace, wasAt: HealthPlace | null = null): HealthPlace {
  return stored && stored.self === self ? stored.place : wasAt ?? landing;
}

/** A section switch inside the frame: the next body takes the current body's repo. */
export function switchHealth(self: Overlay, from: HealthPlace, to: HealthPlace): void {
  const repoId = healthBody(ownerOf(from))?.repoId() ?? null;
  healthBody(ownerOf(to))?.enter(repoId, to);
  placeHealth(self, to);
}

/** The frame closed (not covered): the next door starts from its own landing. */
export function leaveHealth(self: Overlay): void {
  parked.delete(self);
  if (healthPlace.get()?.self === self) healthPlace.set(null);
}

/**
 * The checks body moved itself to a scope of the other tab (a drill-down from all repos to this
 * machine, or Back out of one): the lit tab follows what is drawn, on the overlay on top.
 */
export function retabHealth(tab: HealthTab): void {
  const self = core().nav.overlay;
  const at = healthPlace.get();
  if (at && at.self === self && at.place.tab === tab) return;
  placeHealth(self, { tab, section: "checks" });
}
