import { createHash } from "node:crypto";
import PostalMime, { type Email, type PostalMimeOptions } from "postal-mime";
import { htmlToText } from "./html-text.js";

// Reads a raw message from outside and decides whether to take it. Pure: nothing here stores,
// sends or fetches anything, so HTML is only ever turned into text.

export const EMAIL_LIMITS = {
  bytes: 15 * 1024 * 1024,
  /** Base64 at this size is about 200,000 lines; this bounds the time parsing takes. */
  lines: 400_000,
  parts: 100,
  depth: 10,
  header_bytes: 128 * 1024,
  /** One less than a request holds: the message itself is filed beside them. */
  attachments: 19,
  body_chars: 200_000,
  name_chars: 200,
  subject_chars: 500,
} as const;

export interface EmailRules {
  /** The intake address, so mail from it is never taken. */
  address: string;
  /** The receiving server's name in the Authentication-Results header it writes. */
  authservId: string;
  allowedDomains: readonly string[];
}

export type Rejection =
  | "too_large"
  | "too_complex"
  | "too_many_attachments"
  | "malformed"
  | "auto_submitted"
  | "dmarc"
  | "domain";

export interface InboundAttachment {
  name: string;
  bytes: Uint8Array;
}

export interface InboundMessage {
  /** Who the message says it is from. A name to answer, never an identity. */
  from: string;
  fromName: string;
  messageId: string | null;
  /** Tokens of our own mail that this one says it answers. */
  replyTokens: string[];
  subject: string;
  date: string;
  body: string;
  attachments: InboundAttachment[];
}

export type ReadEmail = { ok: true; message: InboundMessage } | { ok: false; reason: Rejection };

const ADDRESS = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@((?:[a-z0-9-]+\.)+[a-z0-9-]{2,63})$/;

/** A NUL or a CR that ends no line could make two readers see two different header blocks. */
function ambiguousHeaders(raw: Uint8Array): boolean {
  let lineStart = true;
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    if (byte === 0) return true;
    if (byte === 0x0d && raw[i + 1] !== 0x0a) return true;
    if (byte === 0x0a) {
      if (lineStart) return false;
      lineStart = true;
    } else if (byte !== 0x0d) {
      lineStart = false;
    }
  }
  return false;
}

/**
 * The header value with comments blanked and quoted strings emptied, split at `separator`
 * outside both, so nothing written inside them can pass for structure. Null if either is left
 * open.
 */
function structure(value: string, separator?: string): string[] | null {
  const parts: string[] = [];
  let part = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if ((quoted || depth > 0) && c === "\\") {
      i++;
    } else if (quoted) {
      if (c === '"') {
        quoted = false;
        part += c;
      }
    } else if (c === "(") {
      depth++;
      part += " ";
    } else if (depth > 0) {
      if (c === ")") depth--;
    } else if (c === '"') {
      quoted = true;
      part += c;
    } else if (c === separator) {
      parts.push(part);
      part = "";
    } else {
      part += c;
    }
  }
  if (quoted || depth > 0) return null;
  parts.push(part);
  return parts;
}

/** Exactly one address, written plainly. Anything a second reader might take otherwise fails. */
function sender(value: string): { address: string; domain: string } | null {
  const bare = structure(value)?.[0]?.trim();
  if (bare === undefined) return null;
  const angled = /^[^<>,;:@\\]*<([^<>]*)>$/.exec(bare);
  const address = (angled ? (angled[1] as string) : bare).trim().toLowerCase();
  const match = address.length <= 254 ? ADDRESS.exec(address) : null;
  return match ? { address, domain: match[1] as string } : null;
}

