import { describe, expect, it } from "vitest";
import { createEcfrLoader } from "./ecfr.js";
import { type AuthorityRecord, authorityRecord } from "./record.js";
import { filterSchemas } from "./sources.js";
import { loaderFor, subsetSchema } from "./subset.js";
import { collect, fakeHttp } from "./testing.js";

const TITLES = "https://www.ecfr.gov/api/versioner/v1/titles.json";
const FULL = "https://www.ecfr.gov/api/versioner/v1/full/";
const titles = { titles: [{ number: 99, latest_issue_date: "2001-02-03" }] };

// Synthetic: a made-up section shaped like the eCFR Versioner's XML.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="10.5a-1" TYPE="SECTION">
<HEAD>§ 10.5a-1 Widget duties.</HEAD>
<P>Each maker shall,
for every <I>widget</I>:</P>
<P>(a) Attach a label &amp; a serial number;</P>
<P>(1) in ink; and</P>
<P>(b) Keep records.</P>
<FP>before any sale.
</FP>
<CITA TYPE="N">[66 FR 1000, Feb. 3, 2001]
</CITA>
</DIV8>`;

const section = { title: "99", section: "10.5a-1" };
const load = (body: string, seen: string[] = [], asOf?: string, sections = [section]) =>
  collect(
    createEcfrLoader({
      sections,
      ...(asOf ? { asOf } : {}),
      http: fakeHttp({ [TITLES]: titles, [FULL]: body }, seen),
    }),
  );

describe("eCFR loader", () => {
  it("builds a section as of the title's latest issue", async () => {
    const seen: string[] = [];
    const [record] = await load(xml, seen);
    expect(seen).toEqual([TITLES, `${FULL}2001-02-03/title-99.xml?part=10&section=10.5a-1`]);
    expect(record).toMatchObject({
      ref: "ecfr:section:99-10.5a-1",
      title: "99 CFR § 10.5a-1 Widget duties (as of 2001-02-03)",
      jurisdiction: "US",
      docType: "regulation",
      decidedOn: "2001-02-03",
      url: "https://www.ecfr.gov/on/2001-02-03/title-99/section-10.5a-1",
      citations: [{ text: "99 C.F.R. § 10.5a-1", kind: "act" }],
      sections: ["§ 10.5a-1", "(a)", "§ 10.5a-1(a)", "(b)", "§ 10.5a-1(b)"],
      meta: { cfr_title: "99", cfr_part: "10", cfr_section: "10.5a-1", as_of: "2001-02-03" },
      chunks: [
        {
          sectionPath: "§ 10.5a-1",
          text: [
            "§ 10.5a-1 Widget duties.",
            "Each maker shall, for every widget:",
            "(a) Attach a label & a serial number;",
            "(1) in ink; and",
            "(b) Keep records.",
            "before any sale.",
            "[66 FR 1000, Feb. 3, 2001]",
          ].join("\n"),
        },
      ],
    });
    expect(authorityRecord.safeParse(record).success).toBe(true);
  });

  it("takes a past date when asked, without looking up the latest", async () => {
    const seen: string[] = [];
    const [record] = await load(xml, seen, "1999-01-01");
    expect(seen).toEqual([`${FULL}1999-01-01/title-99.xml?part=10&section=10.5a-1`]);
    expect((record as AuthorityRecord).meta.as_of).toBe("1999-01-01");
  });

  it("refuses document types, entity declarations and broken XML", async () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<DIV8 N="10.5a-1" TYPE="SECTION"><HEAD>h</HEAD><P>&x;</P></DIV8>`;
    for (const body of [bomb, "<DIV8 N='10.5a-1'><P>cut", "<html><p>down</p></html>", ""]) {
      const [item] = await load(body);
      expect(item).toMatchObject({ failed: "99 CFR 10.5a-1" });
    }
  });

  it("refuses odd identifiers, another section's text and an unknown title", async () => {
    const seen: string[] = [];
    const items = await load(xml, seen, undefined, [
      { title: "99", section: "../../x" },
      { title: "99", section: "10.6" },
      { title: "98", section: "10.5a-1" },
    ]);
    expect(items.map((i) => ("failed" in i ? i.failed : i.ref))).toEqual([
      "99 CFR ../../x",
      "99 CFR 10.6",
      "98 CFR 10.5a-1",
    ]);
    expect(seen).toHaveLength(2);
  });

  it("takes sections from a subset and filters by title", () => {
    expect(subsetSchema.safeParse({ ecfr: { sections: [section] } }).success).toBe(true);
    for (const bad of [{ sections: [{ title: "x", section: "1.1" }] }, { as_of: "today" }]) {
      expect(subsetSchema.safeParse({ ecfr: { sections: [], ...bad } }).success).toBe(false);
    }
    expect(loaderFor("ecfr", {}, {})?.source).toBe("ecfr");
    expect(filterSchemas.ecfr.safeParse({ titles: ["17"] }).success).toBe(true);
    expect(filterSchemas.ecfr.safeParse({ date_from: "2001-01-01" }).success).toBe(false);
  });
});
