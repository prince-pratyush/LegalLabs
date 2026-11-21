import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const doc = files("Engagement letter.docx");

export const proofread: CatalogueEntry = {
  key: "proofread",
  title: "Proofread for Spelling and Grammar",
  description: "Corrects spelling and grammar in a Word file as tracked changes.",
  category: "General",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "doc",
        label: "Document",
        prompt: "Add the Word file to proofread.",
        max: 1,
        accept: [".docx"],
      },
      {
        type: "user_input.select",
        id: "style",
        label: "Style",
        prompt: "Which style should the corrections follow?",
        options: [
          { id: "house", label: "House style" },
          { id: "plain", label: "Plain English" },
          { id: "legal", label: "Formal legal" },
        ],
      },
      {
        type: "drafting",
        id: "proofread",
        label: "Proofread",
        format: "docx",
        mode: "edit_file",
        base: "@Document",
        instructions:
          "Correct spelling, grammar and punctuation in @Style style. Change nothing of substance; leave defined terms and cross-references alone.",
        track_changes: true,
      },
      {
        type: "ai_action",
        id: "summary",
        label: "Change summary",
        prompt:
          "Summarise the categories of change made in @Proofread (spelling, grammar, punctuation, style), with a count and one example for each.",
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Proofread", as: "file", title: "Tracked changes" },
          { ref: "@Change summary", as: "message", title: "Summary of changes" },
        ],
      },
    ],
    [
      ["doc", "proofread"],
      ["style", "proofread"],
      ["proofread", "summary"],
      ["proofread", "out"],
      ["summary", "out"],
    ],
  ),
  sample: sample({ Document: doc.refs, Style: "legal" }, doc),
};
