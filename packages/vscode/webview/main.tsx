import { createRoot } from "react-dom/client";
// The phone's scale and token-screen sheet, unchanged; theme.css after them maps every colour onto the editor's.
import "../../web/src/styles/00-tokens.css";
import "../../web/src/styles/11-token-stats.css";
import "./theme.css";
import { App } from "./App";

// The host page supplies #root; make one if it ever does not rather than mount nothing.
let root = document.getElementById("root");
if (!root) {
  root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
}
createRoot(root).render(<App />);
