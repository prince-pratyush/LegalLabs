import { ApiError } from "@legallabs/addin";
import { OUTLOOK_LIMITS, type OutlookIngest, type OutlookItem } from "@legallabs/contracts";
import type { MailHost, MailItem } from "../office/host.js";

export type Skipped = OutlookIngest["skipped"][number];

const changed = () =>
  new ApiError(409, "ITEM_CHANGED", "The open email changed while it was being read. Try again.");

/** The open email as a form for the server: its details, its text and the files it carries. */
export async function collect(host: MailHost, item: MailItem) {
  const same = () => {
    if (host.item()?.itemId !== item.itemId) throw changed();
  };
  same();
  const body = await host.body();
  same();
  const details: OutlookItem = {
    item_id: item.itemId,
    subject: item.subject.slice(0, OUTLOOK_LIMITS.subjectChars),
    from: item.from,
    to: item.to.slice(0, OUTLOOK_LIMITS.recipients),
    cc: item.cc.slice(0, OUTLOOK_LIMITS.recipients),
    date: item.date,
    body_text: body.replaceAll("\0", "").slice(0, OUTLOOK_LIMITS.bodyChars),
  };
  const form = new FormData();
  form.append("item", JSON.stringify(details));

  const skipped: Skipped[] = [];
  let count = 0;
  let bytes = 0;
  for (const attachment of item.attachments) {
    const { name, size, kind, inline } = attachment;
    const skip = (reason: Skipped["reason"]) => skipped.push({ name, reason });
    if (inline && size <= OUTLOOK_LIMITS.signatureBytes) continue;
    // A link to a cloud drive: the file isn't in the email, and its address is never followed.
    if (kind === "cloud") skip("NOT_SENT");
    else if (size > OUTLOOK_LIMITS.fileBytes) skip("FILE_TOO_LARGE");
    else if (count >= OUTLOOK_LIMITS.attachments || bytes + size > OUTLOOK_LIMITS.totalBytes) {
      skip("OVER_LIMIT");
    } else {
      const content = await host.attachment(attachment.id).catch(() => null);
      same();
      if (!content) {
        skip("NOT_SENT");
        continue;
      }
      const { extension } = content;
      const named = extension && !name.endsWith(`.${extension}`) ? `${name}.${extension}` : name;
      form.append("attachment", new File([content.bytes], named));
      count += 1;
      bytes += size;
    }
  }
  return { form, skipped };
}
