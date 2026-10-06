/**
 * Every open question across sessions, answerable with no link — README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { OpenQuestionsSheet } from "./OpenQuestionsSheet";

export const manifest: FeatureManifest = {
  id: "questions",
  sheets: [
    { id: "questions", persisted: false, render: () => createElement(OpenQuestionsSheet) },
  ],
};
