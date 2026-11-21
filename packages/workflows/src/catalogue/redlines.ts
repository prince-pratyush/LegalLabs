import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const redlines = files("SPA v3 against v2.docx", "Disclosure letter redline.docx");

export const redlineChanges: CatalogueEntry = {
  key: "redline_changes",
  title: "Summarise Material Changes from Redlines",
  description: "Explains what changed, clause by clause, and how much each change matters.",
  category: "Transactional",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "redlines",
        label: "Redlines",
        prompt: "Add up to 5 redlined files, or an original and a revised version.",
        max: 5,
        accept: [".docx", ".pdf"],
      },
      {
        type: "review_table.generate",
        id: "changes",
        label: "Changes",
        source: "@Redlines",
        columns: [
          { label: "Clause", type: "verbatim", prompt: "The clause number and heading changed." },
          { label: "Change", type: "free", prompt: "What the change does, in plain words." },
          {
            label: "Materiality",
            type: "classify",
            prompt: "How much the change matters to our client.",
            options: ["High", "Medium", "Low"],
          },
        ],
      },
      {
        type: "ai_action",
        id: "summary",
        label: "Change summary",
        prompt:
          "Summarise the material changes in @Changes clause by clause. Flag each as a risk (high, medium, low) and say why, most serious first.",
        context: ["@Redlines"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Change summary", as: "message", title: "Change summary" },
          { ref: "@Changes", as: "table", title: "Changes by clause" },
        ],
      },
    ],
    [
      ["redlines", "changes"],
      ["changes", "summary"],
      ["redlines", "summary"],
      ["summary", "out"],
      ["changes", "out"],
    ],
  ),
  sample: sample({ Redlines: redlines.refs }, redlines),
};
