/**
 * The demo's first minute (the hook) and its "More to try" tour: a cue at `+ now` on the repo list, the
 * session that tap starts sent its first prompt from the compose box, one hint at the reader toggle, a closing card, and a
 * sheet listing the headline features, each a tap into that screen of the demo.
 * README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { isDemo } from "../../demoEntry";
import { DemoTourSheet } from "./DemoTourSheet";
import { bootDemoTour } from "./actions";

export { DemoHookCard, DemoHookHint, DemoStartCue } from "./DemoHook";

export const manifest: FeatureManifest = {
  id: "demoTour",
  sheets: [
    // Never restored by a reload: the demo lands where its route says, and the
    // line's "More to try" is one tap away. Outside the demo it is nothing at
    // all — null falls through to the screen underneath.
    { id: "demotour", persisted: false, render: () => (isDemo() ? createElement(DemoTourSheet) : null) },
  ],
  boot: () => bootDemoTour(),
};
