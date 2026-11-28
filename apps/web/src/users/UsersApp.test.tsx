import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App.js";
import { serve, signedIn } from "../testing.js";
import { parseUsersRoute, usersHash } from "./route.js";
import { UsersApp } from "./UsersApp.js";

const USER_ROLE = "0190a000-0000-7000-8000-0000000000b1";
const ADMIN_ROLE = "0190a000-0000-7000-8000-0000000000b2";
const GROUP = "0190a000-0000-7000-8000-0000000000c1";
const BO = "0190a000-0000-7000-8000-0000000000d1";

const person = (over: object = {}) => ({
  id: BO,
  email: "bo@acme.test",
  name: "",
  status: "active",
  role_id: USER_ROLE,
  role_name: "User",
  group_ids: [],
  source: "manual",
  sso_linked: false,
  role_from_group: false,
  is_self: false,
  ...over,
});

type Reply = () => [number, unknown];
const ok =
  (body: unknown): Reply =>
  () => [200, body];

const routes = (people: object[], extra: Record<string, Reply> = {}, directory: object = {}) => ({
  "GET /api/v1/admin/users": ok({
    items: people,
    scim_enabled: false,
    sso_enabled: false,
    mail_configured: false,
    ...directory,
  }),
  "GET /api/v1/admin/roles": ok({
    items: [
      { id: ADMIN_ROLE, name: "Admin", builtin: true, permissions: ["*"], admin: true },
      { id: USER_ROLE, name: "User", builtin: true, permissions: [], admin: false },
    ],
  }),
  "GET /api/v1/admin/groups": ok({ items: [{ id: GROUP, name: "Deal team", manageable: true }] }),
  ...extra,
});

const show = () => render(<UsersApp onLeave={() => {}} />);
const bodyOf = (sent: { route: string; body: unknown }[], route: string) =>
  sent.filter((s) => s.route === route).at(-1)?.body;

describe("users route", () => {
  it("is #/admin/users and nothing else", () => {
    expect(parseUsersRoute(usersHash())).toBe(true);
    expect(parseUsersRoute("#/admin/models")).toBe(false);
  });
});

