import { OUTLOOK_LIMITS, type OutlookItem } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import type { MailAttachment } from "../office/host.js";
import { fakeHost, ITEM } from "../test/fake-host.js";
import { collect } from "./collect.js";

const file = (name: string, extra: Partial<MailAttachment> = {}): MailAttachment => ({
  id: name,
  name,
  size: 100,
  kind: "file",
  inline: false,
  ...extra,
});

const run = async (attachments: MailAttachment[], body = "The notice is due Friday.") => {
  const asked: string[] = [];
  const item = { ...ITEM, attachments };
  const { host } = fakeHost(item, {
    body: async () => body,
    attachment: async (id) => {
      asked.push(id);
      return { bytes: new Uint8Array([1, 2, 3]) };
    },
  });
  const { form, skipped } = await collect(host, item);
  return {
    asked,
    skipped,
    form,
    item: JSON.parse(String(form.get("item"))) as OutlookItem,
    sent: form.getAll("attachment").map((f) => (f as File).name),
  };
};

describe("reading the open email", () => {
  it("sends its text and details with each attached file", async () => {
    const { item, sent } = await run([file("Lease.pdf")]);
    expect(item).toEqual({
      item_id: "AAMk-1",
      subject: "Lease notice",
      from: "them@acme.test",
      to: ["me@firm.test"],
      cc: [],
      date: "2026-03-02T10:00:00.000Z",
      body_text: "The notice is due Friday.",
    });
    expect(sent).toEqual(["Lease.pdf"]);
  });

  it("never fetches cloud links or oversized files, and ignores signature images", async () => {
    const { asked, skipped, sent } = await run([
      file("Drive.docx", { kind: "cloud" }),
      file("Huge.pdf", { size: OUTLOOK_LIMITS.fileBytes + 1 }),
      file("logo.png", { inline: true, size: 4_000 }),
      file("Ok.pdf"),
    ]);
    expect(asked).toEqual(["Ok.pdf"]);
    expect(sent).toEqual(["Ok.pdf"]);
    expect(skipped).toEqual([
      { name: "Drive.docx", reason: "NOT_SENT" },
      { name: "Huge.pdf", reason: "FILE_TOO_LARGE" },
    ]);
  });

  it("stops at the most files and bytes one email may bring", async () => {
    const many = Array.from({ length: OUTLOOK_LIMITS.attachments + 1 }, (_, i) => file(`${i}.pdf`));
    expect((await run(many)).skipped).toEqual([{ name: "20.pdf", reason: "OVER_LIMIT" }]);
    const heavy = [file("a.pdf"), file("b.pdf")].map((a) => ({
      ...a,
      size: OUTLOOK_LIMITS.fileBytes,
    }));
    expect((await run(heavy)).skipped).toEqual([{ name: "b.pdf", reason: "OVER_LIMIT" }]);
  });

  it("names an attached message so it can be read, and cuts an endless body", async () => {
    const item = { ...ITEM, attachments: [file("Re: terms", { kind: "item" })] };
    const { host } = fakeHost(item, {
      body: async () => "x".repeat(OUTLOOK_LIMITS.bodyChars + 10),
      attachment: async () => ({ bytes: new Uint8Array([1]), extension: "eml" }),
    });
    const { form } = await collect(host, item);
    expect((form.get("attachment") as File).name).toBe("Re: terms.eml");
    expect((JSON.parse(String(form.get("item"))) as OutlookItem).body_text.length).toBe(
      OUTLOOK_LIMITS.bodyChars,
    );
  });

  it("refuses when another email was opened while it was reading", async () => {
    const { host, select } = fakeHost(ITEM, {
      body: async () => {
        select({ ...ITEM, itemId: "other" });
        return "text";
      },
    });
    await expect(collect(host, ITEM)).rejects.toThrow(/open email changed/);
  });
});
