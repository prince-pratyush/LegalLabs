import { describe, expect, it } from "vitest";
import { FactCreate, FactDate, FactPatch } from "./facts.js";

const citation = {
  document_version_id: "0198a0c0-0000-7000-8000-000000000001",
  page_no: 1,
  quote: "The notice was sent on 3 March 2021.",
};
const fact = { text: "The notice was sent.", citations: [citation] };

describe("facts", () => {
  it("takes real calendar days only", () => {
    expect(FactDate.safeParse("2021-03-03").success).toBe(true);
    for (const bad of ["2021-02-30", "2021-3-3", "03/03/2021", "9999-12-31", "0099-01-01"]) {
      expect(FactDate.safeParse(bad).success).toBe(false);
    }
  });

  it("needs a citation, and a date that matches its precision", () => {
    expect(FactCreate.safeParse(fact).success).toBe(true);
    expect(FactCreate.safeParse({ ...fact, citations: [] }).success).toBe(false);
    expect(FactCreate.safeParse({ ...fact, event_date: "2021-03-03" }).success).toBe(false);
    expect(FactCreate.safeParse({ ...fact, date_precision: "day" }).success).toBe(false);
    const dated = { ...fact, event_date: "2021-03-03", date_precision: "day" };
    expect(FactCreate.safeParse(dated).success).toBe(true);
    expect(FactCreate.safeParse({ ...dated, event_date_end: "2021-03-02" }).success).toBe(false);
  });

  it("changes a date whole or not at all", () => {
    expect(FactPatch.safeParse({ text: "New words." }).success).toBe(true);
    expect(FactPatch.safeParse({}).success).toBe(false);
    expect(FactPatch.safeParse({ event_date: "2021-03-03" }).success).toBe(false);
    expect(
      FactPatch.safeParse({ event_date: null, event_date_end: null, date_precision: "unknown" })
        .success,
    ).toBe(true);
  });
});