/** Whether the receiving server, and only it, says DMARC passed for this From domain. */
function dmarcPassed(header: string | undefined, authservId: string, domain: string): boolean {
  if (header === undefined) return false;
  const [server, ...results] = structure(header, ";") ?? [];
  if (server?.trim().split(/\s+/)[0]?.toLowerCase() !== authservId.toLowerCase()) return false;
  const dmarc = results
    .map((result) =>
      result
        // Runs of space are collapsed first, so the second expression cannot backtrack.
        .replace(/\s+/g, " ")
        .replace(/ ?([=/.]) ?/g, "$1")
        .trim()
        .toLowerCase()
        .split(" "),
    )
    .filter((tokens) => /^dmarc(\/\d+)?=/.test(tokens[0] ?? ""));
  const [only, ...more] = dmarc;
  if (!only || more.length > 0 || !/^dmarc(\/\d+)?=pass$/.test(only[0] as string)) return false;
  const from = only.filter((token) => token.startsWith("header.from="));
  return from.length === 1 && from[0] === `header.from=${domain}`;
}

function automatic(email: Email, from: string, own: string): boolean {
  const values = (key: string) =>
    email.headers.filter((h) => h.key === key).map((h) => h.value.trim().toLowerCase());
  return (
    values("auto-submitted").some((v) => v.split(";")[0]?.trim() !== "no") ||
    values("precedence").some((v) => ["bulk", "list", "junk", "auto_reply"].includes(v)) ||
    ["list-id", "x-autoreply", "x-autorespond"].some((key) => values(key).length > 0) ||
    values("return-path").includes("<>") ||
    values("content-type").some((v) => v.startsWith("multipart/report")) ||
    /^(mailer-daemon|postmaster)@/.test(from) ||
    from === own.toLowerCase()
  );
}

/** Text safe to store: no control or direction characters, cut by whole characters. */
export const printable = (value: string, max: number) =>
  Array.from(value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " "))
    .slice(0, max)
    .join("")
    .trim();

/** The last part of a name, without anything that could place or disguise the file. */
export function fileName(given: string | null, index: number): string {
  const base = (given ?? "").split(/[/\\]/).at(-1) ?? "";
  const clean = base
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .replace(/^[.\s]+/, "")
    .trimEnd();
  if (clean === "") return `attachment-${index}`;
  const chars = Array.from(clean);
  if (chars.length <= EMAIL_LIMITS.name_chars) return clean;
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(clean)?.[0] ?? "";
  return chars.slice(0, EMAIL_LIMITS.name_chars - extension.length).join("") + extension;
}

const PARSE: PostalMimeOptions = {
  maxNestingDepth: EMAIL_LIMITS.depth,
  maxPartCount: EMAIL_LIMITS.parts,
  maxHeadersSize: EMAIL_LIMITS.header_bytes,
  // An attached message stays one file; the ingest worker opens it under its own limits.
  maxRfc822NestingDepth: 0,
  forceRfc822Attachments: true,
};

type TextParts = { value: string }[];
interface Rendering {
  textMap: Map<unknown, { plain?: TextParts; html?: TextParts }>;
  textContent: Record<string, string>;
  renderTextContent(): void;
}

/**
 * A parser that gives the text of a message and nothing else. Its own rendering also writes
 * each plain part out as HTML, which for a message of quote marks costs hundreds of megabytes.
 * This reaches inside the pinned version; the tests fail if an upgrade stops calling it.
 */
function textParser(): PostalMime {
  const parser = new PostalMime(PARSE);
  const inside = parser as unknown as Rendering;
  inside.renderTextContent = () => {
    const joined = (parts: TextParts = []) => parts.map((part) => part.value).join("\n");
    inside.textContent = {
      plain: Array.from(inside.textMap.values(), ({ plain, html }) =>
        plain ? joined(plain) : htmlToText(joined(html)),
      ).join("\n"),
    };
  };
  return parser;
}

function bodyText(email: Email): string {
  const whole = (email.text ?? "").trim();
  // Cut before it is cleaned, so the work is bounded by what is kept.
  const start = whole.slice(0, EMAIL_LIMITS.body_chars + 1000);
  const clean = start
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim();
  return clean.length <= EMAIL_LIMITS.body_chars && start.length === whole.length
    ? clean
    : `${clean.slice(0, EMAIL_LIMITS.body_chars)}\n\n[cut short]`;
}

function tooManyLines(raw: Uint8Array): boolean {
  let lines = 0;
  for (let at = raw.indexOf(0x0a); at >= 0; at = raw.indexOf(0x0a, at + 1)) {
    if (++lines > EMAIL_LIMITS.lines) return true;
  }
  return false;
}

