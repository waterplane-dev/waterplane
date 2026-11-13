/**
 * The `snippets` sheet, wired: `SnippetSheet.tsx` (unchanged — the header
 * commands use the same component) handed the list, subscribed, and its save.
 */
import { useCore } from "../../sdk";
import { SnippetSheet } from "../../SnippetSheet";
import { addStarters, saveSnippets } from "./actions";
import { missingStarters } from "../../snippetPicks";
import { useSnippets } from "./store";

export function SnippetsSheet() {
  const core = useCore();
  const list = useSnippets();
  return <SnippetSheet snippets={list} onSave={saveSnippets} onClose={() => core.nav.close("snippets")}
    onAddStarters={missingStarters(list).length ? () => addStarters(list) : undefined} />;
}
