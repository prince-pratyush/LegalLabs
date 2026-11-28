import { SignInError } from "@legallabs/addin";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { fakeHost } from "./test/fake-host.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const TOKEN = "t".repeat(43);

const pane = (host = fakeHost().host, openDialog = async () => "") =>
  render(<App host={host} origin="https://legal.test" openDialog={openDialog} />);

describe("the Outlook pane", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("signs in through its own dialog and says it is the Outlook pane", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      ok({ token: TOKEN, user_id: "u", workspace_id: "w" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const openDialog = vi.fn(async () => JSON.stringify({ code: "c".repeat(43) }));
    pane(undefined, openDialog);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(openDialog).toHaveBeenCalledWith("https://legal.test/outlook/auth.html");
    expect(await screen.findByText("This email (+ 1 attachment)")).toBeTruthy();
    expect(localStorage.getItem("legallabs.outlook.token")).toBe(TOKEN);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/auth/addin/exchange");
    expect(new Headers(init?.headers).get("x-legallabs-client")).toBe("outlook");
  });

  it("stays signed out quietly when the dialog is closed", async () => {
    pane(undefined, async () => {
      throw new SignInError("closed", "Sign-in was closed.");
    });
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Sign-in was closed.")).toBeNull();
  });

  it("signs out, ending the session on the server", async () => {
    localStorage.setItem("legallabs.outlook.token", TOKEN);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    pane();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/auth/logout", expect.anything());
    expect(localStorage.getItem("legallabs.outlook.token")).toBeNull();
  });

  it("asks for an email to be opened when none is", () => {
    localStorage.setItem("legallabs.outlook.token", TOKEN);
    pane(fakeHost(null).host);
    expect(screen.getByText("Open an email to ask about it.")).toBeTruthy();
  });
});
