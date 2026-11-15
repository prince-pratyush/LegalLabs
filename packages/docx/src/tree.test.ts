import { describe, expect, it } from "vitest";
import { decodeXml, MAX_DEPTH, parseXml, XmlError } from "./tree.js";

describe("parseXml", () => {
  it("keeps source offsets", () => {
    const src = '<a x="1"><b>t&amp;</b><c/></a>';
    const root = parseXml(src);
    const [b, c] = root.children;
    expect(src.slice(b?.start, b?.end)).toBe("<b>t&amp;</b>");
    expect(src.slice(c?.start, c?.end)).toBe("<c/>");
    expect(root.attrs.x).toBe("1");
  });

  it("refuses nesting past the cap instead of overflowing the stack", () => {
    const ok = `${"<t>".repeat(MAX_DEPTH)}${"</t>".repeat(MAX_DEPTH)}`;
    expect(() => parseXml(ok)).not.toThrow();
    const deep = `${"<w:tbl>".repeat(20_000)}${"</w:tbl>".repeat(20_000)}`;
    expect(() => parseXml(deep)).toThrow(XmlError);
  });

  it("refuses a DOCTYPE", () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>')).toThrow(XmlError);
  });

  it("refuses character references outside XML's range", () => {
    expect(decodeXml("&#x41;&#66;")).toBe("AB");
    for (const bad of ["&#x110000;", "&#0;", "&#xD800;", "&#99999999999;"]) {
      expect(() => decodeXml(bad)).toThrow(XmlError);
    }
  });
});
