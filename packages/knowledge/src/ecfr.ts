import type { Element } from "@xmldom/xmldom";
import { z } from "zod";
import { createHttp, type Http } from "./http.js";
import type { AuthorityRecord } from "./record.js";
import { failure, type Loader } from "./sources.js";
import { chunkText } from "./text.js";
import { childElements, parseXml, readableText } from "./xml.js";

const API = "https://www.ecfr.gov/api/versioner/v1";
// The API answers 406 to a request that will not take a compressed reply.
const HEADERS = { accept: "application/xml", "accept-encoding": "gzip, deflate" };

// Both go into a URL, so only the shapes the CFR uses are let through.
export const CFR_TITLE = /^\d{1,2}$/;
export const CFR_SECTION = /^\d{1,4}[a-z]?\.[0-9A-Za-z()-]{1,30}$/;

const INLINE = new Set([
  "I",
  "B",
  "E",
  "SU",
  "SUP",
  "SUB",
  "AC",
  "FR",
  "a",
  "em",
  "strong",
  "span",
]);

const titleList = z.object({
  titles: z.array(z.object({ number: z.number(), latest_issue_date: z.string().nullish() })),
});

export interface CfrSection {
  title: string;
  /** With its part, such as "240.10b-5". */
  section: string;
}

/** "(a)", "(b)" and so on, taken in order so that a roman "(i)" further down is not one. */
function topParagraphs(lines: readonly string[]): string[] {
  const found: string[] = [];
  let next = "a".charCodeAt(0);
  for (const line of lines) {
    if (line.startsWith(`(${String.fromCharCode(next)})`)) {
      found.push(String.fromCharCode(next++));
    }
  }
  return found;
}

function sectionElement(root: Element, section: string): Element {
  const matches = (e: Element) =>
    e.getAttribute("TYPE") === "SECTION" && e.getAttribute("N")?.replace(/^§\s*/, "") === section;
  const found = matches(root) ? root : Array.from(root.getElementsByTagName("DIV8")).find(matches);
  if (!found) throw new Error("the answer does not hold that section");
  return found;
}

export function ecfrRecord(of: CfrSection, asOf: string, xml: string): AuthorityRecord {
  const { title, section } = of;
  const element = sectionElement(parseXml(xml), section);
  const head = childElements(element).find((e) => e.localName === "HEAD");
  const heading = (
    head ? readableText(head, INLINE).replaceAll("\n", " ") : `§ ${section}`
  ).replace(/\.$/, "");
  const text = readableText(element, INLINE);
  const name = `§ ${section}`;
  const paragraphs = topParagraphs(text.split("\n")).flatMap((p) => [`(${p})`, `${name}(${p})`]);
  return {
    ref: `ecfr:section:${title}-${section}`,
    title: `${title} CFR ${heading.slice(0, 900)} (as of ${asOf})`,
    jurisdiction: "US",
    docType: "regulation",
    decidedOn: asOf,
    url: `https://www.ecfr.gov/on/${asOf}/title-${title}/section-${encodeURIComponent(section)}`,
    citations: [{ text: `${title} C.F.R. ${name}`, kind: "act" }],
    sections: [name, ...paragraphs],
    meta: {
      cfr_title: title,
      cfr_part: section.slice(0, section.indexOf(".")),
      cfr_section: section,
      as_of: asOf,
      licence: "Public domain (U.S. government work)",
    },
    chunks: chunkText(text, name),
  };
}

export interface EcfrOptions {
  sections: readonly CfrSection[];
  /** The text as it stood on this date; the latest issue of each title when absent. */
  asOf?: string;
  http?: Http;
}

/** The eCFR Versioner API: the date each title was last issued, then one section's XML. */
export function createEcfrLoader(options: EcfrOptions): Loader {
  const http = options.http ?? createHttp({ perSecond: 1 });
  return {
    source: "ecfr",
    async *records() {
      let latest: Map<string, string> | undefined;
      for (const of of options.sections) {
        const label = `${of.title} CFR ${of.section}`;
        if (!CFR_TITLE.test(of.title) || !CFR_SECTION.test(of.section)) {
          yield { failed: label, reason: "not a CFR title and section" };
          continue;
        }
        try {
          let asOf = options.asOf;
          if (!asOf) {
            latest ??= new Map(
              titleList
                .parse(await http.json(`${API}/titles.json`))
                .titles.flatMap((t) =>
                  t.latest_issue_date ? [[String(t.number), t.latest_issue_date] as const] : [],
                ),
            );
            asOf = latest.get(String(Number(of.title)));
          }
          if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("no issue date");
          const query = new URLSearchParams({
            part: of.section.slice(0, of.section.indexOf(".")),
            section: of.section,
          });
          const xml = await http.text(
            `${API}/full/${asOf}/title-${of.title}.xml?${query}`,
            HEADERS,
          );
          yield ecfrRecord(of, asOf, xml);
        } catch (err) {
          yield failure(label, err);
        }
      }
    },
  };
}
