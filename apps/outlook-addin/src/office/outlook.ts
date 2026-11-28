import type { MailAttachment, MailHost, MailItem } from "./host.js";

const address = (who: { emailAddress?: string } | undefined) => who?.emailAddress ?? "";

const kindOf = (type: unknown): MailAttachment["kind"] =>
  type === "cloud" ? "cloud" : type === "item" ? "item" : "file";

function read(): MailItem | null {
  // Read mode only: in compose mode these are objects with getters, and there is no itemId.
  const item = Office.context.mailbox.item as Office.MessageRead | null | undefined;
  if (!item?.itemId || typeof item.subject !== "string") return null;
  return {
    itemId: item.itemId,
    subject: item.subject,
    from: address(item.from),
    to: (item.to ?? []).map(address).filter(Boolean),
    cc: (item.cc ?? []).map(address).filter(Boolean),
    date: item.dateTimeCreated.toISOString(),
    attachments: (item.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      kind: kindOf(a.attachmentType),
      inline: a.isInline,
    })),
  };
}

export function createOutlookHost(): MailHost {
  return {
    item: read,
    openInBrowser(url) {
      try {
        Office.context.ui.openBrowserWindow(url);
      } catch {
        // Outlook on the web has no OpenBrowserWindowApi, but it has a browser.
        window.open(url, "_blank", "noopener");
      }
    },
  };
}
