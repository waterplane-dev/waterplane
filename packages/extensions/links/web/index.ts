/**
 * The links extension's web half: the sheet, its ☰ line and launcher ☰ line, a count chip on every repo with
 * pins (or, with none, a "found n" chip), and the host's one push (`changed` → read the state again). Imports only `@waterplane/sdk`,
 * `@waterplane/kit`, react, lucide-react and its own folder (`local/extension-boundary`).
 * Contract: `shared/wire.mts`.
 *
 * A count is a filter: the chip counts `repoChipCount` (the repo's pins, else what was found for it)
 * and opens the sheet cut to the same repo, with no search, chips or hidden rows in the way.
 */
import { createElement, useEffect } from "react";
import { Link2 } from "lucide-react";
import { featureSheetId, useConnStatus, useStore, type FeatureManifest } from "@waterplane/sdk";
import { PUSH_CHANGED } from "../shared/wire.mts";
import { LinksSheet } from "./LinksSheet.tsx";
import { repoChipCount, type RepoCut } from "./logic.ts";
import { links, onChanged, openLinks, readIfStale } from "./state.ts";

export const manifest: FeatureManifest = {
  id: "links",
  // The literal form (`tools/webshape.test.mjs` reads it); `state.ts` opens the same id as LINKS_SHEET.
  sheets: [{ id: featureSheetId("links", "main"), persisted: false, render: () => createElement(LinksSheet) }],
  pushes: { [PUSH_CHANGED]: () => onChanged() },
  // A line in every session's ☰ menu, joining its catalog as `links:links` (orderable, hideable,
  // pinnable into the header), and a line in the launcher's ☰ menu.
  menuItems: [{ id: "links", label: "links", icon: Link2, open: () => openLinks(null) }],
  launcherItems: [{ id: "links", label: "Links", icon: Link2, order: 20, open: () => openLinks(null) }],
  repoChips: [{
    id: "links",
    icon: Link2,
    useCount(repo) {
      const v = useStore(links);
      const status = useConnStatus();
      useEffect(() => { if (status === "open") readIfStale(); }, [status]);
      const c = v.res?.ok ? repoChipCount(v.res.result, repo.repoName) : null;
      const cut: RepoCut = { repo: repo.repoName };
      return c ? { ...c, filter: cut } : null;
    },
    open: (_repo, filter: RepoCut) => openLinks(filter),
  }],
};
