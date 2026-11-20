/** Doors of this area (whole-app journey spec §8: owned by P11 (session sheets; P15 the toolbar groups)). */
import { TITLE } from "../sheetNames.ts";
import type { DoorArea } from "./types.ts";

export const area: DoorArea = {
  doors: [
    { label: "Slash commands", from: "toolbar menu", to: "slash", title: TITLE.slash, task: "Run a slash command" },
    { label: "Switch model", from: "toolbar menu", to: "model", title: TITLE.model, task: "Change the model" },
    { label: "Select text", from: "toolbar menu", to: "text", title: TITLE.text, task: "Copy text off the screen" },
    { label: "To desktop clipboard", from: "toolbar menu", to: "clip", title: TITLE.clip, task: "Put text on the desktop clipboard" },
    { label: "Sent commands", from: "home menu", to: "sentlog", title: TITLE.sentlog, task: "See what was sent" },
    { label: "Decision log", from: "home menu", to: "decisions", title: TITLE.decisions, task: "See what the agent decided" },
    { label: "Answer the list", from: "toolbar menu", to: "answers", title: TITLE.answers, task: "Answer a pasted list" },
    { label: "History", from: "toolbar menu", to: "history", title: TITLE.history, task: "Resend an earlier prompt" },
    { label: "Header commands", from: "session header", to: "hdrcmd", title: TITLE.hdrcmd, task: "Pin commands into the header" },
    { label: "Logins", from: "toolbar menu", to: "logins", title: TITLE.logins, task: "Sign a shell in" },
    { label: "Pad", from: "home menu", to: "pad", title: TITLE.pad, task: "Keep a prompt that is not sent yet" },
    { label: "Fan out", from: "home", to: "fanout", title: TITLE.fanout, task: "Send one prompt to several repos" },
    { label: "Usage pace", from: "sheet:waiting", to: "weekburn", title: TITLE.weekburn, task: "See if the week runs out" },
    { label: "Storage", from: "settings", to: "storage", title: TITLE.storage, task: "See what this device holds" },
    { label: "Add a secret", from: "settings", to: "secret", title: TITLE.secret, task: "Add a secret" },
  ],
};
