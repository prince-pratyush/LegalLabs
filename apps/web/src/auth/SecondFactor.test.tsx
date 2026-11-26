import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { type Handler, serve, signedIn } from "../testing.js";

/** Signed out until `done`, then signed in: what the session cookie does for real. */
function server(login: unknown, routes: (done: () => void) => Record<string, Handler>) {
  let session = false;
  return serve({
    ...signedIn,
    "GET /auth/session": () =>
      session ? [200, { user_id: "u", workspace_id: "w" }] : [401, { error: "unauthenticated" }],
    "POST /auth/login": () => [200, login],
    ...routes(() => {
      session = true;
    }),
  });
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

async function password() {
  render(<App />);
  await screen.findByLabelText("Workspace");
  type("Workspace", "acme");
  type("Email", "ana@acme.test");
  type("Password", "pw");
  click("Sign in");
}

const challenge = (methods: string[]) => ({
  mfa_required: true,
  mfa_enrolment_required: false,
  mfa_token: "pending-token",
  methods,
});
const enrol = {
  mfa_required: false,
  mfa_enrolment_required: true,
  mfa_token: "pending-token",
  methods: ["totp", "passkey"],
};
const CODE = "Code from your authenticator app";
const signedInNow = () => screen.findByRole("button", { name: "Sign out" });

describe("second factor at sign-in", () => {
  it("asks for the code, refuses a wrong one, then signs in", async () => {
    const sent = server(challenge(["totp", "recovery"]), (done) => ({
      "POST /auth/mfa/totp": (body) => {
        if ((body as { code: string }).code !== "123456") return [401, { error: "invalid_code" }];
        done();
        return [200, {}];
      },
    }));
    await password();
    await screen.findByLabelText(CODE);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    type(CODE, "000000");
    click("Confirm");
    expect((await screen.findByRole("alert")).textContent).toContain("didn't work");
    type(CODE, "123456");
    click("Confirm");
    await signedInNow();
    expect(sent.find((s) => s.route === "POST /auth/mfa/totp")?.body).toEqual({
      code: "000000",
    });
  });

  it("takes a recovery code", async () => {
    server(challenge(["totp", "recovery"]), (done) => ({
      "POST /auth/mfa/recovery": () => {
        done();
        return [200, {}];
      },
    }));
    await password();
    await screen.findByLabelText(CODE);
    click("Use a recovery code");
    type("Recovery code", "aaaa-bbbb-cccc");
    click("Confirm");
    await signedInNow();
  });

  it("signs in with a passkey", async () => {
    vi.stubGlobal("PublicKeyCredential", { parseRequestOptionsFromJSON: (o: unknown) => o });
    vi.stubGlobal("navigator", {
      credentials: { get: async () => ({ toJSON: () => ({ id: "key" }) }) },
    });
    const sent = server(challenge(["passkey", "recovery"]), (done) => ({
      "POST /auth/mfa/passkey/options": () => [200, { challenge_id: "c", options: {} }],
      "POST /auth/mfa/passkey/verify": () => {
        done();
        return [200, {}];
      },
    }));
    await password();
    await screen.findByRole("button", { name: "Use a passkey" });
    expect(screen.queryByLabelText(CODE)).toBeNull();
    click("Use a passkey");
    await signedInNow();
    expect(sent.find((s) => s.route === "POST /auth/mfa/passkey/verify")?.body).toEqual({
      challenge_id: "c",
      response: { id: "key" },
    });
  });

  it("starts over when the pending sign-in has gone", async () => {
    server(challenge(["totp", "recovery"]), () => ({
      "POST /auth/mfa/totp": () => [401, { error: "invalid_mfa_token" }],
    }));
    await password();
    await screen.findByLabelText(CODE);
    type(CODE, "123456");
    click("Confirm");
    expect((await screen.findByRole("alert")).textContent).toContain("expired");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("enrols an authenticator app and holds the recovery codes until saved", async () => {
    server(enrol, (done) => ({
      "POST /auth/mfa/enrol/totp/begin": () => [
        200,
        { secret: "ABCDEF", uri: "otpauth://totp/LegalLabs:ana%40acme.test?secret=ABCDEF" },
      ],
      "POST /auth/mfa/enrol/totp/confirm": () => {
        done();
        return [200, { recovery_codes: ["one-code", "two-code"] }];
      },
    }));
    await password();
    fireEvent.click(await screen.findByRole("button", { name: "Use an authenticator app" }));
    expect(await screen.findByText("ABCDEF")).toBeTruthy();
    expect(screen.getByText("Account: LegalLabs:ana@acme.test")).toBeTruthy();
    type(CODE, "123456");
    click("Confirm");
    await screen.findByText("one-code");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    click("I've saved them");
    await signedInNow();
  });

  it("takes over from single sign-on, whose token is only ever in the cookie", async () => {
    window.location.hash = "#/auth/mfa?kind=challenge&methods=totp,recovery";
    server({}, () => ({}));
    render(<App />);
    await screen.findByLabelText(CODE);
    expect(window.location.hash).toBe("");
  });

  it("never sends a token that a link put in the address", async () => {
    window.location.hash = "#/auth/mfa?kind=enrol&token=planted&methods=totp";
    const sent = server({}, () => ({
      "POST /auth/mfa/enrol/totp/begin": () => [401, { error: "invalid_mfa_token" }],
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Use an authenticator app" }));
    expect((await screen.findByRole("alert")).textContent).toContain("expired");
    const begun = sent.find((s) => s.route === "POST /auth/mfa/enrol/totp/begin");
    expect(JSON.stringify(begun?.body ?? {})).not.toContain("planted");
    expect(window.location.hash).toBe("");
  });
});
