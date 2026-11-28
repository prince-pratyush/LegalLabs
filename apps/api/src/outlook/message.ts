import type { OutlookItem } from "@legallabs/contracts";
import { noLinks, storable, stripInvisible } from "../connectors/sanitise.js";

// Everything here is the sender's words: hidden characters go, and nothing can pass for a header.

const clean = (text: string) => stripInvisible(storable(text.replace(/\r\n?/g, "\n")));

/** Words that must stay on their own line. */
export const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim();

const MAX_NAME = 200;

/** A file name with no separators, hidden characters or leading dots, keeping its extension. */
export function fileName(name: string, fallback = "attachment"): string {
  const safe = oneLine(name.replace(/[\p{C}\p{Zl}\p{Zp}/\\:*?"<>|]/gu, " "))
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "");
  if (!safe) return fallback;
  if (safe.length <= MAX_NAME) return safe;
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 && safe.length - dot <= 10 ? safe.slice(dot) : "";
  return `${safe.slice(0, MAX_NAME - extension.length).trim()}${extension}`;
}

/** The message as the text document that is read and cited. */
export function emailText(item: OutlookItem, attachments: readonly string[]): string {
  return [
    `Subject: ${oneLine(item.subject)}`,
    `From: ${oneLine(item.from)}`,
    `To: ${item.to.map(oneLine).join(", ")}`,
    ...(item.cc.length > 0 ? [`Cc: ${item.cc.map(oneLine).join(", ")}`] : []),
    `Date: ${item.date}`,
    ...(attachments.length > 0 ? [`Attachments: ${attachments.join(", ")}`] : []),
    "",
    clean(item.body_text),
  ].join("\n");
}

// RFC 2047: an encoded word is at most 75 characters, so a long value takes several lines.
const WORD_BYTES = 45;

function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((w) => `=?utf-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

// Only what an address is made of, so one can't end its line or start a header.
const address = (value: string) => value.replace(/[^\w.!#$%&'*+/=?^`{|}~@-]/g, "").slice(0, 320);

const wrap = (text: string) => (text.match(/.{1,76}/g) ?? []).join("\r\n");

/**
 * The message as an .eml file. The add-in is given no original, so this is rebuilt from the
 * parts it can read, and says so.
 */
export function emailEml(item: OutlookItem): string {
  const list = (values: readonly string[]) => values.map(address).filter(Boolean).join(",\r\n ");
  const cc = list(item.cc);
  return [
    `From: ${address(item.from)}`,
    `To: ${list(item.to)}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Date: ${new Date(item.date).toUTCString().replace("GMT", "+0000")}`,
    `Subject: ${encodedWords(oneLine(item.subject))}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "X-LegalLabs-Source: rebuilt from the message open in Outlook",
    "",
    wrap(Buffer.from(clean(item.body_text).replaceAll("\n", "\r\n")).toString("base64")),
    "",
  ].join("\r\n");
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/**
 * An answer as the body of a reply. The only tags are the ones written here, citation markers
 * go, and addresses go too: a message could have planted one for the reply to carry out.
 */
export function replyHtml(answer: string): string {
  return noLinks(clean(answer.replace(/\[\[c:\d+\]\]/g, "")))
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}
