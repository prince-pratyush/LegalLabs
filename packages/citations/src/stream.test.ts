import { describe, expect, it } from "vitest";
import { citationStream, parseCitedAnswer } from "./index.js";

const ANSWER =
  'Rent is due monthly.<c doc="D1" page="2" quote="pay rent monthly"/> Interest is 4% if x > y.<c doc="D1" page="2" quote="if x > y"/> Done';

function streamInPieces(raw: string, size: number) {
  const stream = citationStream();
  let text = "";
  const citations = [];
  for (let i = 0; i < raw.length; i += size) {
    const piece = stream.push(raw.slice(i, i + size));
    expect(piece.text).not.toContain("<");
    text += piece.text;
    citations.push(...piece.citations);
  }
  const rest = stream.end();
  return { text: text + rest.text, citations: [...citations, ...rest.citations] };
}

describe("citationStream", () => {
  it.each([1, 2, 3, 7, 50])("matches a one-shot parse when fed %i characters at a time", (size) => {
    expect(streamInPieces(ANSWER, size)).toEqual(parseCitedAnswer(ANSWER));
  });

  it("holds back a tag until it closes", () => {
    const stream = citationStream();
    expect(stream.push('Claim.<c doc="D1" page="1" quo')).toEqual({
      text: "Claim.",
      citations: [],
    });
    expect(stream.push('te="words"/> More')).toEqual({
      text: " More",
      citations: [{ at: 6, doc: "D1", auth: null, page: 1, quote: "words" }],
    });
  });

  it("keeps a tag cut off at the end as a citation", () => {
    const stream = citationStream();
    stream.push('Claim.<c doc="D1" page="1"');
    expect(stream.end().citations).toHaveLength(1);
  });

  it("lets a plain less-than sign through once it is clearly not a tag", () => {
    const stream = citationStream();
    expect(stream.push("a < b").text).toBe("a ");
    expect(stream.end().text).toBe("< b");
  });
});
