import { type CatalogueEntry, files, numbered, sample, workflow } from "./define.js";

const opinions = files(...numbered("Opinion", 5, "pdf"));

export const courtOpinions: CatalogueEntry = {
  key: "court_opinion_review",
  title: "Court Opinion Review",
  description:
    "Tabulates court, date, holding and disposition across opinions, then synthesises them.",
  category: "Litigation",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "opinions",
        label: "Opinions",
        prompt: "Add up to 50 opinions, or choose a vault.",
        max: 50,
      },
      {
        type: "review_table.generate",
        id: "table",
        label: "Opinion table",
        source: "@Opinions",
        columns: [
          { label: "Court", type: "verbatim", prompt: "The court that decided it." },
          { label: "Date", type: "date", prompt: "The date of judgment." },
          { label: "Holding", type: "free", prompt: "The holding, in one or two sentences." },
          {
            label: "Disposition",
            type: "classify",
            prompt: "How the court disposed of the matter.",
            options: ["Affirmed", "Reversed", "Remanded", "Dismissed", "Other"],
          },
          { label: "Cited authorities", type: "free", prompt: "The main authorities relied on." },
        ],
      },
      {
        type: "ai_action",
        id: "synthesis",
        label: "Synthesis",
        prompt:
          "Synthesise the opinions in @Opinion table: the common rule, where courts diverge and the trend over time. Cite each opinion.",
        context: ["@Opinions"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Opinion table", as: "table", title: "Opinions" },
          { ref: "@Synthesis", as: "message", title: "Synthesis" },
        ],
      },
    ],
    [
      ["opinions", "table"],
      ["table", "synthesis"],
      ["opinions", "synthesis"],
      ["table", "out"],
      ["synthesis", "out"],
    ],
  ),
  sample: sample({ Opinions: opinions.refs }, opinions),
};
