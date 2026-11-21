import { Settings } from "lucide-react";
import { Button } from "./kit/Button";
import { openSettingsSet } from "./settingsFocus";

/**
 * The gear in the head of every screen a top line opens — Connection, This desktop, the open-tabs
 * list: Settings narrowed to the lines at the top (`ROW_SETS.strips`), so showing or hiding one of
 * them, or what it holds, is one tap from the screen it led to instead of a hunt through Settings.
 * `before` closes a layer that sits above the route stack (the tab list) so Settings is not under it;
 * Back from Settings then lands where the list was opened from, as every other tap on that list does.
 */
export function StripsGear({ before }: { before?: () => void }) {
  return (
    <Button aria-label="settings for the lines at the top" title="settings — show or hide the lines at the top, and what each holds"
      onClick={() => { before?.(); openSettingsSet("strips"); }}>
      <Settings size={16} />
    </Button>
  );
}
