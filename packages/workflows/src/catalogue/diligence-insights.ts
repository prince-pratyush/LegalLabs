import { type CatalogueEntry, files, numbered, sample, workflow } from "./define.js";

const room = files(...numbered("Data room file", 8, "pdf"));

export const diligenceInsights: CatalogueEntry = {
  key: "diligence_insights",
  title: "Generate Diligence Insights",
  description: "Reads a data room against the deal thesis and reports insights and red flags.",
  category: "Financial services",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "room",
        label: "Data room",
        prompt: "Choose the data room vault or folder, or add files.",
        max: 50,
      },
      {
        type: "user_input.text",
        id: "thesis",
        label: "Deal thesis",
        prompt: "The deal thesis to test.",
        max_chars: 5000,
      },
      {
        type: "review_table.generate",
        id: "flags",
        label: "Red flags",
        source: "@Data room",
        instructions: "Read each file against this thesis: @Deal thesis.",
        columns: [
          { label: "Issue", type: "free", prompt: "Any issue that cuts against the thesis." },
          { label: "Evidence", type: "verbatim", prompt: "The passage showing it." },
          {
            label: "Severity",
            type: "classify",
            prompt: "How serious the issue is for the deal.",
            options: ["Red", "Amber", "Green"],
          },
        ],
      },
      {
        type: "ai_action",
        id: "insights",
        label: "Insights",
        prompt:
          "Test @Deal thesis against @Data room. Report what supports it, what undermines it and what is missing, using @Red flags. State how much of the data room was read.",
        context: ["@Data room", "@Red flags"],
        deep_analysis: true,
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Insights", as: "message", title: "Insights report" },
          { ref: "@Red flags", as: "table", title: "Red flags" },
        ],
      },
    ],
    [
      ["room", "flags"],
      ["thesis", "flags"],
      ["flags", "insights"],
      ["room", "insights"],
      ["thesis", "insights"],
      ["insights", "out"],
      ["flags", "out"],
    ],
  ),
  sample: sample(
    {
      "Data room": room.refs,
      "Deal thesis":
        "Recurring revenue is contracted for three years with no change-of-control exits.",
    },
    room,
  ),
};
