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

  const answer =
    (value: unknown) =>
    (...args: unknown[]) =>
      (args.at(-1) as (r: unknown) => void)({ status: "succeeded", value });

  const withReading = (content: unknown) => {
    office({
      ...message,
      body: { getAsync: vi.fn(answer("Body text")) },
      getAttachmentContentAsync: answer(content),
    });
    Object.assign(Office, {
      AsyncResultStatus: { Succeeded: "succeeded" },
      CoercionType: { Text: "text" },
      MailboxEnums: { AttachmentContentFormat: { Base64: "base64", Eml: "eml", Url: "url" } },
    });
    return createOutlookHost();
  };

  it("reads the body as plain text only", async () => {
    const host = withReading({});
    expect(await host.body()).toBe("Body text");
    expect(
      (Office.context.mailbox.item as unknown as { body: { getAsync: unknown } }).body.getAsync,
    ).toHaveBeenCalledWith("text", expect.any(Function));
  });

  it("decodes files and attached messages, and never takes a link", async () => {
    const pdf = await withReading({ format: "base64", content: btoa("%PDF") }).attachment("a1");
    expect(new TextDecoder().decode(pdf?.bytes)).toBe("%PDF");
    const eml = await withReading({ format: "eml", content: "Subject: x" }).attachment("a1");
    expect(eml?.extension).toBe("eml");
    expect(
      await withReading({ format: "url", content: "https://drive.example/f" }).attachment("a2"),
    ).toBeNull();
  });

  it("opens a reply with the body, and does nothing that sends", () => {
    const displayReplyForm = vi.fn();
    office({ ...message, displayReplyForm });
    createOutlookHost().reply("<p>Hi</p>");
    expect(displayReplyForm).toHaveBeenCalledWith({ htmlBody: "<p>Hi</p>" });
  });

  it("has nothing to read with no message open, or one being written", () => {
    office(null);
    expect(createOutlookHost().item()).toBeNull();
    office({ subject: { getAsync: () => {} } });
    expect(createOutlookHost().item()).toBeNull();
  });
});
