import type { Element } from "@xmldom/xmldom";
import { createHttp, type Http } from "./http.js";
import type { AuthorityRecord, CitationKind } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { type Chunk, chunkText, clean } from "./text.js";
import { childElements, parseXml, readableText } from "./xml.js";

const SITE = "https://www.legislation.gov.uk";
const LEG = "http://www.legislation.gov.uk/namespaces/legislation";
const UKM = "http://www.legislation.gov.uk/namespaces/metadata";
const DC = "http://purl.org/dc/elements/1.1/";
const DCT = "http://purl.org/dc/terms/";
// A large Act's XML runs to many megabytes, most of it markup and commentary.
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_SECTIONS = 5000;

export const UK_ACTS = ["ukpga", "asp", "asc", "anaw", "nia"] as const;
export const UK_INSTRUMENTS = ["uksi", "ssi", "wsi", "nisr"] as const;
export const UK_TYPES = [...UK_ACTS, ...UK_INSTRUMENTS] as const;

/** The word each kind of provision is cited by, keyed by how its id begins. */
const PROVISIONS: Record<string, string> = {
  section: "s",
  regulation: "reg",
  article: "article",
  rule: "rule",
};
const PROVISION_ID = /^(section|regulation|article|rule)-([0-9A-Za-z]+)$/;
// Marks a provision number, so it can be joined to the words that follow it.
const NUMBER_END = "\ue000";

export interface UkItem {
  /** The series, as in the item's address: "ukpga", "uksi" and so on. */
  type: string;
  year: number;
  number: number;
  /** The text as it stood on this date; the latest revised text when absent. */
  asOf?: string | undefined;
}

/** Citation forms by series, beside the title. */
function numberForms(type: string, title: string, year: number, number: number): string[] {
  switch (type) {
    case "ukpga":
      return [`${title} c. ${number}`, `${year} c. ${number}`];
    case "asp":
      return [`${year} asp ${number}`];
    case "uksi":
      return [`SI ${year}/${number}`];
    case "ssi":
      return [`SSI ${year}/${number}`];
    case "wsi":
      return [`WSI ${year}/${number}`];
    case "nisr":
      return [`SR ${year}/${number}`];
    default:
      return [];
  }
}

const ancestors = (element: Element): string[] => {
  const names: string[] = [];
  for (let at = element.parentNode; at && at.nodeType === 1; at = at.parentNode) {
    names.push((at as Element).localName ?? "");
  }
  return names;
};

const all = (root: Element, namespace: string, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(namespace, name));

/** A provision's or schedule's words as lines, with each number beside what it numbers. */
function words(element: Element): string {
  return readableText(element, new Set(), (e) => {
    // A Text element is one run of prose, whatever terms and amendments it marks up.
    if (e.localName === "Text") return `\n${(e.textContent ?? "").replace(/\s+/g, " ")}\n`;
    if (e.localName !== "Pnumber") return null;
    const number = (e.textContent ?? "").trim();
    // The provision itself is "3"; everything inside it is "(2)", "(a)".
    return `\n${e.parentNode === element ? number : `(${number})`}${NUMBER_END}\n`;
  }).replace(/\ue000\n?/g, " ");
}

function heading(provision: Element): string | null {
  let at = provision.parentNode as Element | null;
  while (at && at.nodeType === 1 && at.localName !== "P1group") {
    at = at.parentNode as Element | null;
  }
  if (at?.nodeType !== 1) return null;
  const title = childElements(at).find((e) => e.localName === "Title");
  return title ? clean((title.textContent ?? "").replace(/\s+/g, " ").trim()) : null;
}

function readBody(root: Element) {
  const top: string[] = [];
  const deeper: { pin: string; depth: number }[] = [];
  const schedules: string[] = [];
  const chunks: Chunk[] = [];

  for (const provision of all(root, LEG, "P1")) {
    const id = provision.getAttribute("id") ?? "";
    const match = PROVISION_ID.exec(id);
    const within = ancestors(provision);
    // Quoted amendments and schedule paragraphs are not provisions of this item's body.
    if (!match || within.some((n) => n === "BlockAmendment" || n === "Schedule")) continue;
    const [, kind = "", number = ""] = match;
    const name = `${PROVISIONS[kind]} ${number}`;
    top.push(name);
    for (const part of Array.from(provision.getElementsByTagName("*"))) {
      const inner = part.getAttribute("id") ?? "";
      if (!inner.startsWith(`${id}-`)) continue;
      const rest = inner.slice(id.length + 1).split("-");
      if (!rest.every((r) => /^[0-9A-Za-z]{1,8}$/.test(r))) continue;
      deeper.push({ pin: `${name}${rest.map((r) => `(${r})`).join("")}`, depth: rest.length });
    }
    const title = heading(provision);
    const text = words(provision);
    chunks.push(...chunkText(title ? `${title}\n${text}` : text, name));
  }

  for (const [i, schedule] of all(root, LEG, "Schedule").entries()) {
    const number = /^schedule-([0-9A-Za-z]+)$/.exec(schedule.getAttribute("id") ?? "")?.[1];
    // A lone schedule carries no number.
    const name = number ? `Sch ${number}` : i === 0 ? "Sch" : `Sch ${i + 1}`;
    schedules.push(name);
    chunks.push(...chunkText(words(schedule), name));
  }

  // Shallow pins first, so a very long item loses only its finest ones to the limit.
  deeper.sort((a, b) => a.depth - b.depth);
  const sections = [...new Set([...top, ...schedules, ...deeper.map((d) => d.pin)])];
  return { chunks, sections: sections.slice(0, MAX_SECTIONS) };
}

