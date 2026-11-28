import type { Api } from "./api.js";

export interface TokenStore {
  read(): string | null;
  write(token: string | null): void;
}

// Each pane keeps its own key: they are served from one origin.
export const createTokenStore = (key: string): TokenStore => ({
  read() {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write(token) {
    try {
      if (token) localStorage.setItem(key, token);
      else localStorage.removeItem(key);
    } catch {
      // Storage off: the pane still works, it just asks to sign in next time.
    }
  },
});

/** Resolves with the dialog's one message; rejects when it closes or can't open. */
export type DialogOpener = (url: string) => Promise<string>;

export class SignInError extends Error {
  constructor(
    readonly reason: "closed" | "blocked" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

// Office's codes for a dialog the user closed, and for one a popup blocker stopped.
const CLOSED = 12006;
const BLOCKED = 12009;

export const officeDialog: DialogOpener = (url) =>
  new Promise((resolve, reject) => {
    Office.context.ui.displayDialogAsync(url, { height: 60, width: 30 }, (opened) => {
      if (opened.status !== Office.AsyncResultStatus.Succeeded) {
        const blocked = opened.error.code === BLOCKED;
        reject(
          new SignInError(
            blocked ? "blocked" : "failed",
            blocked ? "Allow the sign-in window to open, then try again." : opened.error.message,
          ),
        );
        return;
      }
      const dialog = opened.value;
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
        dialog.close();
        // Newer hosts say where the message came from; only our own sign-in page counts.
        const from = "origin" in arg ? (arg as { origin?: string }).origin : undefined;
        if (from && from !== window.location.origin) {
          reject(new SignInError("failed", "Sign-in came from an unexpected page."));
          return;
        }
        resolve("message" in arg ? arg.message : "");
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
        const code = "error" in arg ? arg.error : 0;
        reject(
          new SignInError(
            code === CLOSED ? "closed" : "failed",
            code === CLOSED ? "Sign-in was closed." : "The sign-in window stopped.",
          ),
        );
      });
    });
  });

export type Session = { token: string; userId: string; workspaceId: string };

/** The dialog signs in on the web, then passes back a one-time code the pane swaps for a token. */
export async function signIn(open: DialogOpener, api: Api, dialogUrl: string): Promise<Session> {
  const message = await open(dialogUrl);
  let code: unknown;
  try {
    code = (JSON.parse(message) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  if (typeof code !== "string") throw new SignInError("failed", "Sign-in didn't finish.");
  const session = await api.post<{ token: string; user_id: string; workspace_id: string }>(
    "/auth/addin/exchange",
    { code },
  );
  return { token: session.token, userId: session.user_id, workspaceId: session.workspace_id };
}
