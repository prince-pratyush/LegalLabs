import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const sources = files("Regulator media release.pdf", "Amending act.pdf");

export const clientAlert: CatalogueEntry = {
  key: "client_alert",
  title: "Draft a Client Alert",
  description: "Turns source material into a client alert for a chosen audience and jurisdiction.",
  category: "General",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "sources",
        label: "Source material",
        prompt: "Add up to 10 files the alert is based on.",
        max: 10,
      },
      {
        type: "user_input.text",
        id: "audience",
        label: "Audience",
        prompt: "Who is the alert for?",
        multiline: false,
        max_chars: 500,
      },
      {
        type: "user_input.select",
        id: "jurisdiction",
        label: "Jurisdiction",
        prompt: "Jurisdiction",
        options: [
          { id: "au", label: "Australia" },
          { id: "uk", label: "United Kingdom" },
          { id: "us", label: "United States" },
          { id: "eu", label: "European Union" },
          { id: "sg", label: "Singapore" },
        ],
      },
      {
        type: "ai_action",
        id: "points",
        label: "Key points",
        prompt:
          "Summarise the key points of @Source material that matter to @Audience in @Jurisdiction: what changed, from when, who is affected and what they should do.",
        context: ["@Source material"],
      },
      {
        type: "drafting",
        id: "alert",
        label: "Client alert",
        format: "docx",
        mode: "from_scratch",
        instructions:
          "Draft a client alert of about 800 words for @Audience on the change in @Jurisdiction, built on @Key points. Use headings, a short summary first and practical next steps last. Cite the source material.",
        context: ["@Source material"],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Client alert", as: "file", title: "Client alert" },
          { ref: "@Key points", as: "message", title: "Key points" },
        ],
      },
    ],
    [
      ["sources", "points"],
      ["audience", "points"],
      ["jurisdiction", "points"],
      ["points", "alert"],
      ["sources", "alert"],
      ["audience", "alert"],
      ["jurisdiction", "alert"],
      ["alert", "out"],
      ["points", "out"],
    ],
  ),
  sample: sample(
    {
      "Source material": sources.refs,
      Audience: "General counsel of listed companies",
      Jurisdiction: "au",
    },
    sources,
  ),
};
