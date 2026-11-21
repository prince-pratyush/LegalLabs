import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  type BundleOptions,
  parseFrontmatter,
  readBundle,
  safePath,
  writeBundle,
} from "./skill.js";

const options: BundleOptions = {
  sourceStatus: (s) =>
    s === "courtlistener" ? "not_enabled" : s === "web" ? "ok" : "unknown_source",
  refResolves: () => false,
};
const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]),
    ),
  );
const manifest = (extra: object = {}) =>
  JSON.stringify({ schema: "counsel.skill/1", name: "NDA review", ...extra });

describe("a markdown bundle", () => {
  it("reads frontmatter and the instructions below it", () => {
    const md = `---\nname: NDA first pass\ndescription: Reviews NDAs.\npractice_areas: [commercial, data-protection]\nversion: 3\n---\nCheck the term.\n`;
    const r = readBundle(strToU8(md), "nda.md", options);
    expect(r.ok && r.preview).toMatchObject({
      title: "NDA first pass",
      description: "Reviews NDAs.",
      practice_areas: ["commercial", "data-protection"],
      instructions: "Check the term.",
    });
  });

  it("falls back to the file name and refuses empty instructions", () => {
    const r = readBundle(strToU8("Do the thing."), "my-agent.md", options);
    expect(r.ok && r.preview.title).toBe("my-agent");
    expect(readBundle(strToU8("---\nname: x\n---\n"), "x.md", options)).toMatchObject({
      ok: false,
      code: "SKILL_NO_INSTRUCTIONS",
    });
  });

  it("refuses a file over 1 MB", () => {
    expect(readBundle(new Uint8Array(1024 * 1024 + 1).fill(97), "big.md", options)).toMatchObject({
      ok: false,
      code: "SKILL_TOO_LARGE",
    });
  });
});

