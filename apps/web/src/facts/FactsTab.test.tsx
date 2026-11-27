import type { Fact, FactExtraction } from "@legallabs/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseSpaceRoute } from "../spaces/route.js";
import { DOC, FakeSource, type Handler, RUN_ID, serve, VERSION } from "../testing.js";
import { FactsTab, factDate, grouped } from "./FactsTab.js";

const SPACE = "0190a000-0000-7000-8000-000000000010";
const BASE = `/api/v1/apps/chronology/spaces/${SPACE}`;
const QUOTE = "delivered the goods on 3 March 2021";

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "f1",
  space_id: SPACE,
  text: "The supplier <img src=x onerror=alert(1)> delivered.",
  event_date: "2021-03-03",
  event_date_end: null,
  date_precision: "day",
  status: "extracted",
  source: "extracted",
  version_no: 1,
  entity_ids: ["e1"],
  issue_ids: [],
  citations: [
    {
      citation_id: "c1",
      document_id: DOC,
      version_id: VERSION,
      document_name: "letter.txt",
      page_no: 1,
      char_from: 13,
      char_to: 48,
      quote: QUOTE,
      verified: "ok",
    },
  ],
  created_by: "u",
  created_at: "2026-11-27T00:00:00.000Z",
  updated_at: "2026-11-27T00:00:00.000Z",
  ...over,
});

const extraction = (over: Partial<FactExtraction> = {}): FactExtraction => ({
  run_id: RUN_ID,
  space_id: SPACE,
  state: "partial",
  complete: false,
  failure: null,
  documents_total: 2,
  documents_read: 1,
  documents_partial: 0,
  documents_failed: 1,
  documents_pending: 0,
  facts_found: 1,
  rejected_unverified: 2,
  rejected_invalid: 0,
  cost_usd: 0,
  documents: [
    {
      document_id: "d2",
      name: "scan.pdf",
      state: "failed",
      reason: "NO_TEXT",
      pages_total: 3,
      pages_read: 0,
      facts: 0,
      rejected: 0,
    },
  ],
  created_at: "2026-11-27T00:00:00.000Z",
  finished_at: "2026-11-27T00:01:00.000Z",
  ...over,
});

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`GET ${BASE}/facts`]: () => [200, { facts: [fact()], next_cursor: null }],
    [`GET ${BASE}/entities`]: () => [
      200,
      {
        entities: [
          {
            id: "e1",
            kind: "org",
            canonical_name: "Acme",
            aliases: [],
            role: null,
            provisional: true,
          },
        ],
      },
    ],
    [`GET ${BASE}/issues`]: () => [200, { issues: [] }],
    [`GET ${BASE}/files`]: () => [
      200,
      {
        files: [
          {
            document_id: DOC,
            version_id: VERSION,
            name: "letter.txt",
            vault_id: "v1",
            vault_name: "Data room",
            page_count: 1,
            ready: true,
          },
        ],
        truncated: false,
      },
    ],
    [`GET ${BASE}/facts/extractions`]: () => [200, { extractions: [] }],
    ...over,
  };
}

