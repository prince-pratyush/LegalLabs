import { randomUUID } from "node:crypto";
import { EICAR } from "@legallabs/ingest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { intakeDesk } from "../test-intake.js";
import {
  INTAKE_CHANNEL,
  messageEvent,
  SIGNING_SECRET,
  shortcut,
  signed,
  slashCommand,
} from "../test-slack.js";

const pool = testPool();
afterAll(() => pool.end());
const desk = intakeDesk(pool);
beforeEach(() => {
  desk.model.answer = { type_id: null, confidence: 0, fields: {} };
  desk.model.calls.length = 0;
  desk.slack.posted.length = 0;
  desk.slack.fetched.length = 0;
  desk.slack.files.clear();
  desk.slack.refuse.length = 0;
  desk.slack.fetching = null;
  desk.provider.clear();
});
afterEach(() => vi.restoreAllMocks());

const says = (fields: Record<string, unknown>) => {
  desk.model.answer = { type_id: null, confidence: 1, fields };
};

/** A workspace with the NDA type and a Slack channel. */
async function set(over: Record<string, unknown> = {}) {
  const d = await desk.open();
  const typeId = await d.type();
  return { d, typeId, slack: await d.slackChannel(over) };
}

const stored = async (channelId: string) =>
  (
    await pool.query<{ status: string; reason: string | null; raw: Buffer | null }>(
      "select status, reason, raw from apps.inbound_email where channel_id = $1 order by received_at",
      [channelId],
    )
  ).rows;

const message = (ts: string, over: Record<string, unknown> = {}) => messageEvent({ ts, ...over });
let at = 1_800_000_000;
/** A message timestamp no other test has used. */
const stamp = () => `${++at}.000100`;

