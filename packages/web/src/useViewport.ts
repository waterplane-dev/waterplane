import { useEffect } from "react";

/**
 * A visual viewport shorter than this is not a real layout — it is a transient
 * state the browser reports while the page is being backgrounded, frozen, or
 * animated into the app switcher. Even with the on-screen keyboard up on a
 * small phone in landscape the visible strip is well above this.
 */
const MIN_H = 120;

/**
 * Pin the app to the VisualViewport so the on-screen keyboard never hides the
 * compose bar. iOS Safari overlays the keyboard without shrinking `100dvh`, and
 * scrolls the layout viewport up — so we track `visualViewport` and expose its
 * height/offset as CSS vars that #root binds to.
 *
 * **The vars are only ever written when the measurement is sane, and they are
 * re-applied on every wake.** `#root` is `position: fixed` with
 * `height: var(--app-h, 100dvh)`, so a single bogus `--app-h: 0px` collapses the
 * whole app to nothing — a black screen with no content, indistinguishable from
 * a crash and with no way out, because clearing it needs another `resize` that
 * a returning-to-foreground PWA does not necessarily fire (the size Chrome sees
 * did not change; only the one it reported while hidden was wrong). Android
 * Chrome reports height 0 while a PWA sits in the recents switcher, which is
 * exactly when the app is backgrounded. So: a sub-`MIN_H` reading REMOVES the
 * vars (falling back to `100dvh`) rather than writing the bad number, and a
 * visibility/pageshow/resize wake re-measures — plus a self-heal that checks
 * `#root` actually has height and resets the vars if it doesn't, which covers
 * a collapse from any cause, not just this one.
 */
export function useViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;

    let raf = 0;
    const clear = () => {
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
    };
    const measure = () => {
      if (!vv) { clear(); return; }
      // A hidden page's measurements are not trustworthy; keep the last good
      // ones (or the 100dvh fallback) until it is visible again.
      if (document.visibilityState === "hidden") return;
      if (!(vv.height >= MIN_H)) { clear(); return; }
      root.style.setProperty("--app-h", `${vv.height}px`);
      root.style.setProperty("--app-top", `${Math.max(0, vv.offsetTop)}px`);
    };
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    // Wake path: re-measure, then verify the app actually occupies the screen.
    // If #root is still collapsed a frame later, drop the vars entirely — a
    // fallback layout is always better than an invisible one.
    const heal = () => {
      if (document.visibilityState !== "visible") return;
      apply();
      setTimeout(() => {
        const el = document.getElementById("root");
        if (el && el.getBoundingClientRect().height < MIN_H) clear();
      }, 60);
    };

    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", heal);
    window.addEventListener("pageshow", heal);
    window.addEventListener("focus", heal);
    document.addEventListener("visibilitychange", heal);
    document.addEventListener("resume", heal);

    return () => {
      cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", heal);
      window.removeEventListener("pageshow", heal);
      window.removeEventListener("focus", heal);
      document.removeEventListener("visibilitychange", heal);
      document.removeEventListener("resume", heal);
    };
  }, []);
}
