import type { AttachmentContent, MailAttachment, MailHost, MailItem } from "./host.js";

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

const open = () => {
  const item = Office.context.mailbox.item as Office.MessageRead | null | undefined;
  if (!item) throw new Error("no message is open");
  return item;
};

const settled = <T>(start: (done: (result: Office.AsyncResult<T>) => void) => void) =>
  new Promise<T>((resolve, reject) => {
    start((result) =>
      result.status === Office.AsyncResultStatus.Succeeded
        ? resolve(result.value)
        : reject(new Error(result.error.message)),
    );
  });

function decode({ format, content }: Office.AttachmentContent): AttachmentContent | null {
  const formats = Office.MailboxEnums.AttachmentContentFormat;
  if (format === formats.Base64) {
    return { bytes: Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) };
  }
  if (format === formats.Eml) {
    return { bytes: new TextEncoder().encode(content), extension: "eml" };
  }
  // A cloud link or a calendar entry: an address is never followed.
  return null;
}

export function createOutlookHost(): MailHost {
  return {
    item: read,
    body: async () =>
      settled<string>((done) => open().body.getAsync(Office.CoercionType.Text, done)),
    attachment: async (id) =>
      decode(
        await settled<Office.AttachmentContent>((done) =>
          open().getAttachmentContentAsync(id, done),
        ),
      ),
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
