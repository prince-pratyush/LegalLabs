import { describe, expect, it } from "vitest";
import { rowsSql, UnknownColumn } from "./query.js";

const T = "019a5b6e-0000-7000-8000-0000000000aa";
const DATE = "019a5b6e-0000-7000-8000-0000000000d1";
const LAW = "019a5b6e-0000-7000-8000-0000000000d2";
const columns = new Map([
  [DATE, "date" as const],
  [LAW, "classify" as const],
]);

describe("rowsSql", () => {
  it("lists rows in source order by default", () => {
    const { sql, params } = rowsSql({ tableId: T, columns, limit: 200 });
    expect(sql).toMatch(/order by r\.ordinal limit \$2/);
    expect(params).toEqual([T, 200]);
  });

  it("sorts dates by the typed value with nulls last (RVT-005)", () => {
    const { sql } = rowsSql({ tableId: T, columns, sort: { column_id: DATE, direction: "desc" } });
    expect(sql).toContain(
      "case when s.status = 'done' then s.value_typed->>'iso' end desc nulls last",
    );
  });

  it("ANDs conditions and keeps hidden rows out of a filtered list", () => {
    const { sql, params } = rowsSql({
      tableId: T,
      columns,
      filter: { conditions: [{ column_id: LAW, flag: ["red"], verified: false }] },
    });
    expect(sql).toContain("c.flag_color = any($3::text[])");
    expect(sql).toContain("c.verified_at is null");
    expect(sql).toMatch(/not exists \(\s+select 1 from unnest/);
    expect(params).toEqual([T, LAW, ["red"]]);
  });

  it("matches text literally, so % is not a wildcard", () => {
    const { params } = rowsSql({
      tableId: T,
      columns,
      filter: { conditions: [{ column_id: LAW, contains: "50%_off" }] },
    });
    expect(params).toContain("%50\\%\\_off%");
  });

  it("refuses a column from another table", () => {
    const other = "019a5b6e-0000-7000-8000-0000000000ff";
    expect(() =>
      rowsSql({ tableId: T, columns, sort: { column_id: other, direction: "asc" } }),
    ).toThrow(UnknownColumn);
  });
});
