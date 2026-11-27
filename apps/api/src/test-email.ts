// Hand-built RFC 822 messages for tests. Nothing here talks to a mail server.

export const AUTHSERV = "mx.firm.test";

export interface Part {
  name?: string;
  type?: string;
  content: string | Buffer;
}

export interface Mail {
  from?: string;
  /** The value of the topmost Authentication-Results header; null leaves it out. */
  auth?: string | null;
  subject?: string;
  messageId?: string | null;
  /** Extra header lines, written after Authentication-Results. */
  headers?: string[];
  body?: string;
  bodyType?: string;
  parts?: Part[];
}

export const passes = (domain: string) =>
  `${AUTHSERV}; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=reject) header.from=${domain}`;

let sent = 0;

export function eml(mail: Mail = {}): Buffer {
  const from = mail.from ?? "Jo Smith <jo@acme.example>";
  const domain = /@([a-z0-9.-]+)>?\s*$/i.exec(from)?.[1] ?? "acme.example";
  const auth = mail.auth === undefined ? passes(domain) : mail.auth;
  const body = mail.body ?? "Please review the attached NDA by Friday.";
  const head = [
    ...(auth === null ? [] : [`Authentication-Results: ${auth}`]),
    ...(mail.headers ?? []),
    `From: ${from}`,
    "To: legal@firm.test",
    `Subject: ${mail.subject ?? "NDA with Acme"}`,
    "Date: Fri, 27 Nov 2026 09:00:00 +0000",
    ...(mail.messageId === null
      ? []
      : [`Message-ID: ${mail.messageId ?? `<m${++sent}.${Date.now()}@acme.example>`}`]),
    "MIME-Version: 1.0",
  ];
  const bodyType = mail.bodyType ?? "text/plain; charset=utf-8";
  if (!mail.parts) {
    return Buffer.from([...head, `Content-Type: ${bodyType}`, "", body, ""].join("\r\n"));
  }
  const lines = [
    ...head,
    'Content-Type: multipart/mixed; boundary="edge"',
    "",
    "--edge",
    `Content-Type: ${bodyType}`,
    "",
    body,
  ];
  for (const part of mail.parts) {
    const name = part.name === undefined ? "" : `; filename="${part.name}"`;
    lines.push(
      "--edge",
      `Content-Type: ${part.type ?? "application/octet-stream"}`,
      `Content-Disposition: attachment${name}`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(part.content).toString("base64"),
    );
  }
  lines.push("--edge--", "");
  return Buffer.from(lines.join("\r\n"));
}
