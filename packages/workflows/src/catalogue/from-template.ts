import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const template = files("Share sale template.docx");
const support = files("Term sheet.pdf", "Cap table.xlsx");

export const fromTemplate: CatalogueEntry = {
  key: "draft_from_template",
  title: "Draft from Template",
  description:
    "Fills a firm template from facts and supporting files, and lists what is still open.",
  category: "General",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "template",
        label: "Template",
        prompt: "Choose the template to fill.",
        max: 1,
        accept: [".docx"],
      },
      {
        type: "user_input.text",
        id: "facts",
        label: "Facts",
        prompt: "The facts and any instructions for this draft.",
        max_chars: 10000,
      },
      {
        type: "user_input.file",
        id: "support",
        label: "Supporting files",
        prompt: "Up to 10 files with more detail (optional).",
        min: 0,
        max: 10,
        optional: true,
      },
      {
        type: "drafting",
        id: "filled",
        label: "Filled draft",
        format: "docx",
        mode: "edit_file",
        base: "@Template",
        instructions:
          "Fill in the template from @Facts and the supporting files (@Supporting files). Keep the template's wording except where the facts require a change; leave a bracketed placeholder for anything unknown.",
        context: ["@Supporting files"],
        track_changes: false,
      },
      {
        type: "ai_action",
        id: "open",
        label: "Open items",
        prompt:
          "List every bracketed placeholder or assumption left in @Filled draft as an open item, with the clause it is in and the question to ask the client.",
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Filled draft", as: "file", title: "Filled draft" },
          { ref: "@Open items", as: "message", title: "Open items" },
        ],
      },
    ],
    [
      ["template", "filled"],
      ["facts", "filled"],
      ["support", "filled"],
      ["filled", "open"],
      ["filled", "out"],
      ["open", "out"],
    ],
  ),
  sample: sample(
    {
      Template: template.refs,
      Facts: "Buyer: Acme Pty Ltd. Seller: Nadir Holdings. Price A$12m, completion 30 June.",
      "Supporting files": support.refs,
    },
    template,
    support,
  ),
};
