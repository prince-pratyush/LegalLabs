import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const transcripts = files("Deposition of J. Smith.pdf", "Hearing day 2.pdf");

export const transcriptTopics: CatalogueEntry = {
  key: "transcript_topics",
  title: "Analyse a Deposition or Court Transcript for Key Topics",
  description: "Finds the key topics in transcripts with page and line cites.",
  category: "Litigation",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "transcripts",
        label: "Transcripts",
        prompt: "Add up to 5 transcripts.",
        max: 5,
      },
      {
        type: "user_input.text",
        id: "topics",
        label: "Topics of interest",
        prompt: "Topics to focus on (optional).",
        optional: true,
        default_text: "Every significant topic",
      },
      {
        type: "review_table.generate",
        id: "table",
        label: "Topic table",
        source: "@Transcripts",
        instructions: "Focus on: @Topics of interest.",
        columns: [
          { label: "Topic", type: "free", prompt: "The topic discussed." },
          { label: "Witness", type: "verbatim", prompt: "Who gave the testimony." },
          { label: "Cite", type: "verbatim", prompt: "Page and line, as page:line." },
          { label: "Quote", type: "verbatim", prompt: "The key words, quoted exactly." },
        ],
      },
      {
        type: "ai_action",
        id: "topics_out",
        label: "Topics",
        prompt:
          "List the key topics in @Transcripts, focusing on @Topics of interest. For each, summarise the testimony and give page:line cites, drawing on @Topic table.",
        context: ["@Transcripts"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Topics", as: "message", title: "Topics with cites" },
          { ref: "@Topic table", as: "table", title: "Topic table" },
        ],
      },
    ],
    [
      ["transcripts", "table"],
      ["topics", "table"],
      ["table", "topics_out"],
      ["transcripts", "topics_out"],
      ["topics", "topics_out"],
      ["topics_out", "out"],
      ["table", "out"],
    ],
  ),
  sample: sample({ Transcripts: transcripts.refs }, transcripts),
};