describe("facts screen", () => {
  it("has its own tab in a Space", () => {
    expect(parseSpaceRoute(`#/spaces/${SPACE}/facts`)).toMatchObject({ tab: "facts" });
  });

  it("shows a date only as exactly as it is known", () => {
    const when = (date_precision: Fact["date_precision"]) =>
      factDate({ event_date: "2021-03-01", event_date_end: null, date_precision });
    expect([when("day"), when("month"), when("year")]).toEqual(["1 Mar 2021", "Mar 2021", "2021"]);
    expect(factDate({ event_date: null, event_date_end: null, date_precision: "unknown" })).toBe(
      "Undated",
    );
  });

  it("groups by name, keeping facts that name no one", () => {
    const entities = [{ id: "e1", canonical_name: "Acme" }] as Parameters<typeof grouped>[3];
    const groups = grouped([fact(), fact({ id: "f2", entity_ids: [] })], "entity", [], entities);
    expect(groups.map((g) => [g.heading, g.facts.map((f) => f.id)])).toEqual([
      ["Acme", ["f1"]],
      ["No one named", ["f2"]],
    ]);
  });

  it("lists facts as plain text, with their source and a way to decide on them", async () => {
    const sent = serve(
      routes({
        [`POST ${BASE}/facts/f1/status`]: () => [200, { fact: fact({ status: "confirmed" }) }],
      }),
    );
    render(<FactsTab spaceId={SPACE} />);
    const table = await screen.findByRole("table", { name: "Facts" });
    expect(within(table).getByText(fact().text)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(within(table).getByRole("button", { name: "letter.txt, p. 1" })).toBeTruthy();
    expect(await screen.findByText("May be a duplicate")).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: `Confirm: ${fact().text}` }));
    expect(await within(table).findByText("Confirmed")).toBeTruthy();
    expect(sent.find((c) => c.route === `POST ${BASE}/facts/f1/status`)?.body).toEqual({
      status: "confirmed",
    });
  });

  it("asks the server to filter", async () => {
    const sent = serve(
      routes({
        [`GET ${BASE}/facts?filter%5Bstatus%5D=disputed`]: () => [
          200,
          { facts: [], next_cursor: null },
        ],
      }),
    );
    render(<FactsTab spaceId={SPACE} />);
    await screen.findByRole("table", { name: "Facts" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "disputed" } });
    expect(await screen.findByText("No facts match these filters.")).toBeTruthy();
    expect(sent.some((c) => c.route.endsWith("filter%5Bstatus%5D=disputed"))).toBe(true);
  });

  it("says what an extraction didn't read, and never calls it complete", async () => {
    serve(
      routes({
        [`GET ${BASE}/facts/extractions`]: () => [200, { extractions: [extraction()] }],
        [`GET ${BASE}/facts/extractions/${RUN_ID}`]: () => [200, { extraction: extraction() }],
      }),
    );
    render(<FactsTab spaceId={SPACE} />);
    expect(await screen.findByText("Incomplete: read 1 of 2 files in full")).toBeTruthy();
    expect(screen.getByText(/scan\.pdf/).textContent).toContain("no readable text");
    expect(screen.getByText(/thrown away/).textContent).toContain("2 thrown away");
    expect(screen.queryByText(/Read all/)).toBeNull();
  });

  it("starts an extraction over a vault and follows it", async () => {
    let state: FactExtraction = extraction({
      state: "running",
      documents_read: 0,
      documents_failed: 0,
      documents_pending: 1,
      documents_total: 1,
      documents: [],
    });
    const sent = serve(
      routes({
        [`POST ${BASE}/facts/extract`]: () => [202, { run_id: RUN_ID, documents_total: 1 }],
        [`GET ${BASE}/facts/extractions/${RUN_ID}`]: () => [200, { extraction: state }],
      }),
    );
    render(<FactsTab spaceId={SPACE} />);
    fireEvent.click(await screen.findByRole("button", { name: "Extract from this vault" }));
    expect(await screen.findByText("Reading: 0 of 1 file")).toBeTruthy();
    expect(sent.find((c) => c.route === `POST ${BASE}/facts/extract`)?.body).toEqual({
      vault_id: "v1",
    });
    state = extraction({
      state: "done",
      complete: true,
      documents_total: 1,
      documents_read: 1,
      documents_failed: 0,
      documents: [],
    });
    await waitFor(() => expect(FakeSource.all).toHaveLength(1));
    FakeSource.all[0]?.emit("facts.extract_progress", 2, {
      documents_done: 1,
      documents_total: 1,
      facts_found: 1,
      rejected_unverified: 0,
    });
    expect(await screen.findByText("Read all 1 file")).toBeTruthy();
  });

  it("adds a fact quoting a page", async () => {
    const sent = serve(
      routes({
        [`GET /api/v1/documents/${DOC}/versions/${VERSION}/pages?from=1&to=1`]: () => [
          200,
          { pages: [{ page_no: 1, text: `The supplier ${QUOTE}.` }] },
        ],
        [`POST ${BASE}/facts`]: () => [201, { fact: fact({ id: "f9", source: "manual" }) }],
      }),
    );
    render(<FactsTab spaceId={SPACE} />);
    await screen.findByRole("table", { name: "Facts" });
    fireEvent.click(screen.getByRole("button", { name: "Add a fact by hand" }));
    fireEvent.change(screen.getByLabelText("File"), { target: { value: DOC } });
    expect(await screen.findByLabelText("Page text")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Quote, exactly as on the page"), {
      target: { value: QUOTE },
    });
    fireEvent.change(screen.getByLabelText("Fact, in one sentence"), {
      target: { value: "The goods arrived." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add fact" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === `POST ${BASE}/facts`)?.body).toEqual({
        text: "The goods arrived.",
        event_date: null,
        event_date_end: null,
        date_precision: "unknown",
        entity_ids: [],
        issue_ids: [],
        citations: [{ document_version_id: VERSION, page_no: 1, quote: QUOTE }],
      }),
    );
  });
});
