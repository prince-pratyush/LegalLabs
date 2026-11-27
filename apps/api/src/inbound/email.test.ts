import PostalMime from "postal-mime";
import { describe, expect, it, vi } from "vitest";
import { AUTHSERV, eml, type Mail, passes } from "../test-email.js";
import { EMAIL_LIMITS, type EmailRules, readEmail } from "./email.js";

const rules: EmailRules = {
  address: "legal@firm.test",
  authservId: AUTHSERV,
  allowedDomains: ["acme.example"],
};
const read = (mail: Mail | Buffer) => readEmail(Buffer.isBuffer(mail) ? mail : eml(mail), rules);
const reason = async (mail: Mail | Buffer) => {
  const result = await read(mail);
  return result.ok ? "accepted" : result.reason;
};
const message = async (mail: Mail | Buffer) => {
  const result = await read(mail);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.message;
};

describe("reading an inbound email", () => {
  it("takes an authenticated message from an allowed domain", async () => {
    const got = await message({
      messageId: "<One@acme.example>",
      parts: [{ name: "nda.txt", type: "text/plain", content: "Mutual NDA" }],
    });
    expect(got).toMatchObject({
      from: "jo@acme.example",
      fromName: "Jo Smith",
      messageId: "<One@acme.example>",
      subject: "NDA with Acme",
    });
    expect(got.body).toContain("by Friday");
    expect(got.attachments.map((a) => [a.name, Buffer.from(a.bytes).toString()])).toEqual([
      ["nda.txt", "Mutual NDA"],
    ]);
  });
});

describe("authentication", () => {
  const forged = passes("acme.example");

  it.each<[string, Mail]>([
    ["no Authentication-Results", { auth: null }],
    ["dmarc=fail", { auth: `${AUTHSERV}; dmarc=fail header.from=acme.example` }],
    ["no dmarc result", { auth: `${AUTHSERV}; spf=pass smtp.mailfrom=acme.example` }],
    ["no header.from", { auth: `${AUTHSERV}; dmarc=pass` }],
    ["a pass for another domain", { auth: passes("evil.example") }],
    ["another server's header", { auth: "mx.evil.test; dmarc=pass header.from=acme.example" }],
    ["a server id that only starts the same", { auth: `x${forged}` }],
    [
      "a forged header under the real one",
      {
        auth: `${AUTHSERV}; dmarc=fail header.from=acme.example`,
        headers: [`Authentication-Results: ${forged}`],
      },
    ],
    [
      "a forged header under another server's",
      {
        auth: "mx.evil.test; none",
        headers: [`Authentication-Results: ${forged}`],
      },
    ],
    [
      "a pass hidden in a comment",
      { auth: `${AUTHSERV}; dmarc=fail (dmarc=pass; ) header.from=acme.example` },
    ],
    [
      "a pass hidden in a quoted string",
      {
        auth: `${AUTHSERV}; spf=pass smtp.mailfrom="a; dmarc=pass header.from=acme.example"@x.test`,
      },
    ],
    [
      "two dmarc results",
      {
        auth: `${AUTHSERV}; dmarc=fail header.from=acme.example; dmarc=pass header.from=acme.example`,
      },
    ],
    ["an unfinished comment", { auth: `${AUTHSERV}; dmarc=pass header.from=acme.example (` }],
  ])("refuses %s", async (_, mail) => {
    expect(await reason(mail)).toBe("dmarc");
  });

  it("reads a folded header with a version and comments", async () => {
    expect(
      await reason({
        auth: `${AUTHSERV} 1;\r\n dkim=pass header.d=acme.example;\r\n dmarc=pass (p=none; dis=none) header.from=ACME.example`,
      }),
    ).toBe("accepted");
  });

  it("refuses a domain that is not listed, subdomains included", async () => {
    expect(await reason({ from: "jo@mail.acme.example" })).toBe("domain");
    expect(await reason({ from: "jo@acme.example.evil.test" })).toBe("domain");
  });

  it.each<[string, Mail]>([
    ["two From headers", { headers: ["From: ceo@acme.example"] }],
    ["two addresses", { from: "jo@acme.example, boss@acme.example" }],
    ["a group", { from: "Team: jo@acme.example;" }],
    ["no address", { from: "Jo Smith" }],
    ["text after the address", { from: "<jo@acme.example> eve@evil.test" }],
    ["a From spelt with a space before the colon", { headers: ["From : ceo@acme.example"] }],
  ])("refuses %s", async (_, mail) => {
    expect(await reason(mail)).toBe("malformed");
  });

  it("refuses an address too long to be one, and fits a long one into a name", async () => {
    expect(await reason({ from: `jo@${"a.".repeat(200)}example` })).toBe("malformed");
    const long = `${"j".repeat(60)}@${"sub.".repeat(40)}acme.example`;
    const result = await readEmail(eml({ from: long }), {
      ...rules,
      allowedDomains: [long.split("@")[1] as string],
    });
    expect(result.ok && result.message.fromName.length).toBe(200);
  });

  it("takes the address, not what the display name pretends", async () => {
    const got = await message({ from: '"boss@firm.test <boss@firm.test>" <jo@acme.example>' });
    expect(got.from).toBe("jo@acme.example");
  });
});

