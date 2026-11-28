import { applyTheme } from "@legallabs/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { registerWorker } from "./pwa/register.js";
import "./styles.css";

applyTheme();
registerWorker();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
