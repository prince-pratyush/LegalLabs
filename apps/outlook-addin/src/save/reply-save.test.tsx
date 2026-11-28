import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { fakeHost, ITEM } from "../test/fake-host.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const click = (name: string) => userEvent.click(screen.getByRole("button", { name }));

function serve(overrides: Record<string, () => Response> = {}) {
  const calls: { path: string; init?: RequestInit | undefined }[] = [];
  const routes: Record<string, () => Response> = {
    "/api/v1/addins/outlook/items": () =>
      reply({ thread_id: "t1", documents: [], skipped: [] }, 201),
    "/api/v1/threads/t1/messages": () => reply({ run_id: "r1" }, 202),
    "/api/v1/runs/r1/events": () => new Response("", { status: 200 }),
    "/api/v1/runs/r1": () => reply({ run: { status: "done", message_id: "m2" } }),
    "/api/v1/threads/t1": () =>
      reply({
        thread: {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: "We will serve it on Friday.",
              ungrounded: [[0, 27]],
              citations: [],
            },
          ],
        },
      }),
    "/api/v1/addins/outlook/drafts": () =>
      reply({ body_html: "<p>We will serve it on Friday.</p>" }),
    "/api/v1/vaults": () =>
      reply({
        vaults: [
          { id: "v1", name: "Deal", my_access: "edit" },
          { id: "v2", name: "Read only", my_access: "view" },
        ],
      }),
    "/api/v1/addins/outlook/save-to-vault": () =>
      reply(
        {
          folder_name: "2026-03-02 Lease notice",
          files: [{ name: "Lease notice.txt" }, { name: "Lease.pdf" }],
          skipped: [],
        },
        201,
      ),
    ...overrides,
  };
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return routes[path]?.() ?? reply({ code: "NOT_FOUND", message: "Not found." }, 404);
  });
  return { calls, sent: (path: string) => calls.find((c) => c.path === path)?.init };
}

const pane = (host = fakeHost().host) =>
  render(<App host={host} origin="https://legal.test" openDialog={async () => ""} />);

describe("draft replies and saving", () => {
  beforeEach(() => localStorage.setItem("legallabs.outlook.token", "t".repeat(43)));
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("opens Outlook's reply with the server's body only when asked to", async () => {
    const api = serve();
    const { host, replies } = fakeHost();
    pane(host);
    await click("Draft reply");
    const card = await screen.findByRole("region", { name: "Draft reply" });
    await vi.waitFor(() => expect(card.textContent).toContain(ITEM.from));
    expect(card.textContent).toContain("Re: Lease notice");
    expect(card.textContent).toContain("has no source");
    expect(replies).toEqual([]);

    await click("Create in Outlook");
    await screen.findByText(/Nothing is sent unless you send it/);
    expect(replies).toEqual(["<p>We will serve it on Friday.</p>"]);
    expect(JSON.parse(String(api.sent("/api/v1/addins/outlook/drafts")?.body))).toEqual({
      thread_id: "t1",
      message_id: "m2",
    });
  });

  const card = async (replyTo: () => Promise<string[] | null>) => {
    serve();
    pane(fakeHost(ITEM, { replyTo }).host);
    await click("Draft reply");
    return screen.findByRole("region", { name: "Draft reply" });
  };

  it("names the Reply-To address and warns when it isn't the sender", async () => {
    const shown = await card(async () => ["thief@evil.test"]);
    await vi.waitFor(() => expect(shown.querySelector("dd")?.textContent).toBe("thief@evil.test"));
    expect(shown.textContent).toContain(
      "This email asks for replies to go to thief@evil.test, not to its sender them@acme.test.",
    );
  });

  it("gives no To line when it can't tell where a reply will go", async () => {
    const shown = await card(async () => {
      throw new Error("no headers");
    });
    await screen.findByText("Check the recipients in Outlook before you send.");
    expect(shown.querySelector("dt")?.textContent).toBe("Subject");
    expect(shown.textContent).not.toContain(ITEM.from);
  });

  it("doesn't reply to whichever email was opened in the meantime", async () => {
    serve();
    const { host, replies, select } = fakeHost();
    pane(host);
    await click("Draft reply");
    await screen.findByRole("button", { name: "Create in Outlook" });
    select({ ...ITEM, itemId: "other", from: "someone@else.test" });
    await click("Create in Outlook");
    await screen.findByText(/Another email is open now/);
    expect(replies).toEqual([]);
  });

  it("shows why a reply is refused", async () => {
    serve({
      "/api/v1/addins/outlook/drafts": () =>
        reply({ code: "COPY_DISABLED", message: "A source doesn't allow copies." }, 403),
    });
    const { host, replies } = fakeHost();
    pane(host);
    await click("Draft reply");
    await userEvent.click(await screen.findByRole("button", { name: "Create in Outlook" }));
    await screen.findByText("A source doesn't allow copies.");
    expect(replies).toEqual([]);
  });

  it("saves the email to a vault the person can add to", async () => {
    const api = serve();
    pane();
    await click("Save to vault");
    const select = await screen.findByLabelText("Vault");
    expect(screen.queryByRole("option", { name: "Read only" })).toBeNull();
    await userEvent.selectOptions(select, "v1");
    await click("Save email");
    expect(await screen.findByText("Saved 2 files to Deal / 2026-03-02 Lease notice")).toBeTruthy();
    const form = api.sent("/api/v1/addins/outlook/save-to-vault")?.body as FormData;
    expect(form.get("vault_id")).toBe("v1");
    expect(form.getAll("attachment")).toHaveLength(1);
  });
});
