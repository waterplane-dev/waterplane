/**
 * **This phone's setup steps**, as rows — and the sheet the launcher's banner
 * opens. The banner names only what is missing, so its tap lands on exactly
 * those steps (`setupView`), says how many ready ones it left out, and offers
 * them back. Settings draws the same rows, unfiltered, in its checklist.
 */
import { useState } from "react";
import { BatteryCharging, Bell, Check, PackagePlus, Smartphone, Wifi, X, type LucideIcon } from "lucide-react";
import { core } from "../../sdk";
import { Sheet } from "../../Sheet";
import { Empty, FilterBar, Button, Row, RowTitle, RowSub } from "../../kit";
import { requestShellBatteryExemption, requestShellNotifications } from "../../shellLink";
import { openInstallSettings } from "../../nativeInstall";
import { usePhoneSetup } from "../../usePhoneSetup";
import { setupSummary, setupView, type SetupStep, type SetupStepId } from "../../phoneSetup";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { refreshShellLink, toggleShellLink } from "./actions";

const ICON = 16;

const STEP_ICON: Record<SetupStepId, LucideIcon> = {
  link: Wifi, notifications: Bell, battery: BatteryCharging, install: PackagePlus,
};

/** The one tap that leads to each step's system dialog or Settings switch. */
async function allowStep(id: SetupStepId, refresh: () => void): Promise<void> {
  track(`action:phoneSetup.${id}`);
  if (id === "link") await toggleShellLink();
  else if (id === "notifications") await requestShellNotifications();
  else if (id === "battery") await requestShellBatteryExemption();
  else await openInstallSettings().catch(() => showToast("this phone has no screen for that switch"));
  await refreshShellLink();
  refresh();
}

export function SetupStepRows({ steps, refresh }: { steps: readonly SetupStep[]; refresh: () => void }) {
  return (
    <div className="list">
      {steps.map((st) => {
        const Icon = STEP_ICON[st.id];
        return (
          <Row key={st.id} kind="wrap">
            <Row kind="grow">
              <RowTitle><Icon size={12} /> {st.label}: {st.done ? "ready" : "not allowed yet"}</RowTitle>
              <RowSub className="dim">{st.why}</RowSub>
            </Row>
            <div className="row-acts">
              {st.done
                ? <RowSub><Check size={ICON} /> done</RowSub>
                : <Button variant="primary" onClick={() => void allowStep(st.id, refresh)}>allow</Button>}
            </div>
          </Row>
        );
      })}
    </div>
  );
}

export function PhoneSetupSheet() {
  const { steps, refresh } = usePhoneSetup();
  const [showAll, setShowAll] = useState(false);
  const close = () => core().nav.close("phonesetup");
  // Outside the Android shell there is nothing to set up: fall through.
  if (!steps) return null;
  const { shown, hidden } = setupView(steps, showAll);
  const missing = steps.filter((s) => !s.done).length;
  return (
    <Sheet title={`Phone setup · ${setupSummary(steps)}`} icon={<Smartphone size={ICON} />} onClose={close}>
      {hidden > 0 && (
        <FilterBar section onClear={() => setShowAll(true)}
          clearTitle={`also show the ${hidden} step${hidden === 1 ? "" : "s"} already allowed`}
          clearLabel={<><X size={13} /> show all {steps.length}</>}>
          showing what is not allowed yet · {shown.length} of {steps.length}
        </FilterBar>
      )}
      {missing === 0 && !showAll
        ? <Empty>Everything is allowed — this app works with the app closed.</Empty>
        : <SetupStepRows steps={shown} refresh={refresh} />}
      <RowSub as="div" style={{ padding: "8px 12px" }}>
        Android grants none of these on its own — each is your tap on a system dialog or switch. This list re-reads when you come back from one.
      </RowSub>
    </Sheet>
  );
}
