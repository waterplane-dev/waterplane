/** The Settings entry: a door in Tools & diagnostics' rack, beside *updates* — the durable way to the sheet. */
import { Sparkles } from "lucide-react";
import { SetAction } from "../../SettingsKit";
import { openWhatsNew } from "./actions";

export function WhatsNewSettings() {
  return (
    <SetAction id="whats-new" compact icon={Sparkles} label="what's new" onClick={openWhatsNew}
      title="this release's new things, their state here, and a way to each" />
  );
}
