import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignInDialog } from "./SignInDialog.js";

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

describe("SignInDialog", () => {
  it("signs in, then sends the pane a one-time code and never the password", async () => {
    const send = vi.fn();
    const request = vi.fn(async (path: string) =>
      path === "/auth/login" ? reply(200) : reply(200, { code: "abc" }),
    );
    render(<SignInDialog send={send} request={request} session={async () => reply(401)} />);
    await userEvent.type(screen.getByLabelText("Workspace"), "acme");
    await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "pw-for-tests");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(send).toHaveBeenCalledWith(JSON.stringify({ code: "abc" }));
    expect(JSON.stringify(send.mock.calls)).not.toContain("pw-for-tests");
  });

  it("skips the form when already signed in on the web", async () => {
    const send = vi.fn();
    render(
      <SignInDialog
        send={send}
        request={async () => reply(200, { code: "xyz" })}
        session={async () => reply(200)}
      />,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(JSON.stringify({ code: "xyz" })));
  });

  it("says when the details don't match", async () => {
    render(
      <SignInDialog
        send={vi.fn()}
        request={async () => reply(401)}
        session={async () => reply(401)}
      />,
    );
    await userEvent.type(screen.getByLabelText("Workspace"), "acme");
    await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/don't match/)).toBeTruthy();
  });
});
