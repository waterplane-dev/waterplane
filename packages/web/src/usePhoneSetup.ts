/**
 * The phone-setup steps, live: asked of the shell on mount and again every
 * time the app comes back to the front — which is the moment somebody returns
 * from the Settings page a step sent them to, and the tick has to appear.
 */
import { useCallback, useEffect, useState } from "react";
import { shellLinkStatus } from "./shellLink";
import { installStatus, nativeInstallSupported } from "./nativeInstall";
import { setupSteps, type SetupStep } from "./phoneSetup";

export function usePhoneSetup(): { steps: SetupStep[] | null; refresh: () => void } {
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const refresh = useCallback(() => {
    void (async () => {
      const link = await shellLinkStatus();
      const canInstall = nativeInstallSupported()
        ? await installStatus().then((r) => r.caps.supported ? r.caps.canInstall : null).catch(() => null)
        : null;
      setSteps(setupSteps({ link, canInstall }));
    })();
  }, []);
  useEffect(() => {
    refresh();
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);
  return { steps, refresh };
}
