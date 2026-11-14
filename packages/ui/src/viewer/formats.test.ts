import { describe, expect, it } from "vitest";
import { columnLetters, columnNumber, parseEmail, parseSheet, parseTranscript } from "./formats.js";

describe("parseSheet", () => {
  const text = "Fees\n\nA1: Item\nB1: Amount\n\nA2: Licence\nB2: 1200\nB3: =SUM(B2:B2) → 1200";

  it("reads each cell with its offsets in the page text", () => {
    const sheet = parseSheet(text);
    expect(sheet).toMatchObject({ name: "Fees", rows: 3, cols: 2 });
    const total = sheet.cells.find((cell) => cell.addr === "B3");
    expect(total).toMatchObject({ formula: "=SUM(B2:B2)", value: "1200" });
    expect(text.slice(total?.from, total?.to)).toBe("B3: =SUM(B2:B2) → 1200");
  });

  it("converts between column letters and numbers", () => {
    expect(columnNumber("AA")).toBe(27);
    expect(columnLetters(27)).toBe("AA");
    expect(columnLetters(1)).toBe("A");
  });
});

describe("parseEmail", () => {
  it("splits headers from the body and keeps body offsets", () => {
    const text = "From: ana@example.test\nSubject: Renewal\n\nPlease renew.";
    const email = parseEmail(text);
    expect(email.headers).toEqual([
      { name: "From", value: "ana@example.test" },
      { name: "Subject", value: "Renewal" },
    ]);
    expect(text.slice(email.bodyFrom)).toBe("Please renew.");
  });
});

describe("parseTranscript", () => {
  it("reads timestamped speaker lines", () => {
    const text = "[00:01] Ana: Hello.\n[01:30:00] Ben: We agree.";
    const segments = parseTranscript(text);
    expect(segments?.map((s) => [s.speaker, s.seconds])).toEqual([
      ["Ana", 1],
      ["Ben", 5400],
    ]);
    expect(text.slice(segments?.[1]?.from, segments?.[1]?.to)).toBe("We agree.");
  });

  it("ignores prose that mentions a time", () => {
    expect(parseTranscript("We met at 10:30 to talk.\nThen we left.")).toBeNull();
  });
});