describe("Slack channel settings", () => {
  it("keeps both secrets sealed and never gives them back", async () => {
    const { d, slack } = await set();
    const list = await desk.call(d.admin, "GET", "/apps/intake/slack-channels");
    expect(list.body.channels).toEqual([
      expect.objectContaining({
        id: slack.id,
        has_bot_token: true,
        status: "live",
        channel_ids: [INTAKE_CHANNEL],
        hook_path: slack.path,
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(SIGNING_SECRET);
    expect(JSON.stringify(list.body)).not.toContain("xoxb-");
    const { rows } = await pool.query(
      "select secret_sealed, bot_token_sealed from apps.intake_channel where id = $1",
      [slack.id],
    );
    expect(rows[0].secret_sealed.toString("utf8")).not.toContain(SIGNING_SECRET);
    expect(rows[0].bot_token_sealed.toString("utf8")).not.toContain("xoxb-");
    const audit = JSON.stringify(await auditTrail(pool, d.admin.workspaceId));
    expect(audit).not.toContain(SIGNING_SECRET);
    expect(audit).not.toContain("xoxb-");

    // The mail channels are a list of their own, and neither can be changed as the other.
    const mail = await desk.call(d.admin, "GET", "/apps/intake/channels");
    expect(mail.body.channels.map((c: { id: string }) => c.id)).toEqual([d.channelId]);
    for (const [path, body] of [
      [`/apps/intake/channels/${slack.id}`, { name: "x" }],
      [`/apps/intake/slack-channels/${d.channelId}`, { name: "x" }],
    ] as const) {
      expect((await desk.call(d.admin, "PATCH", path, body)).status).toBe(404);
    }
    const rotate = `/apps/intake/channels/${slack.id}/rotate-secret`;
    expect((await desk.call(d.admin, "POST", rotate, {})).status).toBe(404);
  });

  it("is for those who manage intake, and changes are audited", async () => {
    const { d, slack } = await set();
    expect((await desk.call(d.lawyer, "GET", "/apps/intake/slack-channels")).status).toBe(403);
    const patched = await desk.call(d.admin, "PATCH", `/apps/intake/slack-channels/${slack.id}`, {
      bot_token: null,
      channel_ids: ["C0OTHER"],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.channel).toMatchObject({ has_bot_token: false, channel_ids: ["C0OTHER"] });
    expect(await auditTrail(pool, d.admin.workspaceId)).toContainEqual(
      expect.objectContaining({
        action: "intake.channel.updated",
        details: {
          changed: ["channel_ids", "bot_token"],
          before: { slack_channel_ids: [INTAKE_CHANNEL] },
          after: { slack_channel_ids: ["C0OTHER"] },
        },
      }),
    );
  });
});

describe("the Slack hook", () => {
  const challenge = JSON.stringify({ type: "url_verification", challenge: "abc123" });

  it("answers the URL check only when it is signed", async () => {
    const { slack } = await set();
    const ok = await slack.send(challenge);
    expect(ok).toMatchObject({ status: 200, body: { challenge: "abc123" } });

    const bad = [
      signed(challenge, Date.now(), "another-secret-entirely"),
      signed(challenge, Date.now() - 6 * 60_000),
      signed(challenge, Date.now() + 6 * 60_000),
      signed(`${challenge} `, Date.now()),
      { "x-slack-signature": "" },
    ];
    for (const headers of bad) {
      const res = await desk.app.request(slack.path, { method: "POST", headers, body: challenge });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        code: "UNAUTHORIZED",
        message: "That request wasn't accepted.",
      });
    }
    const unknown = await desk.app.request(`/hooks/slack/${"a".repeat(32)}`, {
      method: "POST",
      headers: signed(challenge, Date.now()),
      body: challenge,
    });
    expect(unknown.status).toBe(401);
  });

  it("is not reachable through the mail hook, which signs the same way", async () => {
    const { slack } = await set();
    const body = JSON.stringify(message(stamp()));
    const headers = signed(body, Date.now());
    const res = await desk.app.request(slack.path.replace("/slack/", "/email/"), {
      method: "POST",
      headers: {
        "x-legallabs-timestamp": headers["x-slack-request-timestamp"],
        "x-legallabs-signature": headers["x-slack-signature"],
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(await stored(slack.id)).toEqual([]);
  });

  it("refuses a body over the cap", async () => {
    const { slack } = await set();
    const big = JSON.stringify(message(stamp(), { text: "a".repeat(600_000) }));
    expect((await slack.send(big)).status).toBe(413);
    expect(await stored(slack.id)).toEqual([]);
  });

  it("stores nothing it ignores", async () => {
    const { d, slack } = await set();
    for (const body of [
      message(stamp(), { bot_id: "B1" }),
      message(stamp(), { user: "U0BOT" }),
      message(stamp(), { subtype: "message_changed" }),
      message(stamp(), { channel: "C0ELSEWHERE" }),
      messageEvent({ ts: stamp() }, { team_id: "T9999" }),
      // Chatter in a thread that is no request's.
      message(stamp(), { thread_ts: "1700000000.000001" }),
    ]) {
      expect((await slack.send(body)).status).toBe(200);
    }
    const command = await slack.send(slashCommand({ channel_id: "C0ELSEWHERE" }));
    expect(command.body).toEqual({
      response_type: "ephemeral",
      text: "This command isn't set up for this channel.",
    });
    expect((await slack.send(shortcut({ channel: { id: "C0ELSEWHERE" } }))).status).toBe(200);
    await slack.run();
    expect(await stored(slack.id)).toEqual([]);
    expect(await d.requests()).toEqual([]);
    expect(desk.slack.posted).toEqual([]);
  });

  it("limits how much one channel takes in a minute, and says when to send again", async () => {
    const { slack } = await set();
    let last = 200;
    let retry: string | null = null;
    for (let n = 0; n < 121 && last === 200; n++) {
      const res = await slack.send(message(stamp(), { user: `U0N${n}` }));
      last = res.status;
      retry = res.retryAfter;
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  }, 30_000);

  it("does not let one person take all of a channel's minute", async () => {
    const { slack } = await set();
    let sent = 200;
    for (let n = 0; n < 31 && sent === 200; n++) sent = (await slack.send(message(stamp()))).status;
    expect(sent).toBe(429);
    expect(await stored(slack.id)).toHaveLength(30);
    expect((await slack.send(message(stamp(), { user: "U0OTHER" }))).status).toBe(200);
  }, 30_000);
});

describe("talk in threads that are no request's", () => {
  it("is answered as taken and spends nobody's limit", async () => {
    const { slack } = await set();
    const chatter = (user: string) =>
      slack.send(message(stamp(), { user, thread_ts: "1700000000.000001" }));
    for (let n = 0; n < 40; n++) expect((await chatter("U0JO")).status).toBe(200);
    for (let n = 0; n < 100; n++) expect((await chatter(`U0T${n}`)).status).toBe(200);
    expect(await stored(slack.id)).toEqual([]);
    const command = await slack.send(slashCommand());
    expect(command.status).toBe(200);
    expect(await stored(slack.id)).toHaveLength(1);
  }, 30_000);
});

describe("an answer to a request that is closing", () => {
  const FILE = "https://files.slack.com/files-pri/T1-F9/more.txt";
  const withFile = { subtype: "file_share", files: [{ name: "more.txt", url_private: FILE }] };
  const close = (d: Awaited<ReturnType<typeof set>>["d"], id: string) =>
    desk.call(d.lawyer, "POST", `/apps/intake/requests/${id}/status`, {
      status: "closed",
      reason: "withdrawn",
    });
  const loose = async (workspaceId: string) =>
    (
      await pool.query<{ n: number }>(
        `select count(*)::int n from apps.intake_attachment
          where workspace_id = $1 and request_id is null`,
        [workspaceId],
      )
    ).rows[0]?.n;

  it("files nothing once the request has closed", async () => {
    const { d, slack } = await set();
    const ts = stamp();
    await slack.receive(message(ts));
    const request = await d.request();
    desk.slack.files.set(FILE, Buffer.from("more"));
    await slack.send(message(stamp(), { thread_ts: ts, ...withFile }));
    expect((await close(d, request.id)).status).toBe(200);
    await slack.run();
    expect(desk.slack.fetched).toEqual([]);
    expect(await loose(d.admin.workspaceId)).toBe(0);
    expect((await stored(slack.id)).at(-1)).toMatchObject({
      status: "rejected",
      reason: "request_closed",
    });
  });

  it("keeps its files on the request when that closes while they are filed", async () => {
    const { d, slack } = await set();
    const ts = stamp();
    await slack.receive(message(ts));
    const request = await d.request();
    desk.slack.files.set(FILE, Buffer.from("more"));
    desk.slack.fetching = async () => {
      expect((await close(d, request.id)).status).toBe(200);
    };
    await slack.receive(message(stamp(), { thread_ts: ts, ...withFile }));
    expect(await loose(d.admin.workspaceId)).toBe(0);
    const detail = await desk.call(d.lawyer, "GET", `/apps/intake/requests/${request.id}`);
    expect(detail.body.request.status).toBe("closed");
    expect(detail.body.request.attachments.map((a: { name: string }) => a.name)).toContain(
      "more.txt",
    );
    expect(await d.requests()).toHaveLength(1);
  });
});

describe("a Slack request", () => {
  it("is acknowledged and asked for what is missing in the same thread, then routed", async () => {
    const { d, typeId, slack } = await set();
    const ts = stamp();
    desk.slack.files.set("https://files.slack.com/files-pri/T1-F1/draft.txt", Buffer.from("draft"));
    says({});
    await slack.receive(
      message(ts, {
        subtype: "file_share",
        files: [
          {
            name: "draft.txt",
            url_private_download: "https://files.slack.com/files-pri/T1-F1/draft.txt",
            size: 5,
          },
        ],
      }),
    );

    let request = await d.request();
    expect(request).toMatchObject({
      channel: "slack",
      type_id: typeId,
      classification_confidence: 1,
      status: "awaiting_requester",
      missing_fields: ["counterparty", "mutual"],
      requester: {
        display_name: "Slack user U0JO",
        email: null,
        external_user_id: "T0001:U0JO",
      },
    });
    const detail = await desk.call(d.lawyer, "GET", `/apps/intake/requests/${request.id}`);
    expect(detail.body.request.attachments.map((a: { name: string }) => a.name).sort()).toEqual([
      "Slack message.txt",
      "draft.txt",
    ]);
    expect(desk.slack.posted).toEqual([
      {
        token: "xoxb-test-token-0000",
        channel: INTAKE_CHANNEL,
        threadTs: ts,
        text: `Got it — request #${request.number}.`,
      },
      expect.objectContaining({ channel: INTAKE_CHANNEL, threadTs: ts }),
    ]);
    expect(desk.slack.posted[1]?.text).toContain("What is the counterparty's registered name?");
    expect(await auditTrail(pool, d.admin.workspaceId)).toContainEqual(
      expect.objectContaining({
        action: "intake.request.created",
        actor_type: "system",
        details: expect.objectContaining({ channel: "slack", attachments: 1 }),
      }),
    );
    // What Slack sent is not kept once it is filed.
    expect(await stored(slack.id)).toEqual([{ status: "accepted", reason: null, raw: null }]);

    says({ counterparty: "Acme Ltd", mutual: true });
    await slack.receive(message(stamp(), { thread_ts: ts, text: "Acme Ltd, and yes, mutual" }));
    expect(await d.requests()).toHaveLength(1);
    request = await d.request();
    expect(request).toMatchObject({
      status: "in_progress",
      assignee_id: d.lawyer.userId,
      fields: { counterparty: "Acme Ltd", mutual: true },
    });
    const last = desk.slack.posted.at(-1);
    expect(last).toMatchObject({ channel: INTAKE_CHANNEL, threadTs: ts });
    expect(last?.text).toBe(`Your request #${request.number} is assigned to Lee Law.`);
    for (const post of desk.slack.posted) {
      expect(post.text).not.toMatch(/https?:|#\/|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
    const { rows } = await pool.query(
      "select external_ref, status from apps.intake_outbound where request_id = $1",
      [request.id],
    );
    expect(rows.every((r) => r.status === "sent" && r.external_ref.startsWith("C0INTAKE:"))).toBe(
      true,
    );
    // Nobody was mailed.
    expect(desk.provider.sent).toEqual([]);
  });

  it("takes each message once, however often it arrives", async () => {
    const { d, slack } = await set();
    const ts = stamp();
    await slack.receive(message(ts));
    await slack.receive(message(ts));
    await slack.receive(messageEvent({ ts }, { event_id: "EvAgain" }));
    // The same message again, now with a file list it didn't have.
    await slack.receive(message(ts, { files: [{ name: "x", size: 1 }] }));
    expect(await d.requests()).toHaveLength(1);
  });

  it("takes answers from the person who asked, and nobody else", async () => {
    const { d, slack } = await set();
    const ts = stamp();
    says({});
    await slack.receive(message(ts));
    const before = (await stored(slack.id)).length;
    await slack.receive(
      message(stamp(), { thread_ts: ts, user: "U0MALLORY", text: "Counterparty is Mallory" }),
    );
    expect(await stored(slack.id)).toHaveLength(before);
    expect(await d.requests()).toHaveLength(1);
    expect(desk.model.calls.join()).not.toContain("Mallory");
  });

  it("starts from a slash command with a private message to the one who ran it", async () => {
    const { d, slack } = await set();
    says({});
    const res = await slack.send(slashCommand());
    expect(res.body).toEqual({
      response_type: "ephemeral",
      text: "Thanks. The legal team has your request, and we will message you about it.",
    });
    await slack.run();
    const request = await d.request();
    expect(request).toMatchObject({ channel: "slack", requester: { display_name: "jo" } });
    // Nothing is said in the channel: the first goes to the person, the rest under it.
    expect(desk.slack.posted.map((p) => [p.channel, p.threadTs])).toEqual([
      ["U0JO", null],
      ["D0JO", "1800000099.000001"],
    ]);

    says({ counterparty: "Acme Ltd", mutual: false });
    await slack.receive(
      message(stamp(), {
        channel: "D0JO",
        channel_type: "im",
        thread_ts: "1800000099.000001",
        text: "Acme Ltd, one way",
      }),
    );
    expect((await d.request()).status).toBe("in_progress");
    // Another message in the direct conversation is not a new request.
    await slack.receive(message(stamp(), { channel: "D0JO", text: "another thing" }));
    expect(await d.requests()).toHaveLength(1);
  });

  it("starts from a message shortcut, for the person who used it", async () => {
    const { d, slack } = await set();
    says({});
    await slack.receive(shortcut());
    expect((await d.request()).requester).toMatchObject({
      display_name: "sam",
      external_user_id: "T0001:U0SAM",
    });
    expect(desk.slack.posted[0]).toMatchObject({
      channel: INTAKE_CHANNEL,
      threadTs: "1800000000.000900",
    });
    // Used again by the same person: still one request. Someone else's is their own.
    await slack.receive(shortcut({ trigger_id: "9.9.z" }));
    expect(await d.requests()).toHaveLength(1);
    await slack.receive(shortcut({ user: { id: "U0KIM" }, trigger_id: "9.9.y" }));
    expect(await d.requests()).toHaveLength(2);
  });

  it("says who wrote the words a shortcut sent in, and who sent them", async () => {
    const { d, slack } = await set();
    await slack.receive(
      shortcut({
        message: {
          user: "U0GUEST",
          user_team: "T0OTHER",
          text: "Please wire the fee",
          ts: "1800000000.000940",
        },
      }),
    );
    const request = await d.request();
    expect(request.requester.external_user_id).toBe("T0001:U0SAM");
    const detail = await desk.call(d.lawyer, "GET", `/apps/intake/requests/${request.id}`);
    const file = detail.body.request.attachments[0] as { document_id: string };
    const { rows } = await pool.query<{ sha256: Buffer; workspace_id: string }>(
      "select sha256, workspace_id from content.document_version where document_id = $1",
      [file.document_id],
    );
    const filed = await desk.read(
      rows[0]?.workspace_id as string,
      rows[0]?.sha256.toString("hex") as string,
    );
    expect(filed).toContain(
      "Written by Slack user U0GUEST, outside this workspace (team T0OTHER)\nSubmitted by sam (Slack U0SAM)",
    );
    const events = await desk.call(d.lawyer, "GET", `/apps/intake/requests/${request.id}/audit`);
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "inbound",
        details: expect.objectContaining({ written_by: "U0GUEST", author_outside: true }),
      }),
    );
  });

  it("takes requests without a bot token, and then sends and fetches nothing", async () => {
    const { d, slack } = await set({ bot_token: undefined });
    await slack.receive(
      message(stamp(), {
        subtype: "file_share",
        files: [{ name: "a.txt", url_private: "https://files.slack.com/a", size: 1 }],
      }),
    );
    expect(await d.requests()).toHaveLength(1);
    expect(desk.slack.posted).toEqual([]);
    expect(desk.slack.fetched).toEqual([]);
  });

  it("says which files it did not keep, and scans the ones it does", async () => {
    const { d, slack } = await set();
    desk.slack.files.set("https://files.slack.com/virus", Buffer.from(EICAR));
    await slack.receive(
      message(stamp(), {
        subtype: "file_share",
        files: [
          { name: "virus.txt", url_private: "https://files.slack.com/virus", size: 68 },
          { name: "gone.txt", url_private: "https://files.slack.com/gone", size: 3 },
          { name: "huge.bin", url_private: "https://files.slack.com/huge", size: 90_000_000 },
        ],
      }),
    );
    const request = await d.request();
    const detail = await desk.call(d.lawyer, "GET", `/apps/intake/requests/${request.id}`);
    expect(detail.body.request.attachments.map((a: { name: string }) => a.name)).toEqual([
      "Slack message.txt",
    ]);
    // A file said to be over the limit is not asked for.
    expect(desk.slack.fetched).not.toContain("https://files.slack.com/huge");
  });

  it("carries a lawyer's reply to the thread, under their name", async () => {
    const { d, slack } = await set();
    const ts = stamp();
    await slack.receive(message(ts));
    const request = await d.request();
    desk.slack.posted.length = 0;
    const res = await desk.call(d.lawyer, "POST", `/apps/intake/requests/${request.id}/reply`, {
      text: "We are on it.",
    });
    expect(res.body).toEqual({ delivery: "queued" });
    await slack.run();
    expect(desk.slack.posted).toContainEqual(
      expect.objectContaining({
        threadTs: ts,
        text: `Lee Law replied on request #${request.number}:\n\nWe are on it.`,
      }),
    );
  });

  it("tries a post again later when Slack refuses it", async () => {
    const { d, slack } = await set();
    desk.slack.refuse.push({ ok: false, error: "http_429", retryAfter: 120 });
    await slack.receive(message(stamp()));
    const request = await d.request();
    const { rows } = await pool.query(
      `select status, attempts, next_attempt_at > now() + interval '100 seconds' later
         from apps.intake_outbound where request_id = $1 and kind = 'ack'`,
      [request.id],
    );
    expect(rows).toEqual([{ status: "queued", attempts: 1, later: true }]);
    // Nothing overtakes it.
    expect(desk.slack.posted).toEqual([]);
  });

  it("answers one person only so many times in a day", async () => {
    const { d, slack } = await set();
    for (let n = 0; n < 12; n++) await slack.receive(message(stamp()));
    expect(await d.requests()).toHaveLength(12);
    const acks = desk.slack.posted.filter((p) => p.text.startsWith("Got it"));
    expect(acks).toHaveLength(10);
    const { rows } = await pool.query(
      `select count(*)::int n from apps.intake_outbound
        where workspace_id = $1 and status = 'failed'`,
      [d.admin.workspaceId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  }, 30_000);

  it("writes nothing a person said to a log", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => lines.push(args.join(" ")));
    }
    const { slack } = await set();
    const secret = `pineapple-${randomUUID()}`;
    desk.slack.refuse.push({ ok: false, error: "not_in_channel" });
    await slack.receive(message(stamp(), { text: secret }));
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("xoxb-");
  });

  it("takes nothing once the channel is turned off", async () => {
    const { d, slack } = await set();
    expect((await slack.send(message(stamp()))).status).toBe(200);
    await desk.call(d.admin, "PATCH", `/apps/intake/slack-channels/${slack.id}`, {
      status: "disabled",
    });
    await slack.run();
    expect(await d.requests()).toEqual([]);
    expect(await stored(slack.id)).toEqual([
      { status: "rejected", reason: "channel_disabled", raw: null },
    ]);
    expect((await slack.send(message(stamp()))).status).toBe(401);
  });
});
