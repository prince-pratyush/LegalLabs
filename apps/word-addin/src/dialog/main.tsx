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
      <SignInDialog send={(message) => Office.context.ui.messageParent(message)} />
    </StrictMode>,
  );
});
