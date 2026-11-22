import { type CatalogueEntry, sample, workflow } from "./define.js";

export const researchMemo: CatalogueEntry = {
  key: "research_memo",
  title: "Draft Legal Research Memo",
  description: "Researches a question in public law and on the web, then writes a memo.",
  category: "Litigation",
  definition: workflow(
    [
      {
        type: "user_input.text",
        id: "question",
        label: "Question",
        prompt: "The legal question to research.",
        max_chars: 4000,
      },
      {
        type: "user_input.select",
        id: "jurisdiction",
        label: "Jurisdiction",
        prompt: "Jurisdiction",
        options: [
          { id: "au", label: "Australia" },
          { id: "uk", label: "England and Wales" },
          { id: "us", label: "United States (federal)" },
          { id: "sg", label: "Singapore" },
        ],
      },
      {
        type: "ai_action",
        id: "research",
        label: "Research",
        prompt:
          "Research @Question under the law of @Jurisdiction. Give the governing rule, the leading authorities with pinpoint citations, and any split or open point. Use only authorities you can cite from the sources.",
        sources: [
          { kind: "knowledge_source", source: "public_law" },
          { kind: "knowledge_source", source: "web" },
        ],
        deep_analysis: true,
      },
      {
        type: "drafting",
        id: "memo",
        label: "Memo",
        format: "docx",
        mode: "from_scratch",
        instructions:
          "Write a research memo answering @Question for @Jurisdiction: question presented, short answer, discussion and conclusion. Build it on @Research and cite each authority.",
        context: ["@Research"],
      },
      {
        type: "review_table.generate",
        id: "authorities",
        label: "Authorities",
        source: "@Memo",
        columns: [
          { label: "Authority", type: "verbatim", prompt: "Each case or statute cited." },
          { label: "Citation", type: "verbatim", prompt: "Its full citation with pinpoint." },
          { label: "Proposition", type: "free", prompt: "What the memo cites it for." },
        ],
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Memo", as: "file", title: "Research memo" },
          { ref: "@Authorities", as: "table", title: "Authority list" },
        ],
      },
    ],
    [
      ["question", "research"],
      ["jurisdiction", "research"],
      ["research", "memo"],
      ["question", "memo"],
      ["jurisdiction", "memo"],
      ["memo", "authorities"],
      ["memo", "out"],
      ["authorities", "out"],
    ],
  ),
  sample: sample({
    Question: "Is a liquidated damages clause a penalty if it exceeds the likely loss?",
    Jurisdiction: "au",
  }),
};