describe("automatic mail", () => {
  it.each<[string, Mail]>([
    ["an auto reply", { headers: ["Auto-Submitted: auto-replied"] }],
    ["generated mail", { headers: ["Auto-Submitted: auto-generated"] }],
    ["bulk mail", { headers: ["Precedence: bulk"] }],
    ["a list", { headers: ["List-Id: <all.acme.example>"] }],
    ["a bounce", { headers: ["Return-Path: <>"] }],
    ["a mailer daemon", { from: "MAILER-DAEMON@acme.example" }],
    ["a report", { bodyType: "multipart/report; boundary=r" }],
    ["our own address", { from: "legal@firm.test", auth: passes("firm.test") }],
  ])("drops %s", async (_, mail) => {
    expect(await reason(mail)).toBe("auto_submitted");
  });

  it("takes mail that says it was typed", async () => {
    expect(await reason({ headers: ["Auto-Submitted: no"] })).toBe("accepted");
  });
});

describe("limits", () => {
  it("refuses a message over the size cap", async () => {
    expect(await reason(eml({ body: "a".repeat(EMAIL_LIMITS.bytes) }))).toBe("too_large");
  });

  it("refuses more lines than any real message has", async () => {
    // Each line costs the parser a turn, so this is what bounds the time a message can take.
    expect(await reason({ body: "\n".repeat(EMAIL_LIMITS.lines + 1) })).toBe("too_complex");
  });

  it("does not backtrack on long runs of space in headers or names", async () => {
    const started = Date.now();
    await read({ auth: `${AUTHSERV}; dmarc=pass ${" ".repeat(100_000)}x` });
    await read({ parts: [{ name: `a${" ".repeat(100_000)}b`, content: "a" }] });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses too many parts", async () => {
    const parts = Array.from({ length: 500 }, () => ({ name: "a.txt", content: "a" }));
    expect(await reason({ parts })).toBe("too_complex");
  });

  it("refuses too many attachments", async () => {
    const parts = Array.from({ length: EMAIL_LIMITS.attachments + 1 }, (_, i) => ({
      name: `${i}.txt`,
      content: "a",
    }));
    expect(await reason({ parts })).toBe("too_many_attachments");
  });

  it("refuses deep nesting", async () => {
    let body = "end";
    for (let i = 0; i < 40; i++) {
      body = [
        `Content-Type: multipart/mixed; boundary=b${i}`,
        "",
        `--b${i}`,
        body,
        `--b${i}--`,
      ].join("\r\n");
    }
    const raw = Buffer.concat([
      Buffer.from(`Authentication-Results: ${passes("acme.example")}\r\nFrom: jo@acme.example\r\n`),
      Buffer.from(body),
    ]);
    expect(await reason(raw)).toBe("too_complex");
  });

  it("refuses a huge header block", async () => {
    expect(await reason({ headers: [`X-Padding: ${"a".repeat(300_000)}`] })).toBe("too_complex");
  });

  it("refuses a bare carriage return or a NUL in the headers", async () => {
    expect(await reason({ headers: ["X-A: b\rFrom: ceo@acme.example"] })).toBe("malformed");
    expect(await reason({ headers: ["X-A: b\u0000c"] })).toBe("malformed");
  });

  it("keeps an attached message whole instead of reading into it", async () => {
    const got = await message({
      parts: [
        {
          name: "forwarded.eml",
          type: "message/rfc822",
          content: "From: x@y.test\r\nSubject: inner\r\n\r\nINNER TEXT",
        },
      ],
    });
    expect(got.body).not.toContain("INNER TEXT");
    expect(got.attachments.map((a) => a.name)).toEqual(["forwarded.eml"]);
  });
});

