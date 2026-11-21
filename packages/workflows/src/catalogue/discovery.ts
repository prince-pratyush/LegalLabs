import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const requests = files("First requests for production.pdf");
const responses = files("Responses and objections.pdf");

export const discovery: CatalogueEntry = {
  key: "discovery_responses",
  title: "Summarise Discovery Responses and Objections",
  description: "Tabulates each request against its response, objections and deficiencies.",
  category: "Litigation",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "requests",
        label: "Requests",
        prompt: "The requests served.",
        max: 1,
      },
      {
        type: "user_input.file",
        id: "responses",
        label: "Responses",
        prompt: "The responses and objections received.",
        max: 1,
      },
      {
        type: "review_table.generate",
        id: "table",
        label: "Response table",
        source: "@Responses",
        instructions: "Match each response to its request in @Requests.",
        columns: [
          { label: "Request", type: "verbatim", prompt: "The request number and text." },
          { label: "Response summary", type: "free", prompt: "What the response gives." },
          { label: "Objections", type: "free", prompt: "Each objection raised." },
          {
            label: "Deficiency",
            type: "classify",
            prompt: "Whether the response is deficient.",
            options: ["Deficient", "Partly deficient", "Adequate"],
          },
        ],
      },
      {
        type: "drafting",
        id: "letter",
        label: "Meet and confer letter",
        format: "docx",
        mode: "from_scratch",
        instructions:
          "Draft a meet-and-confer letter raising each deficient or partly deficient response in @Response table, citing the request and asking for a supplemental response by a date.",
        context: ["@Requests", "@Responses"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Response table", as: "table", title: "Responses and objections" },
          { ref: "@Meet and confer letter", as: "file", title: "Meet-and-confer letter" },
        ],
      },
    ],
    [
      ["requests", "table"],
      ["responses", "table"],
      ["table", "letter"],
      ["requests", "letter"],
      ["responses", "letter"],
      ["table", "out"],
      ["letter", "out"],
    ],
  ),
  sample: sample({ Requests: requests.refs, Responses: responses.refs }, requests, responses),
};
