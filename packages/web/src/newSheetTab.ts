/**
 * Which tab the New sheet opens on, when a door names one (the first-run card's *New project* and
 * *Clone a repo*). `CoreApi.nav.openNew` writes it, `NewMenu` takes it once on mount; a door that
 * names none leaves the sheet on its own first tab.
 */
export type NewTab = "repo" | "clone";

let asked: NewTab | null = null;

export function askNewTab(tab: NewTab | undefined): void { asked = tab ?? null; }

/** Read once: the next open of the sheet without a door starts on `repo` again. */
export function takeNewTab(): NewTab | null { const t = asked; asked = null; return t; }
