import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInDialog } from "./SignInDialog.js";

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

/** The API by path; anything not listed is refused. */
function serve(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    asked.push(path);
    return routes[path]?.() ?? reply(401, { error: "unauthenticated" });
  });
  return asked;
}

async function signIn() {
  await userEvent.type(screen.getByLabelText("Workspace"), "acme");
  await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "pw-for-tests");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

const click = (name: string) => userEvent.click(screen.getByRole("button", { name }));
const owes = (enrol: boolean, methods: string[]) => () =>
  reply(200, { mfa_required: !enrol, mfa_enrolment_required: enrol, methods });
const code = () => reply(200, { code: "abc" });
const sentCode = JSON.stringify({ code: "abc" });
const APP_CODE = "Code from your authenticator app";

describe("SignInDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs in, then sends the pane a one-time code and never the password", async () => {
    const send = vi.fn();
    serve({ "/auth/login": () => reply(200), "/auth/addin/code": code });
    render(<SignInDialog send={send} />);
    await signIn();
    expect(send).toHaveBeenCalledWith(sentCode);
    expect(JSON.stringify(send.mock.calls)).not.toContain("pw-for-tests");
  });

  it("skips the form when already signed in on the web", async () => {
    const send = vi.fn();
    serve({ "/auth/session": () => reply(200), "/auth/addin/code": code });
    render(<SignInDialog send={send} />);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(sentCode));
  });

  it("says when the details don't match", async () => {
    serve({});
    render(<SignInDialog send={vi.fn()} />);
    await signIn();
    expect(await screen.findByText(/don't match/)).toBeTruthy();
  });

  it.each([
    ["an authenticator code", "/auth/mfa/totp", APP_CODE],
    ["a recovery code", "/auth/mfa/recovery", "Recovery code"],
  ])("asks for no pane code until %s is accepted", async (_, path, label) => {
    const send = vi.fn();
    let right = false;
    const asked = serve({
      "/auth/login": owes(false, ["totp", "recovery"]),
      [path]: () => (right ? reply(200) : reply(401, { error: "invalid_code" })),
      "/auth/addin/code": code,
    });
    render(<SignInDialog send={send} />);
    await signIn();
    if (label === "Recovery code") await click("Use a recovery code");
    await userEvent.type(screen.getByLabelText(label), "000000");
    await click("Confirm");
    expect(await screen.findByText(/didn't work/)).toBeTruthy();
    expect(asked).not.toContain("/auth/addin/code");

    right = true;
    await click("Confirm");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(sentCode));
  });

  it("says what to do when this window can't use the passkey", async () => {
    serve({ "/auth/login": owes(false, ["passkey"]) });
    render(<SignInDialog send={vi.fn()} />);
    await signIn();
    expect(screen.getByText(/add an authenticator app/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
  });

  it("enrols, and waits for the recovery codes to be saved", async () => {
    const send = vi.fn();
    serve({
      "/auth/login": owes(true, ["totp", "passkey"]),
      "/auth/mfa/enrol/totp/begin": () =>
        reply(200, { secret: "SECRET", uri: "otpauth://totp/a@example.com" }),
      "/auth/mfa/enrol/totp/confirm": () => reply(200, { recovery_codes: ["one-two"] }),
      "/auth/addin/code": code,
    });
    render(<SignInDialog send={send} />);
    await signIn();
    await click("Use an authenticator app");
    await userEvent.type(screen.getByLabelText(APP_CODE), "123456");
    await click("Confirm");
    expect(await screen.findByText("one-two")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    await click("I've saved them");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(sentCode));
  });
});
