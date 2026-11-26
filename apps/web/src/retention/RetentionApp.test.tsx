import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { serve } from "../testing.js";
import { RetentionApp } from "./RetentionApp.js";
import { parseRetentionRoute, type RetentionTab, retentionHash } from "./route.js";

const BASE = "/api/v1/admin/retention";
const ok = (body: unknown) => () => [200, body] as [number, unknown];
const show = (tab: RetentionTab) => {
  window.location.hash = retentionHash(tab);
  render(<RetentionApp onLeave={() => {}} />);
};
const policies = ok({ workspace: null, vaults: [], matters: [], exemptions: [] });
const estimate = (total: number) =>
  ok({ threads: total, documents: 0, reviewTables: 0, total, held: 0, firstDeletionAt: null });
const save = () => screen.getByRole("button", { name: "Save policy" }) as HTMLButtonElement;
const hours = (value: string) =>
  fireEvent.change(screen.getByLabelText("Keep for (hours)"), { target: { value } });

describe("retention routes", () => {
  it("reads the tab from the address", () => {
    expect(parseRetentionRoute("#/admin/retention")).toEqual({ tab: "policies" });
    expect(parseRetentionRoute("#/admin/retention/bin")).toEqual({ tab: "bin" });
    expect(parseRetentionRoute("#/admin/models")).toBeNull();
  });
});

describe("policies", () => {
  it("saves only after an estimate for what is on the form, and answers step-up", async () => {
    let fresh = false;
    const sent = serve({
      [`GET ${BASE}`]: policies,
      [`GET ${BASE}/estimate?scope=workspace&hours=48`]: estimate(2),
      [`PUT ${BASE}/policy`]: () =>
        fresh
          ? [200, {}]
          : [403, { code: "MFA_REQUIRED", message: "Confirm with your second factor." }],
      "GET /api/v1/mfa": ok({ totp: true, passkeys: [] }),
      "POST /api/v1/mfa/step-up/totp": (body) => {
        if ((body as { code: string }).code !== "123456") return [401, { error: "invalid_code" }];
        fresh = true;
        return [200, { mfa_at: "2026-11-26T00:00:00Z" }];
      },
    });
    show("policies");
    await screen.findByText(/strictest scope wins/);
    hours("48");
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    await screen.findByText("2 items would be deleted within 24 hours.");
    hours("72");
    expect(save().disabled).toBe(true);
    hours("48");
    fireEvent.click(save());

    const code = await screen.findByLabelText("Code from your authenticator app");
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("didn't work");
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Policy saved.");
    const puts = sent.filter((s) => s.route === `PUT ${BASE}/policy`);
    expect(puts.map((p) => p.body)).toEqual([
      { scope: "workspace", hours: 48 },
      { scope: "workspace", hours: 48 },
    ]);
  });

  it("asks for the workspace slug when over 1,000 items would go", async () => {
    const sent = serve({
      [`GET ${BASE}`]: policies,
      [`GET ${BASE}/estimate?scope=workspace&hours=3`]: estimate(1001),
      [`PUT ${BASE}/policy`]: ok({}),
    });
    show("policies");
    await screen.findByText(/strictest scope wins/);
    hours("3");
    expect(screen.getByText(/runs still in progress may fail/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    const slug = await screen.findByLabelText("Type the workspace slug to confirm");
    expect(save().disabled).toBe(true);
    fireEvent.change(slug, { target: { value: "acme" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(sent.find((s) => s.route === `PUT ${BASE}/policy`)?.body).toEqual({
        scope: "workspace",
        hours: 3,
        confirm_slug: "acme",
      }),
    );
  });
});

describe("holds and bin", () => {
  it("places a hold on a file with a reason", async () => {
    const sent = serve({
      [`GET ${BASE}/holds`]: ok({ holds: [] }),
      "GET /api/v1/admin/vaults": ok({ vaults: [] }),
      "GET /api/v1/matters": ok({ items: [] }),
      [`PUT ${BASE}/holds`]: ok({ changed: true }),
    });
    show("holds");
    await screen.findByText("Nothing is under a legal hold.");
    fireEvent.change(screen.getByLabelText("What to hold"), { target: { value: "document" } });
    fireEvent.change(screen.getByLabelText("File ID"), { target: { value: "d1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Dispute" } });
    fireEvent.click(screen.getByRole("button", { name: "Place hold" }));
    await waitFor(() =>
      expect(sent.find((s) => s.route === `PUT ${BASE}/holds`)?.body).toEqual({
        object_type: "document",
        object_id: "d1",
        held: true,
        reason: "Dispute",
      }),
    );
  });

  it("restores from the bin and shows why it can't", async () => {
    const item = {
      id: "b1",
      objectType: "document",
      objectId: "d1",
      label: "msa.pdf",
      deletedAt: "2026-11-20T00:00:00Z",
      restorableUntil: "2999-01-01T00:00:00Z",
      restoredAt: null,
      purgedAt: null,
    };
    serve({
      [`GET ${BASE}/bin`]: ok({ items: [item] }),
      [`POST ${BASE}/bin/b1/restore`]: () => [
        409,
        { code: "VAULT_DELETED", message: "Restore the vault first." },
      ],
    });
    show("bin");
    fireEvent.click(await screen.findByRole("button", { name: "Restore msa.pdf" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Restore the vault first.");
  });
});
