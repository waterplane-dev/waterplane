/**
 * An error boundary around one extension's drawing: a sheet, a menu line, a chip.
 *
 * An extension is code in the bundle like any feature, but its render is called from the core's own
 * tree (the launcher, the sheet table). A throw there would blank the launcher or the whole overlay, so
 * it is caught HERE, drawn as one sentence (`Unavailable`'s grammar: say why, never a dead control), and
 * SAID once per (feature, what) through the same toast and usage count a failed handler gets.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { CantInline } from "../Unavailable";
import { core } from "./api.ts";
import { createFailReporter } from "./featureRun.ts";

const fail = createFailReporter(true);

interface Props { feature: string; what: string; children: ReactNode }

export class ExtBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown, _info: ErrorInfo) {
    let c = null;
    try { c = core(); } catch { /* the log line is still written */ }
    fail(this.props.feature, `drawing ${this.props.what}`, e, c);
  }
  render() {
    return this.state.failed
      ? <CantInline>{this.props.feature} could not draw {this.props.what}</CantInline>
      : this.props.children;
  }
}