const itemPath = ({ type, year, number, asOf }: UkItem) =>
  `${type}/${year}/${number}${asOf ? `/${asOf}` : ""}`;

export function ukRecord(item: UkItem, xml: string): AuthorityRecord {
  const { type, year, number } = item;
  const root = parseXml(xml);
  if (root.localName !== "Legislation") throw new Error("not a legislation document");
  const metadata = all(root, UKM, "Metadata")[0];
  if (!metadata) throw new Error("no metadata");
  const value = (name: string, attribute = "Value") =>
    all(metadata, UKM, name)[0]?.getAttribute(attribute) ?? undefined;
  if (Number(value("Year")) !== year || Number(value("Number")) !== number) {
    throw new Error("the answer is for another item");
  }
  const title = clean(all(metadata, DC, "title")[0]?.textContent?.trim() ?? "").slice(0, 900);
  if (!title) throw new Error("no title");
  const { chunks, sections } = readBody(root);
  // Some older items are published only as scans, with nothing to quote.
  if (chunks.length === 0) throw new Error("no text");
  const dated = value("EnactmentDate", "Date") ?? value("Made", "Date");
  const asOf = item.asOf ?? all(metadata, DCT, "valid")[0]?.textContent?.trim();
  const instrument = (UK_INSTRUMENTS as readonly string[]).includes(type);
  const forms = [title];
  // "The Widget Regulations 2002" is as often written without its "The".
  if (title.startsWith("The ")) forms.push(title.slice(4));
  forms.push(...numberForms(type, title, year, number));
  const citations = forms.map((text) => ({
    text: text.slice(0, 500),
    kind: "act" as CitationKind,
  }));
  return {
    ref: `uk_legislation:item:${type}-${year}-${number}`,
    title,
    jurisdiction: "UK",
    docType: instrument ? "statutory_instrument" : "act",
    ...(dated && /^\d{4}-\d{2}-\d{2}$/.test(dated) ? { decidedOn: dated } : {}),
    url: `${SITE}/${itemPath(item)}`,
    citations,
    sections,
    meta: {
      type,
      year,
      number,
      ...(asOf ? { as_of: asOf.slice(0, 10) } : {}),
      status: value("DocumentStatus") ?? null,
      extent: root.getAttribute("RestrictExtent"),
      // Amendments the publisher knows of but has not yet written into the text.
      outstanding_changes: all(metadata, UKM, "UnappliedEffect").length,
      licence: "Open Government Licence v3.0",
    },
    chunks,
  };
}

export interface UkLegislationOptions {
  items: readonly UkItem[];
  http?: Http;
}

export const ukHttp = (userAgent?: string) =>
  createHttp({ perSecond: 1, maxBytes: MAX_BYTES, userAgent });

/** legislation.gov.uk: each item's Crown Legislation Markup Language, whole. */
export function createUkLegislationLoader(options: UkLegislationOptions): Loader {
  const http = options.http ?? ukHttp();
  return {
    source: "uk_legislation",
    async *records() {
      for (const item of options.items) {
        const label = itemPath(item);
        const safe =
          (UK_TYPES as readonly string[]).includes(item.type) &&
          Number.isInteger(item.year) &&
          Number.isInteger(item.number) &&
          item.number > 0 &&
          (item.asOf === undefined || /^\d{4}-\d{2}-\d{2}$/.test(item.asOf));
        if (!safe) {
          yield { failed: label, reason: "not a legislation item" };
          continue;
        }
        try {
          const xml = await http.text(`${SITE}/${label}/data.xml`, { accept: "application/xml" });
          yield ukRecord(item, xml);
        } catch (err) {
          yield failure(label, err);
        }
      }
    },
  };
}