describe("content", () => {
  it("strips paths and hidden characters from file names", async () => {
    const got = await message({
      parts: [
        { name: "../../etc/passwd.txt", content: "a" },
        { name: "C:\\\\temp\\\\x.pdf", content: "a" },
        { name: ".hidden.txt", content: "a" },
        { name: `${"n".repeat(400)}.pdf`, content: "a" },
        { content: "a" },
        { name: "invoice\u202Efdp.txt", content: "a" },
      ],
    });
    const names = got.attachments.map((a) => a.name);
    expect(names.slice(0, 3)).toEqual(["passwd.txt", "x.pdf", "hidden.txt"]);
    expect(names[3]).toHaveLength(200);
    expect(names[3]?.endsWith(".pdf")).toBe(true);
    expect(names[4]).toBe("attachment-5");
    expect(names[5]).toBe("invoicefdp.txt");
  });

  it("reads an HTML body as text and runs or fetches nothing", async () => {
    const got = await message({
      bodyType: "text/html; charset=utf-8",
      body: '<html><head><style>p{}</style></head><body><script>alert(1)</script><p>Hello &amp; welcome</p><img src="https://tracker.test/x.png"></body></html>',
    });
    expect(got.body).toBe("Hello & welcome");
  });

  it("converts hostile HTML in linear time", async () => {
    const started = Date.now();
    await message({ bodyType: "text/html", body: "<".repeat(2_000_000) });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("survives a charset nobody knows", async () => {
    const got = await message({ bodyType: "text/plain; charset=x-nope", body: "plain words" });
    expect(got.body).toContain("plain words");
  });

  it("cuts a very long body and says so", async () => {
    const got = await message({ body: "word ".repeat(100_000) });
    expect(got.body.length).toBeLessThan(EMAIL_LIMITS.body_chars + 100);
    expect(got.body).toContain("[cut short]");
  });
});

describe("cost of a message", () => {
  const mixed = () =>
    Buffer.from(
      [
        `Authentication-Results: ${passes("acme.example")}`,
        "From: jo@acme.example",
        "Content-Type: multipart/mixed; boundary=b",
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        'He said "no" & left \u20ac',
        "--b",
        "Content-Type: text/html",
        "",
        "<p>and a footer</p>",
        "--b--",
        "",
      ].join("\r\n"),
    );

  it("never renders one kind of text part as the other", async () => {
    // The parser's own rendering escapes a whole text part into HTML: hundreds of megabytes
    // for a message of quote marks.
    const parse = vi.spyOn(PostalMime.prototype, "parse");
    const got = await message(mixed());
    const parsed = await parse.mock.results.at(-1)?.value;
    parse.mockRestore();
    expect(parsed.html).toBeUndefined();
    expect(got.body).toBe('He said "no" & left \u20ac\nand a footer');
  });

  it("decides who sent it from the headers alone, before reading any further", async () => {
    const parts = Array.from({ length: 500 }, () => ({ name: "a.txt", content: "a" }));
    const parse = vi.spyOn(PostalMime.prototype, "parse");
    expect(await reason({ parts, auth: "mx.evil.test; none" })).toBe("dmarc");
    expect(parse).toHaveBeenCalledTimes(1);
    const given = parse.mock.calls[0]?.[0] as Uint8Array;
    expect(Buffer.from(given).toString()).not.toContain("--edge\r\n");
    parse.mockRestore();
  });

  it("names a sender whose display name cannot be seen by the address", async () => {
    for (const hidden of ["\u200b", "\u202e\u2066", "\u00a0 ", "=?utf-8?b?4oCL?="]) {
      const got = await message({ from: `"${hidden}" <jo@acme.example>` });
      expect(got.fromName).toBe("jo@acme.example");
    }
  });
});
