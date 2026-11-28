import { z } from "zod";

const MB = 1024 ** 2;

/** What one email may bring in. Attachments over these are listed as skipped, not sent. */
export const OUTLOOK_LIMITS = {
  bodyChars: 2_000_000,
  subjectChars: 1_000,
  recipients: 500,
  attachments: 20,
  /** One attachment, matching the most an upload takes. */
  fileBytes: 25 * MB,
  /** All of an email's attachments together. */
  totalBytes: 40 * MB,
  /** Inline images this small are signatures, not attachments. */
  signatureBytes: 50 * 1024,
  /** What Outlook's reply window takes as HTML. */
  replyHtmlBytes: 32 * 1024,
} as const;

// Postgres text holds no NUL.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes("\0"));
const address = text(320);
const addresses = z.array(address).max(OUTLOOK_LIMITS.recipients);

/** An email as the pane read it from Outlook. Every part of it is the sender's words. */
export const OutlookItem = z.object({
  item_id: text(1_000),
  subject: text(OUTLOOK_LIMITS.subjectChars),
  from: address,
  to: addresses,
  cc: addresses,
  date: z.iso.datetime({ offset: true }),
  body_text: text(OUTLOOK_LIMITS.bodyChars),
});
export type OutlookItem = z.infer<typeof OutlookItem>;

export type OutlookSkipReason = "UNSUPPORTED_TYPE" | "FILE_TOO_LARGE" | "OVER_LIMIT" | "NOT_SENT";

export type OutlookIngest = {
  thread_id: string;
  documents: {
    document_id: string;
    name: string;
    kind: "email" | "attachment";
    status: "queued" | "parsing" | "indexed" | "failed";
  }[];
  skipped: { name: string; reason: OutlookSkipReason }[];
};
