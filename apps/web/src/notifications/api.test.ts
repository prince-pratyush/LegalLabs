import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import { memoryApi, stylesApi } from "../settings/api.js";
import { notificationsApi } from "./api.js";

function stub(status: number, body: unknown) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("notifications client", () => {
  it("builds the list query from the filters, and only sends what is set", async () => {
    const fetch = stub(200, {
      items: [],
      unread_count: 0,
      action_required_count: 0,
      next_cursor: null,
    });
    await notificationsApi.list({ tab: "all", state: "unread_read" });
    await notificationsApi.list({
      tab: "action_required",
      state: "archived",
      category: "vault",
      cursor: "c 1",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/notifications?tab=all&state=unread_read");
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "/api/v1/notifications?tab=action_required&state=archived&category=vault&cursor=c+1",
    );
  });

  it("sends JSON for patch and act, and tolerates 204", async () => {
    const fetch = stub(204, null);
    await expect(notificationsApi.readAll()).resolves.toBeNull();
    await notificationsApi.patch("a/b", { archived: true });
    await notificationsApi.act("n1", "approve_plan");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v1/notifications/a%2Fb");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"archived":true}');
    expect(fetch.mock.calls[2]?.[1]?.body).toBe('{"action":"approve_plan"}');
  });

  it("turns an error body into an ApiError with the server's words", async () => {
    stub(403, { code: "NOT_ENABLED", message: "Not enabled." });
    const err = await memoryApi.settings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "NOT_ENABLED", message: "Not enabled." });
  });
});

describe("memory and style clients", () => {
  it("asks for confirmation to delete everything", async () => {
    const fetch = stub(204, null);
    await memoryApi.removeAll();
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-confirm": "all" });
  });

  it("uploads a CSV and a style sample as multipart, with no JSON content type", async () => {
    const fetch = stub(200, { import_id: "i", rows: [], would_exceed_cap: 0 });
    await memoryApi.parseImport(new File(["text\nA"], "m.csv", { type: "text/csv" }));
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.body).toBeInstanceOf(FormData);
    expect(init?.headers).not.toHaveProperty("content-type");
    await stylesApi.createFromSample("Memo", new File(["x"], "memo.pdf"));
    const form = fetch.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("name")).toBe("Memo");
    expect((form.get("sample") as File).name).toBe("memo.pdf");
  });
});
