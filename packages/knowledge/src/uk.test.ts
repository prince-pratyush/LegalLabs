import { describe, expect, it } from "vitest";
import { authorityRecord } from "./record.js";
import { filterSchemas } from "./sources.js";
import { loaderFor, subsetSchema } from "./subset.js";
import { collect, fakeHttp } from "./testing.js";
import { createUkLegislationLoader, type UkItem } from "./uk.js";

const BASE = "https://www.legislation.gov.uk/";

const metadata = (title: string, year: number, number: number, dated: string) => `
<ukm:Metadata>
  <dc:title>${title}</dc:title>
  <dct:valid>2002-03-04</dct:valid>
  <ukm:PrimaryMetadata>
    <ukm:DocumentClassification><ukm:DocumentStatus Value="revised"/></ukm:DocumentClassification>
    <ukm:Year Value="${year}"/><ukm:Number Value="${number}"/>${dated}
    <ukm:UnappliedEffects><ukm:UnappliedEffect Type="words substituted"/></ukm:UnappliedEffects>
  </ukm:PrimaryMetadata>
</ukm:Metadata>`;

const legislation = (head: string, body: string) => `<Legislation
  xmlns="http://www.legislation.gov.uk/namespaces/legislation"
  xmlns:ukm="http://www.legislation.gov.uk/namespaces/metadata"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dct="http://purl.org/dc/terms/"
  RestrictExtent="E+W">${head}${body}</Legislation>`;

// Synthetic: a made-up Act shaped like Crown Legislation Markup Language.
const act = legislation(
  metadata("Widget Act 2001", 2001, 7, '<ukm:EnactmentDate Date="2001-02-03"/>'),
  `<Primary><Body><Part><Number>PART 1</Number><Title>Widgets</Title>
<P1group><Title>Meaning of widget</Title>
<P1 id="section-3"><Pnumber><CommentaryRef Ref="c1"/>3</Pnumber><P1para>
<P2 id="section-3-1"><Pnumber>1</Pnumber><P2para><Text>This section defines terms.</Text></P2para></P2>
<P2 id="section-3-2"><Pnumber>2</Pnumber><P2para><Text>“<Term id="term-widget">Widget</Term>” means any <Addition>small</Addition> device—</Text>
<P3 id="section-3-2-a"><Pnumber>a</Pnumber><P3para><Text>with a label.</Text></P3para></P3>
</P2para></P2>
<BlockAmendment><P1><Pnumber>99</Pnumber><P1para><Text>Quoted words of another Act.</Text></P1para></P1></BlockAmendment>
</P1para></P1></P1group>
<P1group><Title>Short title</Title><P1 id="section-4"><Pnumber>4</Pnumber><P1para>
<Text>This is the Widget Act 2001.</Text></P1para></P1></P1group>
</Part></Body>
<Schedules><Schedule id="schedule-1"><Number>SCHEDULE 1</Number><ScheduleBody>
<P1 id="schedule-1-paragraph-1"><Pnumber>1</Pnumber><P1para><Text>Schedule text.</Text></P1para></P1>
</ScheduleBody></Schedule></Schedules></Primary>
<Commentaries><Commentary id="c1"><Para><Text>Editorial note.</Text></Para></Commentary></Commentaries>`,
);

const item = (type: string, year: number, number: number): UkItem => ({ type, year, number });
const load = (routes: Record<string, string>, items: UkItem[], seen: string[] = []) =>
  collect(createUkLegislationLoader({ items, http: fakeHttp(routes, seen) }));

