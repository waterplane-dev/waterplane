/**
 * The demo's first minute (the hook) and its "More to try" tour: a session that
 * opens already working, one hint at the reader toggle, a closing card, and a
 * sheet listing the headline features, each a tap into that screen of the demo.
 * README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { isDemo } from "../../demoEntry";
import { DemoTourSheet } from "./DemoTourSheet";
import { bootDemoTour, openHookSession } from "./actions";

export { DemoHookCard, DemoHookHint } from "./DemoHook";

export const manifest: FeatureManifest = {
  id: "demoTour",
  sheets: [
    // Never restored by a reload: the demo lands where its route says, and the
    // line's "More to try" is one tap away. Outside the demo it is nothing at
    // all — null falls through to the screen underneath.
    { id: "demotour", persisted: false, render: () => (isDemo() ? createElement(DemoTourSheet) : null) },
  ],
  messages: {
    // The hook scenario opens straight into its working session, once per visit.
    welcome: () => openHookSession(),
  },
  boot: () => bootDemoTour(),
};
