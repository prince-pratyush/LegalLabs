import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const docs = files("Supply agreement.docx", "Side letter.docx");

export const translate: CatalogueEntry = {
  key: "translate",
  title: "Translate into Another Language",
  description: "Translates up to 10 files into a chosen language, keeping their formatting.",
  category: "General",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "docs",
        label: "Documents",
        prompt: "Add up to 10 files to translate.",
        max: 10,
        accept: [".docx", ".pdf"],
      },
      {
        type: "user_input.select",
        id: "lang",
        label: "Language",
        prompt: "Translate into",
        options: [
          { id: "fr", label: "French" },
          { id: "de", label: "German" },
          { id: "es", label: "Spanish" },
          { id: "ja", label: "Japanese" },
          { id: "zh", label: "Chinese (Simplified)" },
          { id: "en", label: "English" },
        ],
      },
      {
        type: "user_input.select",
        id: "format",
        label: "Formatting",
        prompt: "Formatting",
        options: [
          { id: "preserve", label: "Preserve the original formatting" },
          { id: "plain", label: "Plain text layout" },
        ],
        default_option_ids: ["preserve"],
        optional: true,
      },
      {
        type: "drafting",
        id: "translated",
        label: "Translated",
        format: "docx",
        mode: "edit_file",
        base: "@Documents",
        instructions:
          "Translate the whole file into @Language. Formatting: @Formatting. Keep defined terms, party names and citations as they are, and do not add commentary.",
        track_changes: false,
      },
      {
        type: "ai_action",
        id: "glossary",
        label: "Glossary",
        prompt:
          "List the defined terms, names and citations kept in their original language in @Translated, with the @Language rendering used for each where one was given.",
        context: ["@Documents"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Translated", as: "file", title: "Translated files" },
          { ref: "@Glossary", as: "message", title: "Glossary of retained terms" },
        ],
      },
    ],
    [
      ["docs", "translated"],
      ["lang", "translated"],
      ["format", "translated"],
      ["translated", "glossary"],
      ["docs", "glossary"],
      ["lang", "glossary"],
      ["translated", "out"],
      ["glossary", "out"],
    ],
  ),
  sample: sample({ Documents: docs.refs, Language: "fr", Formatting: "preserve" }, docs),
};
