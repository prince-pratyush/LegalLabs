import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatDate,
  formatTyped,
  limitWords,
  normalizeDecimal,
  parseClassify,
  parseCurrency,
  parseDate,
  parseNumber,
  parseTypedValue,
  roundDecimal,
  shiftDecimal,
} from "./review-table-values.js";

const ISO = { date_format: "ISO", currency_display: "code" } as const;
const yesNo = [
  { id: "yes", label: "Yes", color: "green" },
  { id: "no", label: "No", color: "red" },
] as const;
const laws = [
  { id: "ny", label: "New York", color: "blue" },
  { id: "de", label: "Delaware", color: "teal" },
  { id: "ew", label: "England and Wales", color: "purple" },
] as const;

describe("parseDate", () => {
  it.each([
    ["2024-03-01", "2024-03-01"],
    ["1 March 2024", "2024-03-01"],
    ["1st March, 2024", "2024-03-01"],
    ["the 5th day of March, 2021", "2021-03-05"],
    ["March 1, 2024", "2024-03-01"],
    ["Sept. 30 2023", "2023-09-30"],
    ["effective as of Dec 31st, 1999.", "1999-12-31"],
  ])("reads %s to the day", (raw, iso) => {
    expect(parseDate(raw)).toEqual({ iso, precision: "day" });
  });

  it("reads numeric dates day-first or month-first by setting", () => {
    expect(parseDate("01/02/2024", { order: "DMY" })?.iso).toBe("2024-02-01");
    expect(parseDate("01/02/2024", { order: "MDY" })?.iso).toBe("2024-01-02");
  });

  it("knows a part over 12 is the day, whatever the setting", () => {
    expect(parseDate("13/02/2024", { order: "MDY" })?.iso).toBe("2024-02-13");
    expect(parseDate("02/13/2024", { order: "DMY" })?.iso).toBe("2024-02-13");
  });

  it("keeps the precision of a partial date", () => {
    expect(parseDate("March 2024")).toEqual({ iso: "2024-03", precision: "month" });
    expect(parseDate("in 2019")).toEqual({ iso: "2019", precision: "year" });
  });

  it("refuses partial dates when the column does", () => {
    expect(parseDate("March 2024", { allowPartial: false })).toBeNull();
  });

  it("refuses impossible days, keeping leap years", () => {
    expect(parseDate("31 February 2024")).toBeNull();
    expect(parseDate("29 February 2024")?.iso).toBe("2024-02-29");
    expect(parseDate("29 February 2023")).toBeNull();
  });

  it("returns null when there is no date", () => {
    expect(parseDate("not stated")).toBeNull();
  });

  it("formats per the table setting", () => {
    const d = { iso: "2024-03-01", precision: "day" } as const;
    expect(formatDate(d, "ISO")).toBe("2024-03-01");
    expect(formatDate(d, "DMY")).toBe("01/03/2024");
    expect(formatDate(d, "MDY")).toBe("03/01/2024");
    expect(formatDate(d, "long")).toBe("1 March 2024");
    expect(formatDate({ iso: "2024-03", precision: "month" }, "long")).toBe("March 2024");
  });
});

describe("decimals", () => {
  it.each([
    ["1,500,000", "1500000"],
    ["1,500,000.50", "1500000.50"],
    ["1.500.000,50", "1500000.50"],
    ["1,5", "1.5"],
    ["0.25", "0.25"],
    ["007", "7"],
  ])("normalises %s", (raw, out) => {
    expect(normalizeDecimal(raw)).toBe(out);
  });

  it("refuses broken grouping", () => {
    expect(normalizeDecimal("1,50,000")).toBeNull();
    expect(normalizeDecimal("abc")).toBeNull();
  });

  it("shifts without floats", () => {
    expect(shiftDecimal("1.5", 6)).toBe("1500000");
    expect(shiftDecimal("0.000123", 3)).toBe("0.123");
    expect(shiftDecimal("12345678901234567.89", 3)).toBe("12345678901234567890");
  });

  it("rounds half away from zero", () => {
    expect(roundDecimal("1.005", 2)).toBe("1.01");
    expect(roundDecimal("9.999", 2)).toBe("10.00");
    expect(roundDecimal("-2.5", 0)).toBe("-3");
    expect(roundDecimal("1500000", 2)).toBe("1500000.00");
  });
});

