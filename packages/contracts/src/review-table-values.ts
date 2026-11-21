import type {
  ClassifyOption,
  ColumnOptionsFor,
  ColumnType,
  Settings,
  ValueTyped,
} from "./review-table.js";

// Deterministic parsers for model output (review-tables.md §9 step 4). No floats touch money:
// amounts stay decimal strings from the first digit to the stored value.

export type DatePrecision = "day" | "month" | "year";
export interface ParsedDate {
  iso: string;
  precision: DatePrecision;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_WORD =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ORDINAL = "(?:st|nd|rd|th)?";

const monthOf = (word: string) =>
  MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().slice(0, 3))) + 1;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;

function day(y: number, m: number, d: number): ParsedDate | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return { iso: `${y}-${pad(m)}-${pad(d)}`, precision: "day" };
}

const fullYear = (y: string) => {
  const n = Number(y);
  return y.length === 2 ? (n < 70 ? 2000 + n : 1900 + n) : n;
};

/**
 * Finds the first date in the text. Numeric dates like 01/02/2024 follow `order` unless one
 * part is over 12. Month or year alone only count when `allowPartial` is set.
 */
export function parseDate(
  raw: string,
  { allowPartial = true, order = "DMY" }: { allowPartial?: boolean; order?: "DMY" | "MDY" } = {},
): ParsedDate | null {
  const text = raw.replace(/\s+/g, " ").trim();
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso) return day(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = new RegExp(
    `\\b(\\d{1,2})${ORDINAL}(?: day)?(?: of)? ${MONTH_WORD},? (\\d{4})\\b`,
    "i",
  ).exec(text);
  if (dmy) return day(Number(dmy[3]), monthOf(dmy[2] ?? ""), Number(dmy[1]));

  const mdy = new RegExp(`\\b${MONTH_WORD} (\\d{1,2})${ORDINAL},? (\\d{4})\\b`, "i").exec(text);
  if (mdy) return day(Number(mdy[3]), monthOf(mdy[1] ?? ""), Number(mdy[2]));

  const numeric = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const y = fullYear(numeric[3] ?? "");
    // A part over 12 can only be the day, whatever the setting says.
    const dayFirst = a > 12 ? true : b > 12 ? false : order === "DMY";
    return dayFirst ? day(y, b, a) : day(y, a, b);
  }

  if (!allowPartial) return null;
  const isoMonth = /\b(\d{4})-(\d{2})\b/.exec(text);
  if (isoMonth) {
    const m = Number(isoMonth[2]);
    return m >= 1 && m <= 12 ? { iso: `${isoMonth[1]}-${pad(m)}`, precision: "month" } : null;
  }
  const monthYear = new RegExp(`\\b${MONTH_WORD},? (\\d{4})\\b`, "i").exec(text);
  if (monthYear) {
    return { iso: `${monthYear[2]}-${pad(monthOf(monthYear[1] ?? ""))}`, precision: "month" };
  }
  const year = /\b(1[89]\d{2}|2\d{3})\b/.exec(text);
  return year ? { iso: year[1] ?? "", precision: "year" } : null;
}

export function formatDate(
  { iso, precision }: ParsedDate,
  format: Settings["date_format"],
): string {
  const [y = "", m = "", d = ""] = iso.split("-");
  if (precision === "year") return y;
  const monthName = (MONTHS[Number(m) - 1] ?? "").replace(/^./, (c) => c.toUpperCase());
  if (precision === "month") {
    if (format === "ISO") return `${y}-${m}`;
    return format === "long" ? `${monthName} ${y}` : `${m}/${y}`;
  }
  switch (format) {
    case "ISO":
      return iso;
    case "DMY":
      return `${d}/${m}/${y}`;
    case "MDY":
      return `${m}/${d}/${y}`;
    case "long":
      return `${Number(d)} ${monthName} ${y}`;
  }
}