/** The header block, with the empty line that ends it. Past the cap the parser refuses it. */
function headerBlock(raw: Uint8Array): Uint8Array {
  const cap = Math.min(raw.length, 2 * EMAIL_LIMITS.header_bytes);
  for (let at = raw.indexOf(0x0a); at >= 0 && at < cap; at = raw.indexOf(0x0a, at + 1)) {
    const next = raw[at + 1] === 0x0d ? at + 2 : at + 1;
    if (raw[next] === 0x0a) return raw.subarray(0, next + 1);
  }
  return raw.subarray(0, cap);
}

/** How a sender is known where only a hash is kept. */
export const senderHash = (workspaceId: string, address: string): Buffer =>
  createHash("sha256").update(`${workspaceId}\n${address}\n`).digest();

const refused = (reason: Rejection) => ({ ok: false, reason }) as const;
const parseFailure = (err: unknown) => {
  const code = (err as { code?: string }).code ?? "";
  return refused(code.startsWith("EMAX") ? "too_complex" : "malformed");
};

/**
 * Whether the message may be taken at all, from its headers alone: no body is parsed for a
 * sender who would be turned away.
 */
export async function checkSender(
  raw: Uint8Array,
  rules: EmailRules,
): Promise<{ ok: true; from: string } | { ok: false; reason: Rejection }> {
  if (raw.length > EMAIL_LIMITS.bytes) return refused("too_large");
  if (tooManyLines(raw)) return refused("too_complex");
  if (ambiguousHeaders(raw)) return refused("malformed");
  let email: Email;
  try {
    email = await PostalMime.parse(headerBlock(raw), PARSE);
  } catch (err) {
    return parseFailure(err);
  }
  const froms = email.headers.filter((h) => h.key === "from");
  // "From :" is a different header to one reader and the sender to another.
  const spaced = email.headers.some((h) => /\s/.test(h.key));
  const from = froms.length === 1 && !spaced ? sender(froms[0]?.value ?? "") : null;
  if (!from) return refused("malformed");
  if (automatic(email, from.address, rules.address)) return refused("auto_submitted");
  // The first one only: the receiving server adds its header above anything the sender wrote.
  const results = email.headers.find((h) => h.key === "authentication-results")?.value;
  if (!dmarcPassed(results, rules.authservId, from.domain)) return refused("dmarc");
  if (!rules.allowedDomains.includes(from.domain)) return refused("domain");
  return { ok: true, from: from.address };
}

/** Our Message-IDs are `<lli.{token}@domain>`; the newest references are last. */
const replyTokens = (header: string) =>
  [...header.slice(-4000).matchAll(/<lli\.([0-9a-f]{32})@/g)].map((m) => m[1] as string).slice(-20);

export async function readEmail(raw: Uint8Array, rules: EmailRules): Promise<ReadEmail> {
  const sent = await checkSender(raw, rules);
  if (!sent.ok) return sent;
  let email: Email;
  try {
    email = await textParser().parse(raw);
  } catch (err) {
    return parseFailure(err);
  }
  if (email.attachments.length > EMAIL_LIMITS.attachments) return refused("too_many_attachments");

  const id = /<[^<>\s]{1,500}>/.exec(email.messageId ?? "")?.[0] ?? null;
  return {
    ok: true,
    message: {
      from: sent.from,
      // After cleaning, so a name nobody can see counts as none.
      fromName:
        printable(email.from?.name ?? "", EMAIL_LIMITS.name_chars) ||
        sent.from.slice(0, EMAIL_LIMITS.name_chars),
      messageId: id,
      replyTokens: replyTokens(`${email.inReplyTo ?? ""} ${email.references ?? ""}`),
      subject: printable(email.subject ?? "", EMAIL_LIMITS.subject_chars),
      date: printable(email.headers.find((h) => h.key === "date")?.value ?? "", 100),
      body: bodyText(email),
      attachments: email.attachments.map((attachment, i) => ({
        name: fileName(attachment.filename, i + 1),
        bytes:
          typeof attachment.content === "string"
            ? Buffer.from(attachment.content)
            : new Uint8Array(attachment.content),
      })),
    },
  };
}
