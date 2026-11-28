import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx.js";
import { readDocx } from "./read.js";
import { openText } from "./translate.js";

const source = () =>
  buildDocx({
    title: "Lease",
    author: "a",
    date: "2026-01-01T00:00:00Z",
    blocks: [
      { kind: "heading1", runs: [{ text: "Term" }] },
      {
        kind: "numbered",
        runs: [{ text: "The " }, { text: "Tenant", bold: true }, { text: " pays." }],
      },
      { kind: "paragraph", runs: [{ text: "12.1" }] },
    ],
  });

const part = (bytes: Uint8Array, name = "word/document.xml") =>
  strFromU8(unzipSync(bytes)[name] as Uint8Array);
// Everything but the words.
const shape = (xml: string) => xml.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>|<w:t\/>/g, "<w:t/>");

describe("translating a .docx in place", () => {
  it("changes only the words, so headings, numbering and bold survive", () => {
    const bytes = source();
    const open = openText(bytes);
    expect(open.segments).toEqual(["Lease", "Term", "The ", "Tenant", " pays.", "12.1"]);
    const out = open.apply(["Bail", "Durée", "Le ", "Locataire", " paie & <signe>.", null]);
    expect(shape(part(out))).toBe(shape(part(bytes)));
    expect(part(out)).toContain("paie &amp; &lt;signe&gt;.");
    expect(readDocx(out).paragraphs.map((p) => p.text)).toEqual([
      "Bail",
      "Durée",
      "Le Locataire paie & <signe>.",
      "12.1",
    ]);
    const names = Object.keys(unzipSync(bytes)).sort();
    expect(Object.keys(unzipSync(out)).sort()).toEqual(names);
    for (const name of names) {
      if (name !== "word/document.xml") expect(part(out, name)).toBe(part(bytes, name));
    }
  });

  it("joins runs of one look, keeps tabs and breaks in place, and reads headers and tables", () => {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const body = (inner: string, root = "w:document") =>
      strToU8(`<?xml version="1.0"?><${root} xmlns:w="${W}">${inner}</${root}>`);
    const files = unzipSync(source());
    files["word/document.xml"] = body(
      `<w:body><w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo</w:t></w:r><w:r><w:tab/><w:t>there</w:t></w:r></w:p>` +
        `<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:i/></w:rPr><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
        `<w:p><w:r><w:instrText> PAGE </w:instrText><w:delText>old</w:delText></w:r></w:p></w:body>`,
    );
    files["word/header1.xml"] = body("<w:p><w:r><w:t>Draft</w:t></w:r></w:p>", "w:hdr");
    const open = openText(zipSync(files));
    expect(open.segments).toEqual(["Hello", "there", "cell", "Draft"]);
    const out = open.apply(["Bonjour", "là", "case", "Projet"]);
    expect(part(out)).toContain(
      '<w:t xml:space="preserve">Bonjour</w:t></w:r><w:r><w:t></w:t></w:r><w:r><w:tab/>',
    );
    expect(part(out)).toContain("<w:instrText> PAGE </w:instrText><w:delText>old</w:delText>");
    expect(part(out, "word/header1.xml")).toContain("Projet");
  });

  it("refuses what isn't a readable .docx", () => {
    expect(() => openText(strToU8("plain"))).toThrow(/not a readable/);
    const files = unzipSync(source());
    files["word/document.xml"] = strToU8('<!DOCTYPE x [<!ENTITY a "b">]><w:document/>');
    expect(() => openText(zipSync(files))).toThrow();
  });
});