describe("a skill archive", () => {
  it("lists importable files and sources the workspace hasn't enabled", () => {
    const r = readBundle(
      zip({
        "SKILL.md": "Use the playbook.",
        "manifest.json": manifest({
          attachments: [{ label: "playbook", kind: "upload", path: "files/playbook.docx" }],
          sources: [
            { label: "cases", kind: "knowledge_source", source: "courtlistener" },
            { label: "web", kind: "knowledge_source", source: "web" },
            { label: "x", kind: "connector", source: "mcp:other" },
          ],
        }),
        "files/playbook.docx": "docx bytes",
      }),
      "nda.skill",
      options,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.files).toMatchObject([{ name: "playbook.docx", status: "ok" }]);
    expect(r.preview.sources.map((s) => s.status)).toEqual(["not_enabled", "ok", "unknown_source"]);
  });

  it("strips a single top folder", () => {
    const r = readBundle(
      zip({ "bundle/SKILL.md": "Hello", "bundle/manifest.json": manifest() }),
      "b.zip",
      options,
    );
    expect(r.ok && r.preview.title).toBe("NDA review");
  });

  it("lets the manifest win over the frontmatter", () => {
    const r = readBundle(
      zip({ "SKILL.md": "---\nname: Old\n---\nGo.", "manifest.json": manifest({ name: "New" }) }),
      "x.skill",
      options,
    );
    expect(r.ok && r.preview.title).toBe("New");
  });

  it("refuses paths that leave the bundle, absolute paths and nested archives", () => {
    for (const bad of ["../etc/passwd", "/etc/passwd", "files/../../x", "a\\b.md"]) {
      expect(readBundle(zip({ "SKILL.md": "x", [bad]: "y" }), "x.zip", options)).toMatchObject({
        ok: false,
        code: "SKILL_UNSAFE_ARCHIVE",
      });
    }
    expect(
      readBundle(zip({ "SKILL.md": "x", "files/inner.zip": "y" }), "x.zip", options),
    ).toMatchObject({ ok: false, code: "SKILL_UNSAFE_ARCHIVE" });
    const inner = zip({ "a.txt": "a" });
    expect(
      readBundle(zip({ "SKILL.md": "x", "files/doc.pdf": inner }), "x.zip", options),
    ).toMatchObject({
      ok: false,
      code: "SKILL_UNSAFE_ARCHIVE",
    });
    expect(
      readBundle(
        zip({ "SKILL.md": "x", "manifest.json": manifest({ instructions_path: "../outside.md" }) }),
        "x.zip",
        options,
      ),
    ).toMatchObject({ ok: false, code: "SKILL_UNSAFE_ARCHIVE" });
  });

  it("reports a manifest that fails the schema, with the issues", () => {
    const r = readBundle(
      zip({ "SKILL.md": "x", "manifest.json": JSON.stringify({ schema: "nope", name: "" }) }),
      "x.zip",
      options,
    );
    expect(r).toMatchObject({ ok: false, code: "SKILL_MANIFEST_INVALID" });
    expect(!r.ok && r.issues?.length).toBeGreaterThan(0);
  });

  it("needs instructions", () => {
    expect(readBundle(zip({ "manifest.json": manifest() }), "x.zip", options)).toMatchObject({
      ok: false,
      code: "SKILL_NO_INSTRUCTIONS",
    });
  });

  it("refuses more than 50 embedded files, and flags oversized or odd ones", () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`files/f${i}.txt`, "x"]));
    expect(readBundle(zip({ "SKILL.md": "x", ...many }), "x.zip", options)).toMatchObject({
      ok: false,
      code: "SKILL_TOO_LARGE",
    });
    const r = readBundle(
      zip({
        "SKILL.md": "x",
        "manifest.json": manifest({
          attachments: [
            { label: "big", kind: "upload", path: "files/big.pdf" },
            { label: "exe", kind: "upload", path: "files/run.exe" },
          ],
        }),
        "files/big.pdf": new Uint8Array(20).fill(1),
        "files/run.exe": "MZ",
      }),
      "x.zip",
      { ...options, maxFileBytes: 10 },
    );
    expect(r.ok && r.preview.files.map((f) => f.status)).toEqual(["too_large", "unsupported"]);
  });

  it("resolves non-upload references or marks them unresolved", () => {
    const r = readBundle(
      zip({
        "SKILL.md": "x",
        "manifest.json": manifest({
          attachments: [
            {
              label: "vault",
              kind: "vault",
              ref: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
              name: "NDAs",
            },
          ],
        }),
      }),
      "x.zip",
      options,
    );
    expect(r.ok && r.preview.refs).toMatchObject([{ name: "NDAs", resolved: false }]);
  });
});

describe("export", () => {
  it("round-trips through the reader", () => {
    const bytes = writeBundle({
      title: "NDA review",
      description: "d",
      practice_areas: ["commercial"],
      instructions: "Check the term.",
      attachments: [
        { label: "playbook", kind: "upload", ref: "doc-1", name: "playbook.docx" },
        {
          label: "vault",
          kind: "vault",
          ref: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
          name: "NDAs",
        },
      ],
      sources: [{ label: "web", kind: "knowledge_source", source: "web" }],
      uploads: new Map([["playbook", { name: "playbook.docx", bytes: strToU8("docx") }]]),
      origin: {
        exported_from: "legallabs",
        agent_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
        version: 2,
      },
    });
    const r = readBundle(bytes, "x.skill", { ...options, refResolves: () => true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview).toMatchObject({
      title: "NDA review",
      instructions: "Check the term.",
      practice_areas: ["commercial"],
    });
    expect(r.preview.files.map((f) => f.name)).toEqual(["playbook.docx"]);
    expect(r.preview.refs[0]).toMatchObject({ name: "NDAs", resolved: true });
  });
});

describe("helpers", () => {
  it("normalises safe paths and rejects unsafe ones", () => {
    expect(safePath("files//a/./b.txt")).toBe("files/a/b.txt");
    expect(safePath("a/../b")).toBeNull();
    expect(safePath("")).toBeNull();
    expect(parseFrontmatter("no frontmatter").body).toBe("no frontmatter");
  });
});
