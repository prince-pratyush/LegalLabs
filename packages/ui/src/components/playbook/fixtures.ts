import type { PlaybookSummary, PlaybookVersion, Rule } from "@legallabs/contracts";

// Story and test data only; every name and clause here is invented.
const ws = "0190a000-0000-7000-8000-000000000001";
const owner = "0190a000-0000-7000-8000-000000000002";

export const sampleRules: Rule[] = [
  {
    id: "0190a000-0000-7000-8000-0000000000a1",
    ordinal: 0,
    title: "Limitation of liability",
    standard_position:
      "Each party's liability is capped at the fees paid in the 24 months before the claim.",
    fallbacks: [
      "A cap at 18 months' fees.",
      "A cap at 12 months' fees with a carve-out for data breach.",
    ],
    unacceptable:
      "Any cap below 12 months' fees, or a cap that also limits the supplier's indemnities.",
    guidance: "Escalate to the general counsel if the counterparty refuses any cap.",
    flag: true,
    actions: [],
    sample_language:
      "Each party's total liability under this agreement is limited to the fees paid in the twenty-four (24) months before the claim.",
    provenance: {
      document_id: "0190a000-0000-7000-8000-0000000000d1",
      quote: "liability is capped at the fees paid in the twenty-four months",
      verified: true,
    },
  },
  {
    id: "0190a000-0000-7000-8000-0000000000a2",
    ordinal: 1,
    title: "Governing law",
    standard_position: "The law of our home jurisdiction governs.",
    fallbacks: [],
    flag: false,
    actions: [],
    condition: { kind: "jurisdiction", in: ["US", "UK"] },
    provenance: null,
  },
];

export const summary = (i: number, overrides: Partial<PlaybookSummary> = {}): PlaybookSummary => ({
  id: `0190a000-0000-7000-8000-${String(100 + i).padStart(12, "0")}`,
  workspace_id: ws,
  owner_id: owner,
  name: ["Customer NDA", "SaaS MSA", "Data processing addendum", "Reseller agreement"][i % 4] ?? "",
  contract_type: ["NDA", "MSA", "DPA", "Reseller"][i % 4] ?? "",
  guidance: null,
  status: i % 3 === 0 ? "unpublished" : "published",
  version_id: `0190a000-0000-7000-8000-${String(200 + i).padStart(12, "0")}`,
  version_no: (i % 5) + 1,
  access: "manage",
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T09:00:00.000Z`,
  rule_count: 4 + i,
  ...overrides,
});

export const sampleVersions: PlaybookVersion[] = [3, 2, 1].map((no) => ({
  version_id: `0190a000-0000-7000-8000-${String(300 + no).padStart(12, "0")}`,
  no,
  created_by: owner,
  created_at: `2026-11-0${no}T10:30:00.000Z`,
  rule_count: no + 1,
}));
