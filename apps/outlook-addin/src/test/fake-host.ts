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
