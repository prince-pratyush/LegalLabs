import { type CatalogueEntry, files, numbered, sample, workflow } from "./define.js";

const list = files("Diligence request list.xlsx");
const room = files(...numbered("Data room document", 5, "pdf"));

export const requestList: CatalogueEntry = {
  key: "request_list_check",
  title: "Check a Diligence Request List",
  description: "Checks each request against the data room: found, partial or missing.",
  category: "Financial services",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "list",
        label: "Request list",
        prompt: "The request list.",
        max: 1,
      },
      {
        type: "user_input.file",
        id: "room",
        label: "Data room",
        prompt: "Choose the data room vault or folder, or add files.",
        max: 50,
      },
      {
        type: "review_table.generate",
        id: "status",
        label: "Request status",
        source: "@Request list",
        instructions: "Search @Data room for documents answering each request.",
        columns: [
          { label: "Request", type: "verbatim", prompt: "The request as written." },
          {
            label: "Status",
            type: "classify",
            prompt: "Whether the data room answers it.",
            options: ["Found", "Partial", "Missing"],
          },
          { label: "Matching documents", type: "free", prompt: "The documents that answer it." },
        ],
      },
      {
        type: "ai_action",
        id: "gaps",
        label: "Gaps",
        prompt:
          "Summarise the gaps in @Request status: the missing and partial requests grouped by topic, with what to ask the seller for.",
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Request status", as: "table", title: "Request status" },
          { ref: "@Gaps", as: "message", title: "Gap summary" },
        ],
      },
    ],
    [
      ["list", "status"],
      ["room", "status"],
      ["status", "gaps"],
      ["status", "out"],
      ["gaps", "out"],
    ],
  ),
  sample: sample({ "Request list": list.refs, "Data room": room.refs }, list, room),
};
