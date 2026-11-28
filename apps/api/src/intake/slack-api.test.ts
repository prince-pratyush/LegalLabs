import { describe, expect, it } from "vitest";
import type { safeDownload, safeRequest } from "../net/fetch.js";
import { createSlackApi, slackText } from "./slack-api.js";

const TOKEN = "xoxb-test-token-0000";

type Request = typeof safeRequest;
type Download = typeof safeDownload;

function fake(reply: { status?: number; body?: unknown; headers?: Record<string, string> } = {}) {
  const calls: Parameters<Request>[] = [];
  const request: Request = async (...args) => {
    calls.push(args);
    return {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
      body: JSON.stringify(reply.body ?? { ok: true, channel: "D0001", ts: "1800000000.000300" }),
    };
  };
  return { calls, api: createSlackApi({ request }) };
}

describe("posting to Slack", () => {
  it("posts under the thread, to Slack's own host and nowhere else", async () => {
    const { api, calls } = fake();
    expect(
      await api.post(TOKEN, { channel: "C0001", threadTs: "1800000000.000100", text: "Hi" }),
    ).toEqual({ ok: true, channel: "D0001", ts: "1800000000.000300" });
    const [url, policy, init] = calls[0] as Parameters<Request>;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(policy).not.toHaveProperty("insecureDev");
    expect(policy).not.toHaveProperty("trustedOrigin");
    expect(init?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init?.body ?? "")).toEqual({
      channel: "C0001",
      thread_ts: "1800000000.000100",
      text: "Hi",
      unfurl_links: false,
      unfurl_media: false,
      reply_broadcast: false,
      parse: "none",
      link_names: false,
    });
  });

  it("escapes what Slack would read as a mention or a link", async () => {
    expect(slackText("<!channel> <@U1> <https://x|y> A&B")).toBe(
      "&lt;!channel&gt; &lt;@U1&gt; &lt;https://x|y&gt; A&amp;B",
    );
    const { api, calls } = fake();
    await api.post(TOKEN, { channel: "C0001", threadTs: null, text: "<!here> hello" });
    const sent = JSON.parse((calls[0] as Parameters<Request>)[2]?.body ?? "");
    expect(sent.text).toBe("&lt;!here&gt; hello");
    expect(sent).not.toHaveProperty("thread_ts");
  });

  it("reports a refusal by its code, and how long to wait", async () => {
    const refused = fake({ body: { ok: false, error: "not_in_channel" } });
    expect(await refused.api.post(TOKEN, { channel: "C1", threadTs: null, text: "x" })).toEqual({
      ok: false,
      error: "not_in_channel",
    });
    const busy = fake({ status: 429, body: {}, headers: { "retry-after": "30" } });
    expect(await busy.api.post(TOKEN, { channel: "C1", threadTs: null, text: "x" })).toEqual({
      ok: false,
      error: "http_429",
      retryAfter: 30,
    });
    // A code is only passed on when it looks like one, so nothing else reaches a log.
    const odd = fake({ body: { ok: false, error: `bad token ${TOKEN}` } });
    expect(await odd.api.post(TOKEN, { channel: "C1", threadTs: null, text: "x" })).toEqual({
      ok: false,
      error: "refused",
    });
  });

  it("does not take an answer without ids as sent", async () => {
    const { api } = fake({ body: { ok: true, channel: "general", ts: "now" } });
    expect(await api.post(TOKEN, { channel: "C1", threadTs: null, text: "x" })).toEqual({
      ok: false,
      error: "unreadable",
    });
  });
});

describe("fetching a file from Slack", () => {
  const fetched = (status: number, body: string, type = "application/pdf") => {
    const calls: Parameters<Download>[] = [];
    const download: Download = async (...args) => {
      calls.push(args);
      return { status, headers: { "content-type": type }, body: Buffer.from(body), url: args[0] };
    };
    return { calls, api: createSlackApi({ download }) };
  };
  const URL = "https://files.slack.com/files-pri/T1-F1/a.pdf";

  it("sends the token to Slack's file host only, following nothing", async () => {
    const { api, calls } = fetched(200, "%PDF");
    expect(await api.download(TOKEN, { url: URL, html: false }, 1000)).toEqual({
      ok: true,
      bytes: Buffer.from("%PDF"),
    });
    const [, policy, init] = calls[0] as Parameters<Download>;
    expect(policy).toMatchObject({
      allowHosts: ["files.slack.com"],
      maxRedirects: 0,
      maxBytes: 1000,
    });
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(init).not.toHaveProperty("publicHeaders");
  });

  it.each([
    "https://evil.example/a.pdf",
    "https://files.slack.com.evil.example/a",
    "https://slack.com/api/auth.test",
    "http://files.slack.com/a",
    "https://user:pw@files.slack.com/a",
    "https://127.0.0.1/a",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s without connecting", async (url) => {
    // The real fetch: these are turned away before any connection is made.
    expect(await createSlackApi().download(TOKEN, { url, html: false }, 1000)).toEqual({
      ok: false,
      why: "not fetched",
    });
  });

  it("does not take an error page for the file", async () => {
    const signIn = fetched(200, "<html>Sign in</html>", "text/html; charset=utf-8");
    expect(await signIn.api.download(TOKEN, { url: URL, html: false }, 1000)).toEqual({
      ok: false,
      why: "not fetched",
    });
    expect((await signIn.api.download(TOKEN, { url: URL, html: true }, 1000)).ok).toBe(true);
    const missing = fetched(404, "no");
    expect((await missing.api.download(TOKEN, { url: URL, html: false }, 1000)).ok).toBe(false);
  });
});
