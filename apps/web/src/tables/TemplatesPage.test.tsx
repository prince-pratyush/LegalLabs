// @vitest-environment jsdom
import type { ReviewTableTemplate } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTableRoute, tableHash } from "./route.js";
import { TemplatesPage } from "./TemplatesPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 30_000 });

const ID = "0190a000-0000-7000-8000-00000000000a";

const TEMPLATE: ReviewTableTemplate = {
  id: ID,
  name: "Credit terms",
  description: "",
  instructions: "",
  categories: [],
  document_tags: [],
  columns: [],
  settings: {
    default_language: "en",
    date_format: "ISO",
    currency_display: "code",
    number_decimals: 0,
    null_display: "—",
    wrap_mode: "none",
  },
  status: "pending_approval",
  version: 1,
  parent_id: null,
  builtin: false,
  owner_id: ID,
  approved_by: null,
  rejected_note: null,
  my_access: "edit",
  created_at: "2026-11-21T00:00:00Z",
  updated_at: "2026-11-21T00:00:00Z",
};

function serve() {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = `${init.method ?? "GET"} ${url.replace("/api/v1", "").split("?")[0]}`;
      sent.push(route);
      if (route === "GET /review-table-templates") {
        return new Response(JSON.stringify({ items: [TEMPLATE], next_cursor: null }));
      }
      return new Response(JSON.stringify({ template: TEMPLATE }));
    }),
  );
  return sent;
}

describe("TemplatesPage", () => {
  it("lists templates and approves one that is waiting", async () => {
    const sent = serve();
    render(<TemplatesPage />);
    expect(await screen.findByText("Credit terms")).toBeTruthy();
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent).toContain(`POST /admin/review-table-templates/${ID}/approve`));
  });

  it("asks why before rejecting", async () => {
    const sent = serve();
    render(<TemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.change(await screen.findByLabelText("Tell the author why"), {
      target: { value: "Too vague" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject template" }));
    await waitFor(() => expect(sent).toContain(`POST /admin/review-table-templates/${ID}/reject`));
  });
});

describe("table routes with templates", () => {
  it("reads and writes the templates page and a template to start from", () => {
    expect(parseTableRoute("#/tables/templates")).toEqual({ page: "templates" });
    expect(parseTableRoute(`#/tables?template=${ID}`)).toEqual({
      page: "list",
      threadId: null,
      templateId: ID,
    });
    expect(tableHash({ page: "templates" })).toBe("#/tables/templates");
    expect(tableHash({ page: "list", threadId: null, templateId: ID })).toBe(
      `#/tables?template=${ID}`,
    );
    expect(parseTableRoute(`#/tables/${ID}`)).toEqual({ page: "table", tableId: ID });
  });
});
