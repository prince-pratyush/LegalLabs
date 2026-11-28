import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { fakeHost } from "./test/fake-host.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("App", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("signs in through the dialog, swapping its one-time code for a token", async () => {
    const fetchMock = vi.fn(async (path: string) =>
      path === "/auth/addin/exchange"
        ? ok({ token: "t".repeat(43), user_id: "u", workspace_id: "w" })
        : ok({ playbooks: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const openDialog = vi.fn(async () => JSON.stringify({ code: "c".repeat(43) }));
    render(
      <App host={fakeHost(["Text"]).host} origin="https://legal.test" openDialog={openDialog} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(openDialog).toHaveBeenCalledWith("https://legal.test/addin/auth.html");
    expect(await screen.findByRole("tab", { name: "Threads" })).toBeTruthy();
    expect(localStorage.getItem("legallabs.addin.token")).toBe("t".repeat(43));
  });

  it("stays signed out quietly when the dialog is closed", async () => {
    const { SignInError } = await import("@legallabs/addin");
    const openDialog = vi.fn(async () => {
      throw new SignInError("closed", "Sign-in was closed.");
    });
    render(
      <App host={fakeHost(["Text"]).host} origin="https://legal.test" openDialog={openDialog} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Sign-in was closed.")).toBeNull();
  });

  it("explains when Word can't make tracked changes", () => {
    render(
      <App
        host={fakeHost(["Text"], { tracked: false, comments: false }).host}
        origin="https://legal.test"
        openDialog={async () => ""}
      />,
    );
    expect(screen.getByText(/can't make tracked changes/)).toBeTruthy();
  });
});
