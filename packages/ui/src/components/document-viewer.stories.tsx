import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  fakePdf,
  fakeSource,
  LIABILITY,
  layoutPage,
  manifest,
  pdfPages,
} from "../viewer/fixtures.js";
import { DocumentViewer } from "./document-viewer.js";

const pdf = pdfPages(40);
const cited = pdf[13];
const from = cited?.text.indexOf(LIABILITY) ?? 0;
const anchor = {
  document_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f",
  version_id: "01933b8a-7c2f-7a11-8b22-000000000001",
  page: 14,
  char_from: from,
  char_to: from + LIABILITY.length,
  quote: LIABILITY,
  status: "ok" as const,
};

const meta = {
  title: "Domain/Document viewer",
  component: DocumentViewer,
  args: {
    source: fakeSource(manifest("pdf", pdf), pdf),
    loadPdf: fakePdf(pdf),
    target: anchor,
    anchors: [anchor, { ...anchor, page: 3, char_from: 0, char_to: 20 }],
    index: 0,
    onStep: fn(),
    onClose: fn(),
    origin: <a href="#thread">Thread › response 2</a>,
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DocumentViewer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PdfAtCitation: Story = {};

export const Loading: Story = {
  args: {
    source: { ...fakeSource(manifest("pdf", pdf), pdf), manifest: () => new Promise(() => {}) },
  },
};

export const ApproximateMatch: Story = {
  args: {
    target: {
      page: 14,
      status: "mismatch",
      quote:
        "The Supplier's aggregate liabilty under this agreement shall not exceed the fees paid",
    },
    anchors: [],
  },
};

export const QuoteNotFound: Story = {
  args: {
    target: {
      page: 14,
      status: "mismatch",
      quote: "The customer indemnifies the supplier for all claims.",
    },
    anchors: [],
  },
};

const word = [
  layoutPage(1, ["Services agreement", "1. Term. This agreement starts on the start date."]),
  layoutPage(2, ["9. Liability", `9.2 Limitation. ${LIABILITY}`]),
].map((p) => ({ ...p, lines: [] }));
const wordFrom = word[1]?.text.indexOf(LIABILITY) ?? 0;

export const WordAtCitation: Story = {
  args: {
    source: fakeSource(
      manifest("pages", word, {
        name: "Services agreement.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      word,
    ),
    target: {
      page: 2,
      char_from: wordFrom,
      char_to: wordFrom + LIABILITY.length,
      quote: LIABILITY,
    },
    anchors: [],
  },
};

const sheetText =
  "Fees\nA1: Item\nB1: Amount\nA2: Licence\nB2: 1200\nA3: Support\nB3: 300\nA4: Total\nB4: =SUM(B2:B3) → 1500";
const sheet = [
  { page_no: 1, width: 0, height: 0, text: sheetText, lines: [], ocr: false },
  { page_no: 2, width: 0, height: 0, text: "Notes\nA1: Prices exclude GST", lines: [], ocr: false },
];
const total = sheetText.indexOf("B4:");

export const SheetCell: Story = {
  args: {
    source: fakeSource(manifest("sheet", sheet, { name: "Fees.xlsx" }), sheet),
    target: { page: 1, char_from: total, char_to: sheetText.length, quote: "B4" },
    anchors: [],
  },
};

const emailText =
  "From: ana@example.test\nTo: ben@example.test\nDate: 2026-10-02\nSubject: Renewal terms\n\nBen,\n\nWe agree to renew for two years at the current fees.\n\nAna";
const email = [{ page_no: 1, width: 0, height: 0, text: emailText, lines: [], ocr: false }];
const agreed = emailText.indexOf("We agree");

export const Email: Story = {
  args: {
    source: fakeSource(
      manifest("email", email, {
        name: "Renewal terms.eml",
        attachments: [
          {
            document_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d50",
            version_id: "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d51",
            name: "Renewal letter.pdf",
          },
        ],
      }),
      email,
    ),
    target: { page: 1, char_from: agreed, char_to: agreed + 51, quote: "We agree to renew" },
    anchors: [],
    onOpenAttachment: fn(),
  },
};

const transcriptText =
  "[00:00:05] Ana: Thanks for joining.\n[00:01:30] Ben: We can accept the cap on liability.\n[00:02:10] Ana: Then we have a deal.";
const transcript = [
  { page_no: 1, width: 0, height: 0, text: transcriptText, lines: [], ocr: false },
];
const cap = transcriptText.indexOf("We can accept");

export const Transcript: Story = {
  args: {
    source: fakeSource(manifest("pages", transcript, { name: "Call notes.txt" }), transcript),
    target: {
      page: 1,
      char_from: cap,
      char_to: cap + 35,
      quote: "We can accept the cap on liability.",
    },
    anchors: [],
  },
};

export const StillReading: Story = {
  args: {
    source: fakeSource(manifest("pdf", pdf, { status: "parsing", page_count: null }), pdf),
  },
};

export const NoAccess: Story = {
  args: {
    source: {
      ...fakeSource(manifest("pdf", pdf), pdf),
      manifest: () => Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
    },
  },
};
