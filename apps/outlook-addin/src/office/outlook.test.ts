import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutlookHost } from "./outlook.js";

const message = {
  itemId: "AAMk-1",
  subject: "Notice",
  from: { emailAddress: "them@acme.test" },
  to: [{ emailAddress: "me@firm.test" }],
  cc: [],
  dateTimeCreated: new Date("2026-03-02T10:00:00Z"),
  attachments: [
    { id: "a1", name: "Lease.pdf", size: 9, attachmentType: "file", isInline: false },
    { id: "a2", name: "Drive.docx", size: 1, attachmentType: "cloud", isInline: false },
  ],
};

const office = (item: unknown) =>
  vi.stubGlobal("Office", { context: { mailbox: { item }, ui: {} } });

describe("the Outlook host", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the open message's details", () => {
    office(message);
    expect(createOutlookHost().item()).toEqual({
      itemId: "AAMk-1",
      subject: "Notice",
      from: "them@acme.test",
      to: ["me@firm.test"],
      cc: [],
      date: "2026-03-02T10:00:00.000Z",
      attachments: [
        { id: "a1", name: "Lease.pdf", size: 9, kind: "file", inline: false },
        { id: "a2", name: "Drive.docx", size: 1, kind: "cloud", inline: false },
      ],
    });
  });

  it("has nothing to read with no message open, or one being written", () => {
    office(null);
    expect(createOutlookHost().item()).toBeNull();
    office({ subject: { getAsync: () => {} } });
    expect(createOutlookHost().item()).toBeNull();
  });
});
