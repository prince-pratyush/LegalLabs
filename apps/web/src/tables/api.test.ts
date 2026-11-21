import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, FALLBACK } from "../api.js";
import { messageOf, rowsSearch, tableApi } from "./api.js";
import { parseTableRoute, tableHash } from "./route.js";

afterEach(() => vi.unstubAllGlobals());

const ID = "0190a000-0000-7000-8000-00000000000a";

describe("table routes", () => {
  it("round-trips the list, a thread start and a table", () => {
    for (const route of [
      { page: "list", threadId: null, templateId: null },
      { page: "list", threadId: "t1", templateId: null },
      { page: "table", tableId: ID },
    ] as const) {
      expect(parseTableRoute(tableHash(route))).toEqual(route);
    }
    expect(parseTableRoute("#/vaults")).toBeNull();
  });
});

describe("rowsSearch", () => {
  it("sends the filter as JSON and the sort as column:direction", () => {
    const search = rowsSearch({
      cursor: "200",
      filter: { conditions: [{ column_id: ID, verified: true }] },
      sort: { column_id: ID, direction: "desc" },
    });
    const params = new URLSearchParams(search.slice(1));
    expect(params.get("cursor")).toBe("200");
    expect(JSON.parse(params.get("filter") ?? "")).toEqual({
      conditions: [{ column_id: ID, verified: true }],
    });
    expect(params.get("sort")).toBe(`${ID}:desc`);
    expect(rowsSearch({ filter: { conditions: [] } })).toBe("");
  });
});

describe("tableApi", () => {
  it("lists starred tables from the items field", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [{ id: ID }], next_cursor: null }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await tableApi.list(true)).toEqual([{ id: ID }]);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/review-tables?filter[starred]=true");
  });

  it("turns a locked-cell refusal into words", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "CELL_LOCKED", message: "locked" }), { status: 409 }),
        ),
    );
    const error = await tableApi.patchCell(ID, ID, { verified: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("That cell is locked. Unlock it to change it.");
  });

  it("states limits from the shared contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "EXPORT_TOO_LARGE" }), { status: 409 }),
        ),
    );
    const error = await tableApi.cell(ID, ID).catch((e: unknown) => e);
    expect((error as ApiError).message).toMatch(/up to 2,000 cells/);
    expect(messageOf(new Error("boom"))).toBe(FALLBACK);
  });

  it("reads the export filename from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("a,b", {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="DD table.csv"' },
        }),
      ),
    );
    const file = await tableApi.export(ID, {
      format: "csv",
      include_reasoning: false,
      include_citations: false,
      highlight_verified: false,
      highlight_flagged: false,
      classify_colors: false,
    });
    expect(file.filename).toBe("DD table.csv");
  });
});
