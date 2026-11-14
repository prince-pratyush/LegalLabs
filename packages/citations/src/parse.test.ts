import { describe, expect, it } from "vitest";
import { parseCitedAnswer } from "./index.js";

describe("parseCitedAnswer", () => {
  it("leaves text without tags alone", () => {
    expect(parseCitedAnswer("No tags here.")).toEqual({ text: "No tags here.", citations: [] });
  });

  it("removes a tag and records where it was", () => {
    const parsed = parseCitedAnswer(
      'The supplier is liable<c doc="D1" page="3" quote="accepts liability"/>. Done.',
    );
    expect(parsed).toEqual({
      text: "The supplier is liable. Done.",
      citations: [{ at: 22, doc: "D1", page: 3, quote: "accepts liability" }],
    });
  });

  it("measures each offset in the cleaned text", () => {
    const parsed = parseCitedAnswer(
      'A<c doc="D1" page="1" quote="aaa"/> and B<c doc="D2" page="2" quote="bbb"/>.',
    );
    expect(parsed.text).toBe("A and B.");
    expect(parsed.citations.map((c) => c.at)).toEqual([1, 7]);
  });

  it("accepts single quotes, any attribute order and an open tag", () => {
    const parsed = parseCitedAnswer("X<c quote='q' page='4' doc='D1'>Y</c>");
    expect(parsed).toEqual({
      text: "XY",
      citations: [{ at: 1, doc: "D1", page: 4, quote: "q" }],
    });
  });

  it("allows > inside a quoted value", () => {
    const parsed = parseCitedAnswer('A<c doc="D1" page="1" quote="if x > y then"/>B');
    expect(parsed).toEqual({
      text: "AB",
      citations: [{ at: 1, doc: "D1", page: 1, quote: "if x > y then" }],
    });
  });

  it("decodes basic entities in values", () => {
    const parsed = parseCitedAnswer(
      '<c doc="D1" page="1" quote="&quot;Loss&quot; &amp; &lt;cost&gt; &#39;x&apos; &#8212;"/>',
    );
    expect(parsed.citations[0]?.quote).toBe("\"Loss\" & <cost> 'x' —");
  });

  it("keeps a tag missing fields as a citation with nulls", () => {
    const parsed = parseCitedAnswer('A<c doc="D1"/> B<c page="two" quote="z"/>');
    expect(parsed).toEqual({
      text: "A B",
      citations: [
        { at: 1, doc: "D1", page: null, quote: null },
        { at: 3, doc: null, page: null, quote: "z" },
      ],
    });
  });

  it("rejects pages that are not whole positive numbers", () => {
    for (const page of ["0", "-1", "1.5", "1e3", " 2", "99999999999"]) {
      expect(parseCitedAnswer(`<c doc="D1" page="${page}" quote="q"/>`).citations[0]?.page).toBe(
        null,
      );
    }
  });

  it("strips a truncated tag and keeps it as unresolved", () => {
    const parsed = parseCitedAnswer('The cap is $1m<c doc="D1" page="2" quote="the cap');
    expect(parsed).toEqual({
      text: "The cap is $1m",
      citations: [{ at: 14, doc: "D1", page: 2, quote: null }],
    });
  });

  it("strips a tag cut off before any attribute", () => {
    expect(parseCitedAnswer("Text<c").text).toBe("Text");
    expect(parseCitedAnswer("Text<").text).toBe("Text");
    expect(parseCitedAnswer("Text<c ").text).toBe("Text");
  });

  it("strips a malformed tag up to its end", () => {
    const parsed = parseCitedAnswer('A<c doc="D1" page=3 quote="q"/>B');
    expect(parsed.text).toBe("AB");
    expect(parsed.citations).toEqual([{ at: 1, doc: "D1", page: null, quote: null }]);
  });

  it("does not mistake other markup for a citation", () => {
    const raw = "Use <code>x</code> and <cite>y</cite>, a<b.";
    expect(parseCitedAnswer(raw)).toEqual({ text: raw, citations: [] });
  });

  it("keeps the first of a repeated attribute and ignores unknown ones", () => {
    const parsed = parseCitedAnswer('<c doc="D1" doc="D2" page="1" quote="q" extra="e"/>');
    expect(parsed.citations).toEqual([{ at: 0, doc: "D1", page: 1, quote: "q" }]);
  });

  it("stays linear on hostile input", () => {
    const raw = `${'<c doc="'.repeat(20_000)}x`;
    const started = performance.now();
    parseCitedAnswer(raw);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("parseCitedAnswer authority tags", () => {
  it("reads an authority citation with its pin and quote", () => {
    const parsed = parseCitedAnswer(
      'Plausibility is required<c authority="556 U.S. 662" pin="678" quote="facial plausibility"/>.',
    );
    expect(parsed.citations).toEqual([
      {
        at: 24,
        doc: null,
        page: null,
        quote: "facial plausibility",
        authority: "556 U.S. 662",
        pin: "678",
      },
    ]);
  });

  it("leaves the authority fields off a document tag", () => {
    const [citation] = parseCitedAnswer('A<c doc="D1" page="1" quote="aaa"/>').citations;
    expect(citation).not.toHaveProperty("authority");
    expect(citation).not.toHaveProperty("pin");
  });
});
