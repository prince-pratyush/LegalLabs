import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestApp } from "./GuestApp.js";
import { GuestAccept, GuestSignIn, tokenFrom } from "./GuestEntry.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function serve(answer: (url: string) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return answer(url);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const SUMMARY = {
  space_id: "s1",
  space_name: "Acme deal",
  party_id: "p1",
  party_name: "Other LLP",
  connection_status: "resolved",
  can_approve: false,
  expires_at: "2027-01-01T00:00:00.000Z",
};

describe("guest screens", () => {
  it("reads the token from the fragment", () => {
    expect(tokenFrom("#token=abc_-1")).toBe("abc_-1");
    expect(tokenFrom("")).toBe("");
  });

  it("previews an invitation and accepts it", async () => {
    window.location.hash = "#token=tok";
    const calls = serve((url) =>
      url.endsWith("preview")
        ? json({
            email: "a@other.test",
            space_name: "Acme deal",
            workspace_name: "Firm",
            party_name: "Other LLP",
            expires_at: "2027-01-01T00:00:00.000Z",
          })
        : json({ workspace: "firm", space_id: "s1" }),
    );
    const joined = vi.fn();
    render(<GuestAccept onJoined={joined} />);
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() =>
      expect(joined).toHaveBeenCalledWith({ workspace: "firm", email: "a@other.test" }),
    );
    expect(calls.at(-1)?.body).toEqual({ token: "tok", name: "Ana" });
  });

  it("says when an invitation is spent", async () => {
    window.location.hash = "#token=tok";
    serve(() => json({ code: "INVITE_INVALID", message: "No longer valid." }, 404));
    render(<GuestAccept onJoined={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("No longer valid.");
  });

  it("signs in with an emailed code", async () => {
    const calls = serve((url) =>
      url.endsWith("/code") ? new Response(null, { status: 204 }) : json({}),
    );
    const signedIn = vi.fn();
    render(
      <GuestSignIn prefill={{ workspace: "firm", email: "a@other.test" }} onSignedIn={signedIn} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    fireEvent.change(await screen.findByLabelText("8-digit code"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalled());
    expect(calls.map((c) => c.url)).toEqual(["/guest/login/code", "/guest/login/verify"]);
  });

  it("shows only what the guest endpoints return", async () => {
    window.location.hash = "#/guest/spaces/s1";
    const calls = serve((url) =>
      url.endsWith("/guest/spaces")
        ? json({ spaces: [SUMMARY] })
        : json({
            space: { id: "s1", name: "Acme deal", workspace_name: "Firm" },
            party: { id: "p1", name: "Other LLP" },
            resources: [
              { id: "r1", resource_type: "agent", name: "NDA first pass", access: "run" },
            ],
          }),
    );
    render(<GuestApp onSignOut={() => {}} />);
    expect(await screen.findByText("NDA first pass")).toBeTruthy();
    expect(screen.getByText("Agent · Can run")).toBeTruthy();
    expect(screen.getByText("Guest access · provided by Firm")).toBeTruthy();
    expect(calls.every((c) => c.url.startsWith("/api/v1/guest/"))).toBe(true);
  });

  it("asks for nothing inside a Space before approval, and lets the approver approve", async () => {
    window.location.hash = "#/guest/spaces/s1";
    const calls = serve((url) =>
      url.endsWith("/approve")
        ? json({ status: "resolved" })
        : json({
            spaces: [{ ...SUMMARY, connection_status: "action_required", can_approve: true }],
          }),
    );
    render(<GuestApp onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve connection" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true));
    expect(calls.some((c) => c.url === "/api/v1/guest/spaces/s1")).toBe(false);
  });
});
