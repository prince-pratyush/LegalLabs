import { NO_FILTERS } from "@legallabs/ui";
import { afterEach, describe, expect, it } from "vitest";
import { historyParams } from "./api.js";
import { historyQuery } from "./history/query.js";
import { parseRoute } from "./router.js";
import { toBlocks } from "./thread/compose.js";
import { reduceRun, startRun } from "./thread/run-state.js";

const DOC = "0190a000-0000-7000-8000-000000000001";

afterEach(() => {
  window.location.hash = "";
});

describe("parseRoute", () => {
  it("knows each screen", () => {
    expect(parseRoute("")).toEqual({ name: "new" });
    expect(parseRoute("#/")).toEqual({ name: "new" });
    expect(parseRoute("#/history")).toEqual({ name: "history" });
    expect(parseRoute("#/t/abc")).toEqual({ name: "thread", id: "abc" });
    expect(parseRoute("#/nowhere")).toEqual({ name: "missing" });
    expect(parseRoute("#/history?q=cap")).toEqual({ name: "history" });
    expect(parseRoute("#/t/abc?from=share")).toEqual({ name: "thread", id: "abc" });
  });

  it("leaves vault routes and document paths to their own screens", () => {
    // Vaults own #/vaults; the viewer opens on a real /d/ path, not a hash.
    expect(parseRoute("#/vaults")).toEqual({ name: "missing" });
    expect(parseRoute(`#/d/${DOC}/v/2?p=4`)).toEqual({ name: "missing" });
  });
});

describe("history filters", () => {
  const now = new Date("2026-11-14T00:00:00.000Z");

  it("sends only the filters that are set", () => {
    expect(historyParams(historyQuery(NO_FILTERS, now) ?? {})).toBe("");
  });

  it("maps every filter to the server's names", () => {
    const query = historyQuery(
      {
        search: " cap ",
        type: "deep_analysis",
        date: "7d",
        docs: "2-10",
        favouritesOnly: true,
      },
      now,
    );
    expect(historyParams({ ...query, cursor: "c1" })).toBe(
      "?q=cap&type=deep_analysis&from=2026-11-07T00%3A00%3A00.000Z&docs=2-10&favourites=true&cursor=c1",
    );
  });

  it("asks nothing for drafts, which the endpoint doesn't list", () => {
    expect(historyQuery({ ...NO_FILTERS, type: "draft" }, now)).toBeNull();
  });
});

describe("toBlocks", () => {
  const lease = { type: "document" as const, id: DOC, label: "Lease" };
  const lease2 = { type: "document" as const, id: "d2", label: "Lease 2" };

  it("keeps a plain question as text", () => {
    expect(toBlocks("What is the cap?", [])).toBe("What is the cap?");
    expect(toBlocks("No mention left", [lease])).toBe("No mention left");
  });

  it("prefers the longest label", () => {
    expect(toBlocks("Compare @Lease 2 and @Lease", [lease, lease2])).toEqual([
      { type: "text", text: "Compare " },
      { type: "mention", ref_type: "document", ref_id: "d2", label: "Lease 2" },
      { type: "text", text: " and " },
      { type: "mention", ref_type: "document", ref_id: DOC, label: "Lease" },
    ]);
  });
});

describe("reduceRun", () => {
  it("keeps the live answer, steps and the end state", () => {
    let run = startRun("r");
    run = reduceRun(run, { type: "token", seq: 1, message_id: "m", delta: "A[[c:1]]" });
    run = reduceRun(run, {
      type: "step",
      seq: 2,
      step_id: "s",
      kind: "read",
      status: "finished",
      title: "Read",
      cost_usd: 0.01,
    });
    run = reduceRun(run, {
      type: "error",
      seq: 3,
      code: "X",
      message: "Broke",
      retryable: false,
    });
    expect(run.text).toBe("A[[c:1]]");
    expect(run.steps).toEqual([{ id: "s", title: "Read", status: "done", costUsd: 0.01 }]);
    expect(run.finished).toBe(true);
    expect(run.error?.message).toBe("Broke");
  });

  it("never links an unverified citation", () => {
    const run = reduceRun(startRun("r"), {
      type: "citation",
      seq: 1,
      citation: {
        message_id: "m",
        ordinal: 1,
        kind: "document",
        verified: "mismatch",
        quote: "q",
        open_url: "/d/x/v/1?p=1",
      },
    });
    expect(run.citations[0]?.openUrl).toBeNull();
  });
});
