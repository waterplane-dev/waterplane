/**
 * The `snippets` sheet, wired: `SnippetSheet.tsx` (unchanged — the header
 * commands use the same component) handed the list, subscribed, and its save.
 */
import { useCore } from "../../sdk";
import { SnippetSheet } from "../../SnippetSheet";
import { saveSnippets } from "./actions";
import { useSnippets } from "./store";

export function SnippetsSheet() {
  const core = useCore();
  return <SnippetSheet snippets={useSnippets()} onSave={saveSnippets} onClose={() => core.nav.close("snippets")} />;
}
