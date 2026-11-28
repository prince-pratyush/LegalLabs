import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App.js";
import { serve } from "../testing.js";
import { IdentityApp } from "./IdentityApp.js";
import { identityHash, parseIdentityRoute } from "./route.js";

const settings = (over: object = {}) => ({
  configured: false,
  issuer: "",
  client_id: "",
  scopes: ["openid", "email", "profile"],
  enabled: false,
  link_by_email: false,
  require_mfa_claim: false,
  has_secret: false,
  redirect_uri: "https://app.test/auth/oidc/callback",
  secret_storage: true,
  can_change: true,
  ...over,
});
const SSO = "/api/v1/admin/identity/sso";
const show = () => render(<IdentityApp onLeave={() => {}} />);
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the single sign-on screen", () => {
  it("is at #/admin/identity", () => {
    expect(parseIdentityRoute(identityHash())).toBe(true);
    expect(parseIdentityRoute("#/admin/users")).toBe(false);
  });

  it("shows what to register, and asks before turning it on", async () => {
    const sent = serve({
      [`GET ${SSO}`]: () => [200, settings()],
      [`PUT ${SSO}`]: () => [200, settings({ configured: true, enabled: true, has_secret: true })],
    });
    show();
    const redirect = (await screen.findByLabelText("Redirect address")) as HTMLInputElement;
    expect(redirect.value).toBe("https://app.test/auth/oidc/callback");
    // Matching by email is off until someone chooses it.
    const link = screen.getByRole("checkbox", { name: "Link accounts by verified email" });
    expect(link.getAttribute("aria-checked")).toBe("false");
    type("Issuer", "https://idp.test");
    type("Client ID", "legallabs");
    type("Client secret", "shh-value");
    fireEvent.click(link);
    fireEvent.click(screen.getByRole("checkbox", { name: "Turn single sign-on on" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(sent.some((s) => s.route === `PUT ${SSO}`)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(sent.find((s) => s.route === `PUT ${SSO}`)?.body).toEqual({
      issuer: "https://idp.test",
      client_id: "legallabs",
      client_secret: "shh-value",
      scopes: ["openid", "email", "profile"],
      enabled: true,
      link_by_email: true,
      require_mfa_claim: false,
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe(""),
    );
  });

  it("keeps a saved secret when none is typed, and shows why a save failed", async () => {
    const sent = serve({
      [`GET ${SSO}`]: () => [
        200,
        settings({
          configured: true,
          issuer: "https://idp.test",
          client_id: "c",
          has_secret: true,
        }),
      ],
      [`PUT ${SSO}`]: () => [
        422,
        { code: "DISCOVERY_FAILED", message: "Couldn't read this issuer's configuration." },
      ],
    });
    show();
    expect(await screen.findByText("A secret is saved. Leave this empty to keep it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't read this issuer's configuration.",
    );
    expect(sent.find((s) => s.route === `PUT ${SSO}`)?.body).not.toHaveProperty("client_secret");
  });

  it("only shows the settings to someone who can't change them", async () => {
    serve({ [`GET ${SSO}`]: () => [200, settings({ can_change: false })] });
    show();
    expect(await screen.findByText(/Only an administrator with every permission/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("signing in with single sign-on", () => {
  const signedOut = {
    "GET /auth/session": () => [401, { error: "unauthenticated" }] as [number, unknown],
  };

  it("needs the workspace, then points at the provider for it", async () => {
    serve(signedOut);
    render(<App />);
    const link = await screen.findByRole("link", { name: "Sign in with SSO" });
    fireEvent.click(link);
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your workspace first.");
    type("Workspace", "acme law");
    expect(link.getAttribute("href")).toBe("/auth/oidc/start?workspace=acme%20law");
  });

  it("says why it came back, and clears the address", async () => {
    window.history.replaceState(null, "", "/#/auth/sso?error=unavailable");
    serve(signedOut);
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Single sign-on isn't available for that workspace.",
    );
    expect(window.location.hash).toBe("");
  });
});
