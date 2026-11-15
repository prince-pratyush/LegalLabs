import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { officeDialog } from "./auth/session.js";
import { followOfficeTheme } from "./office/theme.js";
import { createWordHost } from "./office/word.js";
import "./styles.css";

const root = document.getElementById("root");

Office.onReady((info) => {
  if (!root) return;
  followOfficeTheme();
  const app =
    info.host === Office.HostType.Word ? (
      <App host={createWordHost()} origin={window.location.origin} openDialog={officeDialog} />
    ) : (
      <p className="p-4 text-ui">Open LegalLabs from the ribbon in Microsoft Word.</p>
    );
  createRoot(root).render(<StrictMode>{app}</StrictMode>);
});
