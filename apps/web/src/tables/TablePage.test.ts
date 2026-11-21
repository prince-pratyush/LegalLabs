import { describe, expect, it } from "vitest";
import { runBody } from "./TablePage.js";

const SORT = { column_id: "019a5b6e-0000-7000-8000-0000000000d1", direction: "desc" } as const;
const FILTER = { conditions: [{ column_id: SORT.column_id, flag: ["red" as const] }] };

describe("runBody", () => {
  it("sends the current sort and filter with a dry run", () => {
    expect(runBody({ scope: "dry_run", include_verified: false }, SORT, FILTER)).toEqual({
      scope: "dry_run",
      include_verified: false,
      include_dependents: false,
      sort: SORT,
      filter: FILTER,
    });
  });

  it("leaves the view out of a full run and of run remaining", () => {
    expect(runBody({ scope: "all", include_verified: true }, SORT, FILTER)).toEqual({
      scope: "all",
      include_verified: true,
      include_dependents: false,
    });
    expect(runBody("pending", SORT, FILTER)).toEqual({
      scope: "pending",
      include_verified: false,
      include_dependents: false,
    });
  });

  it("asks for the columns that use this one to follow when chosen", () => {
    expect(
      runBody({ scope: "all", include_verified: false, include_dependents: true }, null, {
        conditions: [],
      }),
    ).toEqual({ scope: "all", include_verified: false, include_dependents: true });
  });

  it("sends no empty filter", () => {
    expect(
      runBody({ scope: "dry_run", include_verified: false }, null, { conditions: [] }),
    ).toEqual({ scope: "dry_run", include_verified: false, include_dependents: false });
  });
});
