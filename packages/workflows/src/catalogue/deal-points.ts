import { type CatalogueEntry, files, numbered, sample, workflow } from "./define.js";

const agreements = files(...numbered("Merger agreement", 4, "pdf"));

// [label, type, what to extract]
const POINTS: [
  string,
  "currency" | "number" | "date" | "free" | "verbatim" | "classify",
  string,
][] = [
  ["Purchase price", "currency", "The headline purchase price."],
  ["Consideration form", "free", "Cash, shares or a mix."],
  ["Escrow", "currency", "Any escrow or holdback amount and period."],
  ["Earnout", "free", "Any earnout, its metric and cap."],
  ["Working capital adjustment", "free", "How the price adjusts for working capital."],
  ["Closing conditions", "free", "The conditions to closing."],
  ["MAC definition", "verbatim", "The material adverse change definition."],
  ["Reps survival", "free", "How long warranties survive closing."],
  ["Indemnity cap", "currency", "The general indemnity cap."],
  ["Basket", "free", "The basket type and amount."],
  ["De minimis", "currency", "The per-claim threshold."],
  ["Fundamental reps cap", "currency", "The cap for fundamental warranties."],
  ["Sandbagging", "classify", "Pro, anti or silent on sandbagging."],
  ["Non compete", "free", "Seller non-compete scope and term."],
  ["Non solicit", "free", "Non-solicitation scope and term."],
  ["Termination fee", "currency", "The fee payable by the target on termination."],
  ["Reverse termination fee", "currency", "The fee payable by the buyer on termination."],
  ["Outside date", "date", "The date after which either side may terminate."],
  ["Governing law", "free", "The governing law."],
  ["Dispute resolution", "free", "Courts or arbitration, and the seat."],
  ["Warranty insurance", "free", "Whether warranty and indemnity insurance is used."],
  ["Specific indemnities", "free", "Indemnities for named matters."],
  ["Financing condition", "classify", "Whether closing depends on financing."],
  ["Interim covenants", "free", "Main conduct-of-business restrictions before closing."],
  ["Regulatory approvals", "free", "Antitrust, foreign investment or other approvals."],
  ["Key employee conditions", "free", "Conditions tied to key employees."],
];

export const dealPoints: CatalogueEntry = {
  key: "ma_deal_points",
  title: "M&A Deal Points",
  description: "Extracts 26 deal points from each agreement and summarises the outliers.",
  category: "Transactional",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "agreements",
        label: "Agreements",
        prompt: "Add up to 50 share purchase or merger agreements, or choose a vault.",
        max: 50,
      },
      {
        type: "review_table.generate",
        id: "points",
        label: "Deal points",
        source: "@Agreements",
        columns: POINTS.map(([label, type, prompt]) => ({
          label,
          type,
          prompt,
          ...(type === "classify"
            ? {
                options:
                  label === "Sandbagging" ? ["Pro", "Anti", "Silent"] : ["Yes", "No", "Unclear"],
              }
            : {}),
        })),
      },
      {
        type: "ai_action",
        id: "outliers",
        label: "Outliers",
        prompt:
          "Compare the agreements in @Deal points and summarise the outliers: terms that differ from the rest of the set, most significant first.",
      },
      {
        type: "response",
        id: "out",
        outputs: [
          { ref: "@Deal points", as: "table", title: "Deal points" },
          { ref: "@Outliers", as: "message", title: "Outlier summary" },
        ],
      },
    ],
    [
      ["agreements", "points"],
      ["points", "outliers"],
      ["points", "out"],
      ["outliers", "out"],
    ],
  ),
  sample: sample({ Agreements: agreements.refs }, agreements),
};
