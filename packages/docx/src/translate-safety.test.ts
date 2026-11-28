import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx.js";
import { openText } from "./translate.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const parts = () =>
  unzipSync(
    buildDocx({
      author: "a",
      date: "2026-01-01T00:00:00Z",
      blocks: [{ kind: "paragraph", runs: [{ text: "Words" }] }],
    }),
  );
const body = (inner: string) =>
  strToU8(`<w:document xmlns:w="${W}"><w:body>${inner}</w:body></w:document>`);
const rels = (type: string, target: string, mode = "") =>
  strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId99" Type="${OFFICE}/${type}" Target="${target}"${mode}/></Relationships>`,
  );
const EXTERNAL = ' TargetMode="External"';

const refused = (files: Record<string, Uint8Array>) => {
  try {
    openText(zipSync(files));
    return "opened";
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("what a translated copy may carry", () => {
  it.each([
    ["a macro project", { "word/vbaProject.bin": strToU8("x") }],
    ["an embedded file", { "word/embeddings/oleObject1.bin": strToU8("x") }],
    ["an ActiveX control", { "word/activeX/activeX1.xml": strToU8("<a/>") }],
    ["an imported chunk", { "word/_rels/document.xml.rels": rels("aFChunk", "chunk.html") }],
    ["an OLE relationship", { "word/_rels/header1.xml.rels": rels("oleObject", "a.dat") }],
    [
      "a linked picture",
      { "word/_rels/document.xml.rels": rels("image", "https://evil.test/p.png", EXTERNAL) },
    ],
    [
      "a linked object",
      { "word/_rels/footer1.xml.rels": rels("oleObject", "file://x/y", EXTERNAL) },
    ],
    ["an altChunk element", { "word/document.xml": body('<w:altChunk r:id="a"/>') }],
    ["an object element", { "word/document.xml": body("<w:p><w:r><w:object/></w:r></w:p>") }],
    [
      "a DDE field split across runs",
      {
        "word/document.xml": body(
          '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DD</w:instrText></w:r><w:r><w:instrText>EAUTO cmd "x" </w:instrText></w:r></w:p>',
        ),
      },
    ],
    [
      "a simple field that fetches",
      {
        "word/document.xml": body(
          '<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://e&quot; "/></w:p>',
        ),
      },
    ],
  ])("refuses %s", (_what, extra) => {
    expect(refused({ ...parts(), ...extra })).toBe("ACTIVE_CONTENT");
  });

  it("keeps hyperlinks and ordinary fields", () => {
    const files = parts();
    files["word/_rels/header1.xml.rels"] = rels("hyperlink", "https://example.com", EXTERNAL);
    files["word/footer1.xml"] = strToU8(
      `<w:ftr xmlns:w="${W}"><w:p><w:fldSimple w:instr=" PAGE "/></w:p></w:ftr>`,
    );
    expect(refused(files)).toBe("opened");
  });

  it("drops the link to an attached template", () => {
    const files = parts();
    files["word/settings.xml"] = strToU8(
      `<w:settings xmlns:w="${W}"><w:attachedTemplate r:id="rId99"/><w:zoom/></w:settings>`,
    );
    files["word/_rels/settings.xml.rels"] = rels(
      "attachedTemplate",
      "file:///\\\\server\\t.dotm",
      EXTERNAL,
    );
    const out = unzipSync(openText(zipSync(files)).apply(["Mots"]));
    expect(strFromU8(out["word/settings.xml"] as Uint8Array)).toBe(
      `<w:settings xmlns:w="${W}"><w:zoom/></w:settings>`,
    );
    expect(strFromU8(out["word/_rels/settings.xml.rels"] as Uint8Array)).not.toContain("server");
  });

  it("refuses a file that would be costly to parse", () => {
    const many = { ...parts(), "word/document.xml": body("<w:p/>".repeat(200_001)) };
    expect(refused(many)).toBe("TOO_LARGE");
    const long = { ...parts(), "word/header1.xml": strToU8(`<a>${"x".repeat(6_000_000)}</a>`) };
    expect(refused(long)).toBe("TOO_LARGE");
    const heavy = parts();
    for (let i = 0; i < 4; i++) heavy[`word/media/p${i}.png`] = new Uint8Array(15 * 1024 * 1024);
    expect(refused(heavy)).toBe("TOO_LARGE");
  });
});
