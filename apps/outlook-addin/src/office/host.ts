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

/** Everything the pane asks of Outlook, so the UI is tested without Office. */
export interface MailHost {
  /** The message open for reading, as it is now; null when there isn't one. */
  item(): MailItem | null;
  /** Opens a LegalLabs page, such as the document viewer, in the user's browser. */
  openInBrowser(url: string): void;
}
