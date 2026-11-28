import type { MailHost, MailItem } from "../office/host.js";

export const ITEM: MailItem = {
  itemId: "AAMk-1",
  subject: "Lease notice",
  from: "them@acme.test",
  to: ["me@firm.test"],
  cc: [],
  date: "2026-03-02T10:00:00.000Z",
  attachments: [{ id: "a1", name: "Lease.pdf", size: 9, kind: "file", inline: false }],
};

export function fakeHost(item: MailItem | null = ITEM, overrides: Partial<MailHost> = {}) {
  const opened: string[] = [];
  let current = item;
  const host: MailHost = {
    item: () => current,
    body: async () => "The notice must be served by 4 March.",
    attachment: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]) }),
    openInBrowser: (url) => {
      opened.push(url);
    },
    ...overrides,
  };
  return {
    host,
    opened,
    select: (next: MailItem | null) => {
      current = next;
    },
  };
}