describe("legislation.gov.uk loader", () => {
  it("builds an Act with a chunk per section and every provision as a pin", async () => {
    const [record] = await load({ [`${BASE}ukpga/2001/7/data.xml`]: act }, [
      item("ukpga", 2001, 7),
    ]);
    expect(record).toMatchObject({
      ref: "uk_legislation:item:ukpga-2001-7",
      title: "Widget Act 2001",
      jurisdiction: "UK",
      docType: "act",
      decidedOn: "2001-02-03",
      url: `${BASE}ukpga/2001/7`,
      citations: [
        { text: "Widget Act 2001", kind: "act" },
        { text: "Widget Act 2001 c. 7", kind: "act" },
        { text: "2001 c. 7", kind: "act" },
      ],
      sections: ["s 3", "s 4", "Sch 1", "s 3(1)", "s 3(2)", "s 3(2)(a)"],
      meta: {
        type: "ukpga",
        year: 2001,
        number: 7,
        as_of: "2002-03-04",
        status: "revised",
        extent: "E+W",
        outstanding_changes: 1,
      },
      chunks: [
        {
          sectionPath: "s 3",
          text: [
            "Meaning of widget",
            "3 (1) This section defines terms.",
            "(2) “Widget” means any small device—",
            "(a) with a label.",
            "(99) Quoted words of another Act.",
          ].join("\n"),
        },
        { sectionPath: "s 4", text: "Short title\n4 This is the Widget Act 2001." },
        { sectionPath: "Sch 1", text: "SCHEDULE 1\n(1) Schedule text." },
      ],
    });
    expect(authorityRecord.safeParse(record).success).toBe(true);
  });

  it("indexes a statutory instrument by its number, at a point in time", async () => {
    const si = legislation(
      metadata("The Widget Regulations 2002", 2002, 41, '<ukm:Made Date="2002-01-05"/>'),
      `<Secondary><Body><P1 id="regulation-5"><Pnumber>5</Pnumber><P1para>
<Text>Makers must keep records.</Text></P1para></P1></Body></Secondary>`,
    );
    const seen: string[] = [];
    const [record] = await load(
      { [`${BASE}uksi/2002/41/2002-06-01/data.xml`]: si },
      [{ ...item("uksi", 2002, 41), asOf: "2002-06-01" }],
      seen,
    );
    expect(seen).toEqual([`${BASE}uksi/2002/41/2002-06-01/data.xml`]);
    expect(record).toMatchObject({
      docType: "statutory_instrument",
      decidedOn: "2002-01-05",
      url: `${BASE}uksi/2002/41/2002-06-01`,
      citations: [
        { text: "The Widget Regulations 2002", kind: "act" },
        { text: "Widget Regulations 2002", kind: "act" },
        { text: "SI 2002/41", kind: "act" },
      ],
      sections: ["reg 5"],
      meta: { as_of: "2002-06-01" },
    });
  });

  it("refuses odd identifiers, other documents, entities and pages that are not CLML", async () => {
    const bomb = `<!DOCTYPE x [<!ENTITY a "b">]>${act}`;
    const bodies: [string, string][] = [
      ["8", act],
      ["9", bomb],
      ["10", "<html><body>Generating</body></html>"],
      ["11", legislation(metadata("Empty Act 2001", 2001, 11, ""), "<Primary/>")],
    ];
    const seen: string[] = [];
    const items = await load(
      Object.fromEntries(bodies.map(([n, body]) => [`${BASE}ukpga/2001/${n}/data.xml`, body])),
      [item("../x", 2001, 7), ...bodies.map(([n]) => item("ukpga", 2001, Number(n)))],
      seen,
    );
    expect(items.map((i) => ("failed" in i ? i.failed : i.ref))).toEqual([
      "../x/2001/7",
      "ukpga/2001/8",
      "ukpga/2001/9",
      "ukpga/2001/10",
      "ukpga/2001/11",
    ]);
    expect(seen).toHaveLength(4);
  });

  it("takes items from a subset and filters by type and date", () => {
    const items = [{ type: "ukpga", year: 2018, number: 12 }];
    expect(subsetSchema.safeParse({ uk_legislation: { items } }).success).toBe(true);
    expect(
      subsetSchema.safeParse({ uk_legislation: { items: [{ ...items[0], type: "x" }] } }).success,
    ).toBe(false);
    expect(loaderFor("uk_legislation", {}, {})?.source).toBe("uk_legislation");
    expect(
      filterSchemas.uk_legislation.safeParse({ doc_types: ["act"], date_from: "2000-01-01" })
        .success,
    ).toBe(true);
    expect(filterSchemas.uk_legislation.safeParse({ courts: ["x"] }).success).toBe(false);
  });
});
