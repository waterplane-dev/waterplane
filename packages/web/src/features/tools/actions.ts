/**
 * Every writer of the host-tools feature's stores. The two always-on strips
 * (`NetPulseBar`, `LocalRtBar`) are mounted above `App`, outside its tree, so
 * they cannot open a sheet by calling a setter: they ask by window EVENT, and
 * `bootStripDoors` (the manifest's `boot`) is the listener. The strip stays a
 * pure readout with one tap target per reading.
 */
import { core } from "../../sdk";
import type { NetHealthFocus } from "../../NetHealthSheet";
import type { LocalRtFocus } from "../../LocalRtBar";
import { localRtFocus, netFocus } from "./store";

/** Open the connection-health sheet at one reading's section. */
export function openNetHealth(focus: NetHealthFocus | undefined): void {
  const c = core();
  c.say.track("overlay:nethealth");
  netFocus.set(focus);
  c.nav.open("nethealth");
}

/** Open the local-runtime sheet at one reading's section. */
export function openLocalRt(focus: LocalRtFocus | undefined): void {
  const c = core();
  c.say.track("overlay:localrt");
  localRtFocus.set(focus);
  c.nav.open("localrt");
}

export function bootStripDoors(): () => void {
  // The strip is four readings, and each one asks for the sheet AT ITS OWN
  // section — a tap on "2.0 MB" that lands on the socket counters is a tap
  // that has to be followed by a hunt.
  const net = (e: Event) => openNetHealth((e as CustomEvent<{ focus?: NetHealthFocus }>).detail?.focus);
  // The `focus` rides the event, exactly as the strip above does it. Dropping
  // it — which this listener did at first — leaves four separate tap targets
  // all landing at the top of the sheet, and the sheet's scroll-and-flash
  // machinery unreachable: a deep link that is only a link.
  const rt = (e: Event) => openLocalRt((e as CustomEvent<{ focus?: LocalRtFocus }>).detail?.focus);
  window.addEventListener("app:open-nethealth", net);
  window.addEventListener("app:open-localrt", rt);
  return () => {
    window.removeEventListener("app:open-nethealth", net);
    window.removeEventListener("app:open-localrt", rt);
  };
}
