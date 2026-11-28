import { followOfficeTheme, officeDialog } from "@legallabs/addin";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createOutlookHost } from "./office/outlook.js";
import "./styles.css";

const root = document.getElementById("root");

Office.onReady((info) => {
  if (!root) return;
  followOfficeTheme();
  const app =
    info.host === Office.HostType.Outlook ? (
      <App host={createOutlookHost()} origin={window.location.origin} openDialog={officeDialog} />
    ) : (
      <p className="p-4 text-ui">Open LegalLabs from an email in Outlook.</p>
    );
  createRoot(root).render(<StrictMode>{app}</StrictMode>);
});