describe("parseCurrency", () => {
  it("reads USD 1.5 million as 1500000.00 USD (RVT-002)", () => {
    expect(parseCurrency("USD 1.5 million", { decimals: 2 })).toEqual({
      amount: "1500000.00",
      currency: "USD",
    });
  });

  it.each([
    ["$2,000,000", "2000000.00", "USD"],
    ["€2.3bn", "2300000000.00", "EUR"],
    ["GBP 500k", "500000.00", "GBP"],
    ["1,000 euros", "1000.00", "EUR"],
    ["£250,000.75", "250000.75", "GBP"],
    ["A$10m", "10000000.00", "AUD"],
    ["(1,200)", "-1200.00", "USD"],
  ])("reads %s", (raw, amount, currency) => {
    expect(parseCurrency(raw)).toEqual({ amount, currency });
  });

  it("uses the column's currency when none is written", () => {
    expect(parseCurrency("2,500", { defaultCurrency: "EUR" })).toEqual({
      amount: "2500.00",
      currency: "EUR",
    });
  });

  it("reads a bare $ as the column's dollar currency", () => {
    expect(parseCurrency("$100", { defaultCurrency: "AUD" })?.currency).toBe("AUD");
    expect(parseCurrency("$100", { defaultCurrency: "EUR" })?.currency).toBe("USD");
  });

  it("prefers the number next to the currency", () => {
    expect(parseCurrency("On 1 May the buyer pays USD 500")).toEqual({
      amount: "500.00",
      currency: "USD",
    });
  });

  it("does not take an ordinary capitalised word for a currency", () => {
    expect(parseCurrency("THE sum of 5")?.currency).toBe("USD");
  });

  it("returns null with no amount", () => {
    expect(parseCurrency("a reasonable fee")).toBeNull();
  });

  it("formats with code or symbol", () => {
    const money = { amount: "1500000.00", currency: "USD" };
    expect(formatCurrency(money, "code")).toBe("USD 1,500,000.00");
    expect(formatCurrency(money, "symbol")).toBe("$1,500,000.00");
    expect(formatCurrency({ amount: "-5.00", currency: "GBP" }, "symbol")).toBe("-£5.00");
    expect(formatCurrency({ amount: "5.00", currency: "SEK" }, "symbol")).toBe("SEK 5.00");
  });
});

describe("parseNumber", () => {
  it("reads a number and its unit", () => {
    expect(parseNumber("30 days")).toEqual({ value: "30", unit: "days" });
    expect(parseNumber("30 days", { decimals: 2 })).toEqual({ value: "30.00", unit: "days" });
    expect(parseNumber("12.5%", { decimals: 1 })).toEqual({ value: "12.5", unit: "%" });
    expect(parseNumber("thirty (30) days", { decimals: 0 })).toEqual({ value: "30", unit: "days" });
  });

  it("reads small numbers in words", () => {
    expect(parseNumber("twenty-one business days", { decimals: 0 })).toEqual({
      value: "21",
      unit: "business",
    });
    expect(parseNumber("five", { decimals: 0 })).toEqual({ value: "5" });
  });

  it("keeps the column's unit", () => {
    expect(parseNumber("90", { decimals: 0, unit: "days" })).toEqual({ value: "90", unit: "days" });
  });

  it("doesn't read 5 m as five million", () => {
    expect(parseNumber("5 m", { decimals: 0 })).toEqual({ value: "5", unit: "m" });
    expect(parseNumber("2 million shares", { decimals: 0 })?.value).toBe("2000000");
  });

  it("returns null with no number", () => {
    expect(parseNumber("none")).toBeNull();
  });
});

describe("parseClassify", () => {
  it("matches labels case-insensitively", () => {
    expect(parseClassify("yes", { options: [...yesNo] })).toEqual({ option_ids: ["yes"] });
    expect(parseClassify("Yes - see clause 5.", { options: [...yesNo] })).toEqual({
      option_ids: ["yes"],
    });
  });

  it("fails a label outside the list when Other isn't allowed (RVT-002)", () => {
    expect(parseClassify("C", { options: [...yesNo], allowOther: false })).toBeNull();
  });

  it("keeps an unknown label as Other when allowed", () => {
    expect(parseClassify("Maybe", { options: [...yesNo] })).toEqual({
      option_ids: [],
      other: "Maybe",
    });
  });

  it("reads several labels, including one with 'and' in it", () => {
    expect(
      parseClassify("New York; Delaware", { options: [...laws], allowMultiple: true }),
    ).toEqual({ option_ids: ["ny", "de"] });
    expect(
      parseClassify(["England and Wales", "ny"], { options: [...laws], allowMultiple: true }),
    ).toEqual({ option_ids: ["ew", "ny"] });
  });

  it("prefers the longer label", () => {
    const options = [
      { id: "a", label: "Assignment", color: "red" },
      { id: "b", label: "Assignment with consent", color: "blue" },
    ] as const;
    expect(parseClassify("Assignment with consent (clause 9)", { options: [...options] })).toEqual({
      option_ids: ["b"],
    });
  });
});

describe("parseTypedValue", () => {
  it("gives a typed value and display text", () => {
    expect(parseTypedValue("currency", { decimals: 2 }, "USD 1.5 million", ISO)).toEqual({
      ok: true,
      value_typed: { kind: "currency", amount: "1500000.00", currency: "USD" },
      value_text: "USD 1,500,000.00",
    });
  });

  it("fails with the raw text kept for the reviewer", () => {
    const options = { options: [...yesNo], allow_other: false };
    expect(parseTypedValue("classify", options, "C", ISO)).toEqual({ ok: false, raw: "C" });
  });

  it("refuses a verbatim value over max_chars", () => {
    expect(parseTypedValue("verbatim", { max_chars: 20 }, "x".repeat(21), ISO).ok).toBe(false);
  });

  it("cuts free text at max_words with a marker", () => {
    expect(limitWords("one two three", 2)).toBe("one two …");
    const out = parseTypedValue("free", { max_words: 2 }, "one two three", ISO);
    expect(out.ok && out.value_text).toBe("one two …");
  });

  it("re-formats a stored value under new settings", () => {
    const value = { kind: "date", iso: "2024-03-01", precision: "day" } as const;
    expect(formatTyped(value, { date_format: "long", currency_display: "code" })).toBe(
      "1 March 2024",
    );
  });
});