/** "1,500,000.50" → "1500000.50"; the last of `.` or `,` is the decimal mark when both appear. */
export function normalizeDecimal(raw: string): string | null {
  let s = raw.replace(/[\s '’]/g, "");
  if (!/^-?[\d.,]*\d[\d.,]*$/.test(s)) return null;
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let whole = s;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const mark = lastDot > lastComma ? "." : ",";
    const at = Math.max(lastDot, lastComma);
    whole = s.slice(0, at).replace(/[.,]/g, "");
    fraction = s.slice(at + 1);
    if (fraction.includes(mark === "." ? "," : ".")) return null;
  } else {
    const mark = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (mark) {
      const parts = s.split(mark);
      // 1,500,000 or 1.500.000 group thousands; 1,5 or 1.5 is a fraction.
      const grouped = parts.length > 2 || (parts[1]?.length === 3 && mark === ",");
      if (grouped) {
        if (!parts.slice(1).every((p) => p.length === 3)) return null;
        whole = parts.join("");
      } else {
        whole = parts[0] ?? "";
        fraction = parts[1] ?? "";
      }
    }
  }
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
}

/** Moves the decimal point right by `places`, as a multiplier word does. */
export function shiftDecimal(value: string, places: number): string {
  const negative = value.startsWith("-");
  const [whole = "", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const digits = whole + fraction.padEnd(places, "0");
  const point = whole.length + places;
  const out = `${digits.slice(0, point).replace(/^0+(?=\d)/, "") || "0"}${
    digits.length > point ? `.${digits.slice(point)}` : ""
  }`;
  return negative ? `-${out}` : out;
}

/** Rounds half away from zero to exactly `decimals` places. */
export function roundDecimal(value: string, decimals: number): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const kept = fraction.padEnd(decimals, "0").slice(0, decimals);
  let digits = (whole + kept).split("").map(Number);
  if ((fraction[decimals] ?? "0") >= "5") {
    let i = digits.length - 1;
    while (i >= 0) {
      if ((digits[i] ?? 0) < 9) {
        digits[i] = (digits[i] ?? 0) + 1;
        break;
      }
      digits[i] = 0;
      i -= 1;
    }
    if (i < 0) digits = [1, ...digits];
  }
  const all = digits.join("");
  const cut = all.length - decimals;
  const intPart = all.slice(0, cut).replace(/^0+(?=\d)/, "") || "0";
  const out = decimals > 0 ? `${intPart}.${all.slice(cut)}` : intPart;
  return negative && /[1-9]/.test(out) ? `-${out}` : out;
}

const group = (value: string) => {
  const negative = value.startsWith("-");
  const [whole = "", fraction] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
};

const MULTIPLIERS: Record<string, number> = {
  thousand: 3,
  k: 3,
  million: 6,
  m: 6,
  mm: 6,
  mn: 6,
  mio: 6,
  billion: 9,
  bn: 9,
  b: 9,
  trillion: 12,
  tn: 12,
};

const NUMBER = String.raw`(\d[\d.,'’ ]*\d|\d)`;
const MULTIPLIER = String.raw`(?:\s?(thousand|million|billion|trillion|mio|mn|mm|bn|tn|k|m|b)\b)?`;
// Plain numbers take only spelled-out multipliers: "5 m" is more likely metres than millions.
const WORD_MULTIPLIER = String.raw`(?:\s(thousand|million|billion|trillion)\b)?`;
const CURRENCY_WORD = /[$£€¥₹₩]|dollar|euro|pound|sterling|yen|rupee|franc/i;

// Common ISO 4217 codes; a three-letter word outside this list is not taken for money.
const CODES = new Set(
  "USD EUR GBP JPY CNY AUD CAD CHF HKD SGD NZD SEK NOK DKK INR KRW BRL MXN ZAR AED SAR ILS PLN CZK HUF TRY RUB TWD THB MYR IDR PHP VND".split(
    " ",
  ),
);
const DOLLARS = new Set(["USD", "AUD", "CAD", "NZD", "SGD", "HKD"]);
const SYMBOLS: [string, string][] = [
  ["US$", "USD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["NZ$", "NZD"],
  ["S$", "SGD"],
  ["HK$", "HKD"],
  ["£", "GBP"],
  ["€", "EUR"],
  ["¥", "JPY"],
  ["₹", "INR"],
  ["₩", "KRW"],
];
const WORDS: [RegExp, string][] = [
  [/\beuros?\b/i, "EUR"],
  [/\b(pounds? sterling|sterling|pounds?)\b/i, "GBP"],
  [/\byen\b/i, "JPY"],
  [/\brupees?\b/i, "INR"],
  [/\bswiss francs?\b/i, "CHF"],
];
const DISPLAY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  INR: "₹",
  AUD: "A$",
  CAD: "C$",
};

function currencyIn(text: string, fallback: string): string {
  for (const [symbol, code] of SYMBOLS) if (text.includes(symbol)) return code;
  for (const match of text.matchAll(/\b([A-Za-z]{3})\b/g)) {
    const code = (match[1] ?? "").toUpperCase();
    if (CODES.has(code) && match[1] === code) return code;
  }
  for (const [pattern, code] of WORDS) if (pattern.test(text)) return code;
  // A bare $ or "dollars" means the column's dollar currency, else US dollars.
  if (text.includes("$") || /\bdollars?\b/i.test(text)) {
    return DOLLARS.has(fallback) ? fallback : "USD";
  }
  return fallback;
}

// Codes are matched in capitals only, so "May" or "the" never reads as money.
const nearCurrency = (text: string) =>
  CURRENCY_WORD.test(text) ||
  [...text.matchAll(/\b([A-Z]{3})\b/g)].some((m) => CODES.has(m[1] ?? ""));

export interface ParsedMoney {
  amount: string;
  currency: string;
}

/** "USD 1.5 million" → { amount: "1500000.00", currency: "USD" } with 2 decimals. */
export function parseCurrency(
  raw: string,
  { defaultCurrency = "USD", decimals = 2 }: { defaultCurrency?: string; decimals?: number } = {},
): ParsedMoney | null {
  const text = raw.replace(/\s+/g, " ").trim();
  const matches = [...text.matchAll(new RegExp(`(\\(|-)?${NUMBER}${MULTIPLIER}`, "gi"))];
  // Prefer the number written next to a currency, so "on 1 May, USD 500" reads 500.
  const match =
    matches.find((m) =>
      nearCurrency(text.slice(Math.max(0, m.index - 4), m.index + m[0].length + 14)),
    ) ?? matches[0];
  if (!match) return null;
  let amount = normalizeDecimal(match[2] ?? "");
  if (amount === null) return null;
  const word = match[3]?.toLowerCase();
  if (word) amount = shiftDecimal(amount, MULTIPLIERS[word] ?? 0);
  // Accounts write a negative amount in brackets.
  if (match[1] && amount !== "0") amount = `-${amount}`;
  return { amount: roundDecimal(amount, decimals), currency: currencyIn(text, defaultCurrency) };
}

export function formatCurrency(
  { amount, currency }: ParsedMoney,
  display: Settings["currency_display"],
): string {
  const symbol = display === "symbol" ? DISPLAY_SYMBOL[currency] : undefined;
  if (!symbol) return `${currency} ${group(amount)}`;
  return amount.startsWith("-")
    ? `-${symbol}${group(amount.slice(1))}`
    : `${symbol}${group(amount)}`;
}

const SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function wordNumber(text: string): { value: string; end: number } | null {
  const match = new RegExp(
    `\\b(?:(${TENS.join("|")})(?:[- ](${SMALL.slice(1, 10).join("|")}))?|(${SMALL.join("|")}))\\b`,
    "i",
  ).exec(text);
  if (!match) return null;
  const tens = match[1] ? (TENS.indexOf(match[1].toLowerCase()) + 2) * 10 : 0;
  const ones = match[2] ? SMALL.indexOf(match[2].toLowerCase()) : 0;
  const small = match[3] ? SMALL.indexOf(match[3].toLowerCase()) : 0;
  return { value: String(tens + ones + small), end: match.index + match[0].length };
}

export interface ParsedNumber {
  value: string;
  unit?: string | undefined;
}

/** The first number, with "%" or the next word as its unit unless the column fixes one. */
export function parseNumber(
  raw: string,
  { decimals, unit }: { decimals?: number | undefined; unit?: string | undefined } = {},
): ParsedNumber | null {
  const text = raw.replace(/\s+/g, " ").trim();
  const match = new RegExp(`(-)?${NUMBER}${WORD_MULTIPLIER}`, "i").exec(text);
  let value: string | null;
  let end: number;
  if (match) {
    value = normalizeDecimal(match[2] ?? "");
    if (value === null) return null;
    const word = match[3]?.toLowerCase();
    if (word) value = shiftDecimal(value, MULTIPLIERS[word] ?? 0);
    if (match[1]) value = `-${value}`;
    end = match.index + match[0].length;
  } else {
    const spelled = wordNumber(text);
    if (!spelled) return null;
    value = spelled.value;
    end = spelled.end;
  }
  const rest = text.slice(end);
  const found = /^\s?%/.test(rest)
    ? "%"
    : /^\)? ([A-Za-z][A-Za-z-]{0,19})\b/.exec(rest)?.[1]?.toLowerCase();
  const chosen = unit ?? found;
  const rounded = decimals === undefined ? value : roundDecimal(value, decimals);
  return { value: rounded, ...(chosen ? { unit: chosen } : {}) };
}

