import { type CatalogueEntry, files, numbered, sample, workflow } from "./define.js";

const docs = files(...numbered("Correspondence", 6, "pdf"));

export const timeline: CatalogueEntry = {
  key: "timeline",
  title: "Extract Timeline of Key Events",
  description: "Builds a table of dated events from up to 50 files, then a narrative timeline.",
  category: "General",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "docs",
        label: "Documents",
        prompt: "Add up to 50 files.",
        max: 50,
      },
      {
        type: "review_table.generate",
        id: "events",
        label: "Events",
        source: "@Documents",
        columns: [
          { label: "Date", type: "date", prompt: "The date of each key event described." },
          { label: "Event", type: "free", prompt: "What happened, in one sentence." },
          { label: "Parties", type: "free", prompt: "The people or entities involved." },
          { label: "Source", type: "verbatim", prompt: "The passage the event comes from." },
        ],
      },
      {
        type: "ai_action",
        id: "narrative",
        label: "Narrative",
        prompt:
          "Write a narrative timeline in date order from @Events, noting gaps and conflicting dates. Cite the source for each event.",
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Events", as: "table", title: "Timeline table" },
          { ref: "@Narrative", as: "message", title: "Narrative timeline" },
        ],
      },
    ],
    [
      ["docs", "events"],
      ["events", "narrative"],
      ["events", "out"],
      ["narrative", "out"],
    ],
  ),
  sample: sample({ Documents: docs.refs }, docs),
};
