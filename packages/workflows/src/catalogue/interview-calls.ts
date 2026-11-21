import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const calls = files("Expert call 1.txt", "Expert call 2.txt", "Management call.m4a");

export const interviewCalls: CatalogueEntry = {
  key: "interview_calls",
  title: "Summarise Interview Calls",
  description: "Summarises each call and tabulates who said what, and when.",
  category: "Financial services",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "calls",
        label: "Calls",
        prompt: "Add up to 10 recordings or transcripts.",
        max: 10,
      },
      {
        type: "review_table.generate",
        id: "statements",
        label: "Statements",
        source: "@Calls",
        columns: [
          { label: "Speaker", type: "verbatim", prompt: "Who is speaking." },
          { label: "Topic", type: "free", prompt: "The topic of the statement." },
          { label: "Statement", type: "verbatim", prompt: "What they said, quoted." },
          { label: "Time", type: "verbatim", prompt: "The timestamp in the call." },
        ],
      },
      {
        type: "ai_action",
        id: "summaries",
        label: "Call summaries",
        prompt:
          "Summarise each call in @Calls separately: participants, main points, figures given and follow-ups. Use @Statements for quotes.",
        context: ["@Calls"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Call summaries", as: "message", title: "Call summaries" },
          { ref: "@Statements", as: "table", title: "Statements" },
        ],
      },
    ],
    [
      ["calls", "statements"],
      ["statements", "summaries"],
      ["calls", "summaries"],
      ["summaries", "out"],
      ["statements", "out"],
    ],
  ),
  sample: sample({ Calls: calls.refs }, calls),
};