export function formatNumber({ value, unit }: ParsedNumber): string {
  if (!unit) return group(value);
  return unit === "%" ? `${group(value)}%` : `${group(value)} ${unit}`;
}

export interface ParsedClassify {
  option_ids: string[];
  other?: string | undefined;
}

const clean = (text: string) =>
  text
    .trim()
    .replace(/^["'“‘(]+|["'”’).!]+$/g, "")
    .trim();

function matchOne(part: string, options: readonly ClassifyOption[]): ClassifyOption | null {
  const value = clean(part).toLowerCase();
  if (!value) return null;
  const exact = options.find(
    (o) => o.label.toLowerCase() === value || o.id.toLowerCase() === value,
  );
  if (exact) return exact;
  // "Yes - see clause 5": a label followed by a break, longest label first.
  const byLength = [...options].sort((a, b) => b.label.length - a.label.length);
  return (
    byLength.find((o) => {
      const label = o.label.toLowerCase();
      return value.startsWith(label) && /^[\s,;:.\-–—(]/.test(value.slice(label.length));
    }) ?? null
  );
}

/** Option ids matched case-insensitively against labels; anything else is Other or a failure. */
export function parseClassify(
  raw: string | readonly string[],
  {
    options,
    allowMultiple = false,
    allowOther = true,
  }: { options: readonly ClassifyOption[]; allowMultiple?: boolean; allowOther?: boolean },
): ParsedClassify | null {
  const whole = Array.isArray(raw) ? raw.join(", ") : (raw as string);
  if (!allowMultiple) {
    const single = Array.isArray(raw) && raw.length === 1 ? (raw[0] ?? "") : whole;
    const found = matchOne(single, options);
    if (found) return { option_ids: [found.id] };
    return allowOther && clean(single) ? { option_ids: [], other: clean(single) } : null;
  }
  const parts = (Array.isArray(raw) ? [...raw] : whole.split(/[,;\n]|\band\b/i))
    .map(clean)
    .filter(Boolean);
  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const part of parts) {
    const found = matchOne(part, options);
    if (found) {
      if (!ids.includes(found.id)) ids.push(found.id);
    } else unmatched.push(part);
  }
  if (unmatched.length > 0 && !allowOther) return null;
  if (ids.length === 0 && unmatched.length === 0) return null;
  return unmatched.length > 0
    ? { option_ids: ids, other: unmatched.join(", ") }
    : { option_ids: ids };
}

export function formatClassify(value: ParsedClassify, options: readonly ClassifyOption[]): string {
  const labels = value.option_ids.map((id) => options.find((o) => o.id === id)?.label ?? id);
  if (value.other) labels.push(`Other: ${value.other}`);
  return labels.join(", ");
}

/** Cuts at `maxWords` with an ellipsis, so a long answer is still shown, marked as cut. */
export function limitWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text.trim() : `${words.slice(0, maxWords).join(" ")} …`;
}

export type TypedResult =
  | { ok: true; value_typed: ValueTyped; value_text: string }
  | { ok: false; raw: string };

/**
 * Turns a model's raw value into a typed value and its display text. Verbatim cells need a
 * verified citation first, so their caller passes the citation id once it has one.
 */
export function parseTypedValue(
  type: Exclude<ColumnType, "manual">,
  options: Record<string, unknown>,
  raw: string | readonly string[],
  settings: Pick<Settings, "date_format" | "currency_display">,
  verbatimCitationId: string | null = null,
): TypedResult {
  const text = Array.isArray(raw) ? raw.join(", ") : (raw as string);
  const fail = { ok: false as const, raw: text };
  switch (type) {
    case "date": {
      const o = options as Partial<ColumnOptionsFor<"date">>;
      const order = settings.date_format === "MDY" ? "MDY" : "DMY";
      const parsed = parseDate(text, { allowPartial: o.allow_partial ?? true, order });
      if (!parsed) return fail;
      return {
        ok: true,
        value_typed: { kind: "date", ...parsed },
        value_text: formatDate(parsed, settings.date_format),
      };
    }
    case "currency": {
      const o = options as Partial<ColumnOptionsFor<"currency">>;
      const parsed = parseCurrency(text, {
        defaultCurrency: o.default_currency ?? "USD",
        decimals: o.decimals ?? 2,
      });
      if (!parsed) return fail;
      return {
        ok: true,
        value_typed: { kind: "currency", ...parsed },
        value_text: formatCurrency(parsed, settings.currency_display),
      };
    }
    case "number": {
      const o = options as Partial<ColumnOptionsFor<"number">>;
      const parsed = parseNumber(text, { decimals: o.decimals, unit: o.unit });
      if (!parsed) return fail;
      return {
        ok: true,
        value_typed: { kind: "number", ...parsed },
        value_text: formatNumber(parsed),
      };
    }
    case "classify": {
      const o = options as ColumnOptionsFor<"classify">;
      const parsed = parseClassify(raw, {
        options: o.options ?? [],
        allowMultiple: o.allow_multiple ?? false,
        allowOther: o.allow_other ?? true,
      });
      if (!parsed) return fail;
      return {
        ok: true,
        value_typed: { kind: "classify", ...parsed },
        value_text: formatClassify(parsed, o.options ?? []),
      };
    }
    case "verbatim": {
      const o = options as Partial<ColumnOptionsFor<"verbatim">>;
      const value = text.trim();
      if (!value || value.length > (o.max_chars ?? 2_000)) return fail;
      return {
        ok: true,
        value_typed: { kind: "verbatim", text: value, citation_id: verbatimCitationId },
        value_text: value,
      };
    }
    case "free": {
      const o = options as Partial<ColumnOptionsFor<"free">>;
      const value = limitWords(text, o.max_words ?? 150);
      if (!value) return fail;
      return { ok: true, value_typed: { kind: "free", markdown: value }, value_text: value };
    }
  }
}

/** Display text for a stored value under the table's current settings. */
export function formatTyped(
  value: ValueTyped,
  settings: Pick<Settings, "date_format" | "currency_display">,
  options: Record<string, unknown> = {},
): string {
  switch (value.kind) {
    case "date":
      return formatDate(value, settings.date_format);
    case "currency":
      return formatCurrency(value, settings.currency_display);
    case "number":
      return formatNumber(value);
    case "classify":
      return formatClassify(value, (options.options as ClassifyOption[] | undefined) ?? []);
    case "verbatim":
      return value.text;
    case "free":
      return value.markdown;
    case "manual":
      return value.option_ids
        ? formatClassify(
            { option_ids: value.option_ids },
            (options.options as ClassifyOption[] | undefined) ?? [],
          )
        : (value.text ?? "");
  }
}
