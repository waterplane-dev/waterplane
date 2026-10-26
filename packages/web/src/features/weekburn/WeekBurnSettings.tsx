/** The Settings entry: one door to the sheet (the sheet is where the week's pick is made). */
import { CalendarClock } from "lucide-react";
import { useCore } from "../../sdk";
import { SHEET } from "../../sheetNames";
import { SetAction } from "../../SettingsKit";

export function WeekBurnSettings() {
  const c = useCore();
  return (
    <SetAction
      id="weekburn" label={SHEET.weekburn} icon={CalendarClock} opens
      onClick={() => c.nav.open("weekburn")}
      note="Pick repos to spend the rest of the subscription week on, before it resets."
    />
  );
}