describe("inviting", () => {
  it("offers only non-administrator roles and shows a link once", async () => {
    const sent = serve(
      routes([person()], {
        "POST /api/v1/admin/users/invite": ok({
          invited: [
            {
              id: "x",
              email: "cy@acme.test",
              delivery: "link",
              link: "https://app.test/#/auth/invite?token=abc",
            },
          ],
          skipped: [{ email: "bo@acme.test", reason: "exists" }],
        }),
      }),
    );
    show();
    const form = await screen.findByRole("region", { name: "Invite people" });
    const role = within(form).getByLabelText("Role") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).toEqual(["User"]);
    fireEvent.change(within(form).getByLabelText("Email addresses"), {
      target: { value: "cy@acme.test,\nbo@acme.test" },
    });
    fireEvent.click(within(form).getByRole("checkbox", { name: "Add to Deal team" }));
    fireEvent.click(within(form).getByRole("button", { name: "Invite" }));
    const link = (await screen.findByLabelText("Link for cy@acme.test")) as HTMLInputElement;
    expect(link.value).toBe("https://app.test/#/auth/invite?token=abc");
    expect(screen.getByText("bo@acme.test is already in the workspace.")).toBeTruthy();
    expect(bodyOf(sent, "POST /api/v1/admin/users/invite")).toEqual({
      emails: ["cy@acme.test", "bo@acme.test"],
      role_id: USER_ROLE,
      group_ids: [GROUP],
    });
  });

  it("is switched off while an identity provider manages users", async () => {
    serve(routes([person({ source: "scim" })], {}, { scim_enabled: true }));
    show();
    expect(await screen.findByText("Users are managed by your identity provider.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    // Their status belongs to the provider too.
    expect(screen.queryByRole("button", { name: "Deactivate bo@acme.test" })).toBeNull();
  });
});

describe("managing people", () => {
  it("changes a role, deactivates after asking, and resends an invitation", async () => {
    const CY = "0190a000-0000-7000-8000-0000000000d2";
    const sent = serve(
      routes([person(), person({ id: CY, email: "cy@acme.test", status: "invited" })], {
        [`PATCH /api/v1/admin/users/${BO}`]: ok(person()),
        [`POST /api/v1/admin/users/${CY}/invite`]: ok({
          id: CY,
          email: "cy@acme.test",
          delivery: "email",
        }),
      }),
    );
    show();
    fireEvent.change(await screen.findByLabelText("Role of bo@acme.test"), {
      target: { value: ADMIN_ROLE },
    });
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Change role" }),
    );
    await waitFor(() =>
      expect(bodyOf(sent, `PATCH /api/v1/admin/users/${BO}`)).toEqual({ role_id: ADMIN_ROLE }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deactivate bo@acme.test" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Deactivate" }),
    );
    await waitFor(() =>
      expect(bodyOf(sent, `PATCH /api/v1/admin/users/${BO}`)).toEqual({ status: "suspended" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resend invitation to cy@acme.test" }));
    expect(await screen.findByText("Invitation emailed to cy@acme.test.")).toBeTruthy();
  });

  it("shows the server's reason when a change is refused", async () => {
    serve(
      routes([person({ status: "suspended" })], {
        [`PATCH /api/v1/admin/users/${BO}`]: () => [
          409,
          { code: "LAST_ADMIN", message: "A workspace needs at least one administrator." },
        ],
      }),
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reactivate bo@acme.test" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A workspace needs at least one administrator.",
    );
  });

  it("asks for the second factor when a change needs it, then makes the change", async () => {
    let fresh = false;
    const sent = serve(
      routes([person({ status: "suspended" })], {
        [`PATCH /api/v1/admin/users/${BO}`]: () =>
          fresh
            ? [200, person()]
            : [403, { code: "MFA_REQUIRED", message: "Confirm with your second factor." }],
        "GET /api/v1/mfa": ok({ totp: true, passkeys: [] }),
        "POST /api/v1/mfa/step-up/totp": () => {
          fresh = true;
          return [200, {}];
        },
      }),
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reactivate bo@acme.test" }));
    const prompt = await screen.findByRole("form", { name: "Confirm it's you" });
    fireEvent.change(within(prompt).getByLabelText("Code from your authenticator app"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(prompt).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Confirm it's you" })).toBeNull(),
    );
    expect(sent.filter((s) => s.route === `PATCH /api/v1/admin/users/${BO}`)).toHaveLength(2);
  });

  it("unlinks someone from single sign-on after asking", async () => {
    const sent = serve(
      routes([person({ sso_linked: true })], {
        [`DELETE /api/v1/admin/users/${BO}/identities`]: ok(person()),
      }),
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Unlink single sign-on for bo@acme.test" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unlink" }),
    );
    await waitFor(() =>
      expect(sent.some((s) => s.route === `DELETE /api/v1/admin/users/${BO}/identities`)).toBe(
        true,
      ),
    );
  });

  it("leaves your own account alone", async () => {
    serve(routes([person({ is_self: true })]));
    show();
    expect(await screen.findByText("You")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deactivate bo@acme.test" })).toBeNull();
    expect(screen.queryByLabelText("Role of bo@acme.test")).toBeNull();
  });
});

describe("accepting an invitation", () => {
  const open = () => window.history.replaceState(null, "", "/#/auth/invite?token=tok_abc");

  it("takes the token off the address, sets a password and goes to sign-in", async () => {
    open();
    const sent = serve({
      ...signedIn,
      "GET /auth/session": () => [401, { error: "unauthenticated" }],
      "POST /auth/invite/accept": () => [200, { workspace: "acme", email: "cy@acme.test" }],
      "POST /auth/logout": () => [204, null],
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Choose your password" });
    expect(window.location.hash).toBe("");
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.change(screen.getByLabelText("Repeat the password"), {
      target: { value: "something else!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The two passwords differ.");
    fireEvent.change(screen.getByLabelText("Repeat the password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect((screen.getByLabelText("Workspace") as HTMLInputElement).value).toBe("acme");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("cy@acme.test");
    expect(bodyOf(sent, "POST /auth/invite/accept")).toEqual({
      token: "tok_abc",
      password: "a long enough password",
    });
  });

  it("says when the link no longer works", async () => {
    open();
    serve({
      "GET /auth/session": () => [401, { error: "unauthenticated" }],
      "POST /auth/invite/accept": () => [
        400,
        { code: "INVITE_INVALID", message: "This link has been used or has expired." },
      ],
    });
    render(<App />);
    for (const label of ["New password", "Repeat the password"]) {
      fireEvent.change(await screen.findByLabelText(label), {
        target: { value: "a long enough password" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This link has been used or has expired.",
    );
  });
});
