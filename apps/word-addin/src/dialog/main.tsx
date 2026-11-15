import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followOfficeTheme } from "../office/theme.js";
import { SignInDialog } from "./SignInDialog.js";
import "../styles.css";

const root = document.getElementById("root");

Office.onReady(() => {
  if (!root) return;
  followOfficeTheme();
  createRoot(root).render(
    <StrictMode>
      <SignInDialog
        send={(message) => {
          // Addressed to the pane's own origin where the host supports it.
          try {
            Office.context.ui.messageParent(message, { targetOrigin: window.location.origin });
          } catch {
            Office.context.ui.messageParent(message);
          }
        }}
      />
    </StrictMode>,
  );
});
