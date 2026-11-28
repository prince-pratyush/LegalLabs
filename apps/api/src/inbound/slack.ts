import { fileName, printable } from "./email.js";

// Reads what Slack posts to the hook, after its signature, and decides whether to take it.
// Pure: nothing here stores, sends or fetches anything. Every id is checked for its shape, and
// anything a bot or the app itself said is ignored, so nothing we post can come back to us.

export const SLACK_LIMITS = {
  bytes: 512 * 1024,
  text_chars: 40_000,
  files: 5,
  /** For the files of one message together. */
  file_bytes: 20 * 1024 * 1024,
  challenge_chars: 500,
} as const;

export interface SlackFile {
  name: string;
  /** Null when Slack gives no address of its own to fetch it from. */
  url: string | null;
  size: number;
  /** An HTML file, so a sign-in page in its place can be told apart from it. */
  html: boolean;
}

export interface SlackItem {
  source: "event" | "command" | "shortcut";
  /** The Slack user who asked. A name to answer, never one of our users. */
  user: string;
  name: string;
  channel: string;
  ts: string | null;
  /** The thread answers go under: null for a slash command, which has no message. */
  threadTs: string | null;
  reply: boolean;
  trigger: string | null;
  text: string;
  files: SlackFile[];
}

export type SlackPost =
  | { kind: "challenge"; challenge: string }
  | { kind: "item"; team: string; item: SlackItem }
  | { kind: "empty_command"; team: string }
  | { kind: "ignore" };

const USER = /^[UW][A-Z0-9]{2,30}$/;
const CHANNEL = /^[CDG][A-Z0-9]{2,30}$/;
const TEAM = /^T[A-Z0-9]{2,30}$/;
const TS = /^[0-9]{1,16}\.[0-9]{1,9}$/;
const TRIGGER = /^[A-Za-z0-9.]{1,200}$/;
/** What a person's message may be, beyond a plain one. */
const SAID = new Set([undefined, "file_share", "thread_broadcast"]);

const IGNORE = { kind: "ignore" } as const;

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const matching = (value: unknown, shape: RegExp): string | null =>
  typeof value === "string" && shape.test(value) ? value : null;

function json(text: string): Json {
  try {
    return object(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Slack escapes three characters. Control characters other than line breaks and tabs go. */
const words = (value: unknown): string =>
  typeof value === "string"
    ? value
        .slice(0, SLACK_LIMITS.text_chars * 2)
        .replace(/\r\n?/g, "\n")
        .replace(/[^\P{Cc}\n\t]/gu, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
        .slice(0, SLACK_LIMITS.text_chars)
        .trim()
    : "";

function files(value: unknown): SlackFile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SLACK_LIMITS.files).map((entry, i) => {
    const file = object(entry);
    // A file kept elsewhere is only a link, which nothing here follows.
    const url = file.mode === "external" ? null : (file.url_private_download ?? file.url_private);
    const size = typeof file.size === "number" && file.size > 0 ? Math.floor(file.size) : 0;
    return {
      name: fileName(typeof file.name === "string" ? file.name : null, i + 1),
      url: typeof url === "string" && url.length <= 2000 ? url : null,
      size,
      html: file.mimetype === "text/html",
    };
  });
}

const named = (given: unknown, user: string) =>
  (typeof given === "string" ? printable(given, 100) : "") || `Slack user ${user}`;

/** Whether a message or its author is said to be of a workspace other than this one. */
const outsider = (team: string, ...given: unknown[]) =>
  given.some((other) => other !== undefined && other !== team);

function event(body: Json): SlackPost {
  const team = matching(body.team_id, TEAM);
  const said = object(body.event);
  // Message events only. A mention is also posted as one, and may not carry the same files.
  if (!team || said.type !== "message") return IGNORE;
  if (!SAID.has(said.subtype as string | undefined) || said.hidden) return IGNORE;
  if (said.bot_id !== undefined || said.bot_profile !== undefined) return IGNORE;
  const user = matching(said.user, USER);
  const channel = matching(said.channel, CHANNEL);
  const ts = matching(said.ts, TS);
  if (!user || user === "USLACKBOT" || !channel || !ts) return IGNORE;
  const own = Array.isArray(body.authorizations) ? body.authorizations : [];
  if (own.some((a) => object(a).user_id === user)) return IGNORE;
  if (outsider(team, said.team, said.user_team, said.source_team)) return IGNORE;
  // In a channel shared with another organisation, someone who isn't said to be ours isn't.
  if (body.is_ext_shared_channel === true && said.team !== team && said.user_team !== team) {
    return IGNORE;
  }
  const text = words(said.text);
  const sent = files(said.files);
  if (text === "" && sent.length === 0) return IGNORE;
  const parent = matching(said.thread_ts, TS);
  return {
    kind: "item",
    team,
    item: {
      source: "event",
      user,
      name: `Slack user ${user}`,
      channel,
      ts,
      threadTs: parent ?? ts,
      reply: parent !== null && parent !== ts,
      trigger: null,
      text,
      files: sent,
    },
  };
}

function command(form: URLSearchParams): SlackPost {
  const team = matching(form.get("team_id"), TEAM);
  const user = matching(form.get("user_id"), USER);
  const channel = matching(form.get("channel_id"), CHANNEL);
  const trigger = matching(form.get("trigger_id"), TRIGGER);
  if (!team || !user || !channel || !trigger) return IGNORE;
  const text = words(form.get("text") ?? "");
  if (text === "") return { kind: "empty_command", team };
  return {
    kind: "item",
    team,
    item: {
      source: "command",
      user,
      name: named(form.get("user_name"), user),
      channel,
      ts: null,
      threadTs: null,
      reply: false,
      trigger,
      text,
      files: [],
    },
  };
}

function shortcut(body: Json): SlackPost {
  if (body.type !== "message_action") return IGNORE;
  const team = matching(object(body.team).id, TEAM);
  const who = object(body.user);
  const user = matching(who.id, USER);
  const channel = matching(object(body.channel).id, CHANNEL);
  const message = object(body.message);
  const ts = matching(message.ts, TS);
  if (!team || !user || !channel || !ts) return IGNORE;
  if (message.bot_id !== undefined || message.bot_profile !== undefined) return IGNORE;
  if (outsider(team, who.team_id)) return IGNORE;
  const text = words(message.text);
  const sent = files(message.files);
  if (text === "" && sent.length === 0) return IGNORE;
  return {
    kind: "item",
    team,
    item: {
      source: "shortcut",
      user,
      name: named(who.username ?? who.name, user),
      channel,
      ts,
      threadTs: matching(message.thread_ts, TS) ?? ts,
      reply: false,
      trigger: null,
      text,
      files: sent,
    },
  };
}

/** Events come as JSON; the slash command and the shortcut as a form. */
export function readSlack(raw: Buffer): SlackPost {
  const text = raw.toString("utf8");
  if (text.startsWith("{")) {
    const body = json(text);
    if (body.type === "url_verification") {
      const { challenge } = body;
      return typeof challenge === "string" && challenge.length <= SLACK_LIMITS.challenge_chars
        ? { kind: "challenge", challenge }
        : IGNORE;
    }
    return body.type === "event_callback" ? event(body) : IGNORE;
  }
  const form = new URLSearchParams(text);
  const payload = form.get("payload");
  if (payload !== null) return shortcut(json(payload));
  return form.get("command")?.startsWith("/") ? command(form) : IGNORE;
}
