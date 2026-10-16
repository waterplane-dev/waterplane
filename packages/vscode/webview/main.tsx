import { createRoot } from "react-dom/client";
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
