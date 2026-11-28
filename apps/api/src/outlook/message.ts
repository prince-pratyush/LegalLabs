import type { OutlookItem } from "@legallabs/contracts";
import { storable, stripInvisible } from "../connectors/sanitise.js";

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
