import { useEffect, useRef, useState } from "react";
import { isStandalone } from "../../platform";
import { showToast } from "../../toast";

/**
 * The PWA install offer the settings sheet raises: its state and the one
 * effect that captures the browser's prompt (docs/notes/app-architecture.md).
 * State first, then the effect, called where App's effect was.
 */
export function useInstallOffer() {
  // PWA install: Chrome/Edge fire `beforeinstallprompt` and let us re-raise it
  // later from a real user gesture. Captured here so the app can offer Install
  // itself instead of relying on the browser's easily-missed mini-infobar.
  const installEvt = useRef<any>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(() => isStandalone());
  // PWA install offers. `beforeinstallprompt` must be captured (and its default
  // suppressed) to be re-raisable later from a user gesture.
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); installEvt.current = e; setCanInstall(true); };
    const onInstalled = () => { installEvt.current = null; setCanInstall(false); setInstalled(true); showToast("installed — open it from your home screen"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return { installEvt, canInstall, setCanInstall, installed };
}
