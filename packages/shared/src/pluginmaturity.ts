/**
 * How mature a plugin SAYS it is, and the words for it — one place.
 *
 * The plugin's own `waterplane-plugin.json` carries `maturity`; absent is "unrated" (the plugin does
 * not say), never shown as stable. The phone and the host both word a plugin through
 * `pluginMaturity`, so no second table of labels exists.
 */

import { BRAND } from "./brand.js";
import type { PluginManifest } from "./plugin.js";

/** The GitHub topic a repo carries to be offered as a plugin (listed under `BRAND.githubOrg`). */
export const PLUGIN_TOPIC = BRAND.pluginManifest.replace(/\.json$/, "");

export const PLUGIN_MATURITIES = ["stable", "preview", "experimental"] as const;
export type PluginMaturityDeclared = (typeof PLUGIN_MATURITIES)[number];
export type PluginMaturityLevel = PluginMaturityDeclared | "unrated";

export interface PluginMaturityInfo {
  level: PluginMaturityLevel;
  /** The tag as printed: "Stable", "Preview", "Experimental", "Unrated". */
  label: string;
  /** One line of what it means for the person installing. */
  meaning: string;
}

const WORDS: Record<PluginMaturityLevel, { label: string; meaning: string }> = {
  stable: { label: "Stable", meaning: "The author considers it ready for daily use" },
  preview: { label: "Preview", meaning: "May break between versions" },
  experimental: { label: "Experimental", meaning: "May not work" },
  unrated: { label: "Unrated", meaning: "The plugin does not say" },
};

/** Read a manifest's maturity. Accepts a partial/unvalidated manifest; anything outside the three is "unrated". */
export function pluginMaturity(m: Pick<PluginManifest, "maturity"> | { maturity?: unknown } | null | undefined): PluginMaturityInfo {
  const v = m?.maturity;
  const level: PluginMaturityLevel = (PLUGIN_MATURITIES as readonly unknown[]).includes(v) ? (v as PluginMaturityDeclared) : "unrated";
  return { level, ...WORDS[level] };
}

/** Refusals for the manifest's `maturity` field (empty when absent or valid). Called by `manifestProblems`. */
export function maturityProblems(o: Record<string, unknown>): string[] {
  if (o.maturity === undefined) return [];
  if ((PLUGIN_MATURITIES as readonly unknown[]).includes(o.maturity)) return [];
  return [`maturity must be one of ${PLUGIN_MATURITIES.join(", ")} (or left out)`];
}
