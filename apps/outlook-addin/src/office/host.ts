export type MailAttachment = {
  id: string;
  name: string;
  size: number;
  /** A file, an attached Outlook item, or a link to a file kept in a cloud drive. */
  kind: "file" | "item" | "cloud";
  /** Shown inside the body, as signature images are. */
  inline: boolean;
};

export type MailItem = {
  itemId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  /** ISO 8601. */
  date: string;
  attachments: MailAttachment[];
};

/** An attachment's content; `extension` is set when Outlook hands over something to be named. */
export type AttachmentContent = { bytes: Uint8Array<ArrayBuffer>; extension?: "eml" };

/** Everything the pane asks of Outlook, so the UI is tested without Office. */
export interface MailHost {
  /** The message open for reading, as it is now; null when there isn't one. */
  item(): MailItem | null;
  /** The open message's body as plain text. */
  body(): Promise<string>;
  /** One attachment of the open message; null when it isn't a file the pane can take. */
  attachment(id: string): Promise<AttachmentContent | null>;
  /** Opens a LegalLabs page, such as the document viewer, in the user's browser. */
  openInBrowser(url: string): void;
}
