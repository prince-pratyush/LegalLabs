import { describe, expect, it } from "vitest";
import { docBucket, filterRows, groupRows, type HistoryRow, NO_FILTERS } from "./history.js";

const row = (id: string, at: string, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  id,
  title: `Thread ${id}`,
  type: "assist",
  documentCount: 1,
  lastActivityAt: at,
  status: "done",
  favourite: false,
  restricted: false,
  ...extra,
});

const NOW = new Date("2026-11-14T12:00:00Z");

describe("docBucket", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [2, "2-10"],
    [10, "2-10"],
    [11, "11-100"],
    [100, "11-100"],
    [101, ">100"],
  ])("%i is %s", (n, bucket) => expect(docBucket(n)).toBe(bucket));
});

describe("groupRows", () => {
  const rows = [
    row("a", "2026-09-02T10:00:00Z"),
    row("b", "2026-11-14T09:00:00Z"),
    row("c", "2026-10-20T10:00:00Z"),
    row("d", "2026-11-01T10:00:00Z"),
  ];

  it("groups by month, newest first", () => {
    const groups = groupRows(rows, "month", NOW);
    expect(groups.map((g) => g.key)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("calls today's day Today", () => {
    expect(groupRows(rows, "day", NOW)[0]?.key).toBe("Today");
  });

  it("starts weeks on Monday", () => {
    // 2026-11-14 is a Saturday, so its week starts on Monday the 9th.
    expect(groupRows([row("b", "2026-11-14T09:00:00Z")], "week", NOW)[0]?.key).toBe(
      "Week of 2026-11-09",
    );
  });

  it("sorts by real time across offsets", () => {
    const mixed = [row("a", "2026-11-14T10:00:00+10:00"), row("b", "2026-11-14T01:00:00Z")];
    // 10:00 +10:00 is 00:00 UTC, so b is newer although its string sorts lower.
    expect(groupRows(mixed, "none", NOW)[0]?.rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("puts a bad date last in its own group instead of throwing", () => {
    const rows2 = [row("bad", "not a date"), row("b", "2026-11-14T09:00:00Z")];
    const groups = groupRows(rows2, "month", NOW);
    expect(groups.map((g) => g.key)).toEqual(["2026-11", "Unknown date"]);
    expect(groupRows(rows2, "none", NOW)[0]?.rows.at(-1)?.id).toBe("bad");
  });

  it("groups by type", () => {
    const typed = [
      row("a", "2026-11-01T00:00:00Z", { type: "deep_analysis" }),
      row("b", NOW.toISOString()),
    ];
    expect(groupRows(typed, "type", NOW).map((g) => g.key)).toEqual(["Assist", "Deep analysis"]);
  });
});

describe("filterRows", () => {
  it("never matches a restricted title", () => {
    const rows = [row("a", NOW.toISOString(), { restricted: true, title: "Secret indemnity" })];
    expect(filterRows(rows, { ...NO_FILTERS, search: "indemnity" }, NOW)).toEqual([]);
  });

  it("combines type, documents and date", () => {
    const rows = [
      row("a", "2026-11-13T00:00:00Z", { type: "deep_analysis", documentCount: 40 }),
      row("b", "2026-11-13T00:00:00Z", { type: "deep_analysis", documentCount: 4 }),
      row("c", "2026-01-01T00:00:00Z", { type: "deep_analysis", documentCount: 40 }),
    ];
    const found = filterRows(
      rows,
      { ...NO_FILTERS, type: "deep_analysis", docs: "11-100", date: "30d" },
      NOW,
    );
    expect(found.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps favourites only when asked", () => {
    const rows = [row("a", NOW.toISOString(), { favourite: true }), row("b", NOW.toISOString())];
    expect(filterRows(rows, { ...NO_FILTERS, favouritesOnly: true }, NOW)).toHaveLength(1);
  });
});
