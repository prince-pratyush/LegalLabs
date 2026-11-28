import { safeDownload, safeRequest } from "../net/fetch.js";

// The only two things asked of Slack: post a message, and fetch a file a message came with.
// Both go through the checked fetch to a fixed Slack host. Written from Slack's public API
// documentation and not checked against a live workspace.

const POST_URL = "https://slack.com/api/chat.postMessage";
const FILE_HOSTS = ["files.slack.com"];

export type Posted =
  | { ok: true; channel: string; ts: string }
  | { ok: false; error: string; retryAfter?: number };

export type Fetched = { ok: true; bytes: Buffer } | { ok: false; why: "not fetched" };

export interface SlackApi {
  post(
    token: string,
    message: { channel: string; threadTs: string | null; text: string },
  ): Promise<Posted>;
  download(token: string, file: { url: string; html: boolean }, maxBytes: number): Promise<Fetched>;
}

/** So that nothing in a message is read as a mention, a channel-wide ping or a labelled link. */
export const slackText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function createSlackApi(
  options: { request?: typeof safeRequest; download?: typeof safeDownload } = {},
): SlackApi {
  const { request = safeRequest, download = safeDownload } = options;
  return {
    async post(token, { channel, threadTs, text }) {
      const res = await request(
        POST_URL,
        { timeoutMs: 10_000, deadlineMs: 15_000, maxBytes: 200_000 },
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            text: slackText(text),
            unfurl_links: false,
            unfurl_media: false,
            // Under the thread only, never to the whole channel.
            reply_broadcast: false,
            parse: "none",
            link_names: false,
          }),
        },
      );
      if (res.status !== 200) {
        const wait = Number(res.headers["retry-after"]);
        return {
          ok: false,
          error: `http_${res.status}`,
          ...(wait > 0 ? { retryAfter: Math.min(Math.ceil(wait), 3600) } : {}),
        };
      }
      let body: { ok?: unknown; error?: unknown; channel?: unknown; ts?: unknown } = {};
      try {
        body = JSON.parse(res.body) ?? {};
      } catch {
        return { ok: false, error: "unreadable" };
      }
      if (body.ok !== true) {
        const code = typeof body.error === "string" && /^[a-z_]{1,60}$/.test(body.error);
        return { ok: false, error: code ? (body.error as string) : "refused" };
      }
      if (
        typeof body.channel !== "string" ||
        !/^[CDG][A-Z0-9]{2,30}$/.test(body.channel) ||
        typeof body.ts !== "string" ||
        !/^[0-9]{1,16}\.[0-9]{1,9}$/.test(body.ts)
      ) {
        return { ok: false, error: "unreadable" };
      }
      return { ok: true, channel: body.channel, ts: body.ts };
    },

    async download(token, file, maxBytes) {
      const failed = { ok: false, why: "not fetched" } as const;
      try {
        // The address came in a message, so only Slack's file host is visited, nothing is
        // followed and the token goes nowhere else.
        const res = await download(
          file.url,
          {
            allowHosts: FILE_HOSTS,
            maxRedirects: 0,
            maxBytes,
            timeoutMs: 10_000,
            deadlineMs: 30_000,
          },
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (res.status !== 200) return failed;
        // A token that may not read files is answered with a sign-in page.
        const type = String(res.headers["content-type"] ?? "");
        if (!file.html && type.startsWith("text/html")) return failed;
        return { ok: true, bytes: res.body };
      } catch {
        return failed;
      }
    },
  };
}
