import { describe, expect, it } from "vitest";
import { messageEvent, shortcut, slashCommand, TEAM } from "../test-slack.js";
import { readSlack, SLACK_LIMITS } from "./slack.js";

const read = (body: unknown) =>
  readSlack(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
const item = (body: unknown) => {
  const post = read(body);
  if (post.kind !== "item") throw new Error(`not an item: ${post.kind}`);
  return post;
};

describe("reading what Slack posts", () => {
  it("answers the URL check with its challenge", () => {
    expect(read({ type: "url_verification", challenge: "abc123" })).toEqual({
      kind: "challenge",
      challenge: "abc123",
    });
    expect(read({ type: "url_verification", challenge: "x".repeat(2000) }).kind).toBe("ignore");
  });

  it("takes a person's message, and the team it was posted for", () => {
    expect(item(messageEvent())).toEqual({
      kind: "item",
      team: TEAM,
      item: {
        source: "event",
        user: "U0JO",
        name: "Slack user U0JO",
        channel: "C0INTAKE",
        ts: "1800000000.000100",
        threadTs: "1800000000.000100",
        reply: false,
        trigger: null,
        text: "Need an NDA with Acme by Friday",
        files: [],
      },
    });
  });

  it("takes a mention only as the message it also is", () => {
    expect(read(messageEvent({ type: "app_mention" })).kind).toBe("ignore");
  });

  it("in a shared channel, takes only those said to be of this workspace", () => {
    const shared = (over: Record<string, unknown>) =>
      read(messageEvent(over, { is_ext_shared_channel: true })).kind;
    expect(shared({})).toBe("ignore");
    expect(shared({ user_team: "T9999" })).toBe("ignore");
    expect(shared({ user_team: TEAM })).toBe("item");
    expect(shared({ team: TEAM })).toBe("item");
  });

  it("marks an answer in a thread", () => {
    const { item: reply } = item(
      messageEvent({ ts: "1800000000.000200", thread_ts: "1800000000.000100" }),
    );
    expect(reply).toMatchObject({ reply: true, threadTs: "1800000000.000100" });
  });

  it.each([
    ["another bot", { bot_id: "B1" }],
    ["a bot profile", { bot_profile: { id: "B1" } }],
    ["our own user", { user: "U0BOT" }],
    ["Slack itself", { user: "USLACKBOT" }],
    ["an edit", { subtype: "message_changed" }],
    ["a deletion", { subtype: "message_deleted" }],
    ["a bot message subtype", { subtype: "bot_message" }],
    ["a join", { subtype: "channel_join" }],
    ["no user", { user: undefined }],
    ["a user id that isn't one", { user: "<!channel>" }],
    ["no timestamp", { ts: "yesterday" }],
    ["someone from another workspace", { user_team: "T9999" }],
    ["a shared-channel message from outside", { source_team: "T9999" }],
    ["nothing said", { text: "   " }],
    ["a hidden message", { hidden: true }],
  ])("ignores %s", (_, over) => {
    expect(read(messageEvent(over)).kind).toBe("ignore");
  });

  it("ignores events it has no use for", () => {
    expect(read(messageEvent({ type: "reaction_added" })).kind).toBe("ignore");
    expect(read({ type: "app_rate_limited", team_id: TEAM }).kind).toBe("ignore");
    expect(read("{not json").kind).toBe("ignore");
    expect(read("[1]").kind).toBe("ignore");
    expect(read("").kind).toBe("ignore");
  });

  it("keeps a file's name, address and size, and nothing else of it", () => {
    const files = [
      {
        name: "../../etc/draft‮fdp.pdf",
        url_private_download: "https://files.slack.com/files-pri/T1-F1/download/draft.pdf",
        size: 12,
        mimetype: "application/pdf",
        permalink_public: "https://example.invalid/x",
      },
      { name: "elsewhere", mode: "external", url_private: "https://drive.example/x" },
      { file_access: "check_file_info", id: "F3" },
    ];
    const { item: sent } = item(messageEvent({ subtype: "file_share", files }));
    expect(sent.files).toEqual([
      {
        name: "draftfdp.pdf",
        url: "https://files.slack.com/files-pri/T1-F1/download/draft.pdf",
        size: 12,
        html: false,
      },
      { name: "elsewhere", url: null, size: 0, html: false },
      { name: "attachment-3", url: null, size: 0, html: false },
    ]);
  });

  it("bounds the files and the text", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.txt`, size: 1 }));
    const { item: sent } = item(messageEvent({ files, text: "a".repeat(100_000) }));
    expect(sent.files).toHaveLength(SLACK_LIMITS.files);
    expect(sent.text).toHaveLength(SLACK_LIMITS.text_chars);
  });

  it("reads a slash command, which has no message to answer under", () => {
    expect(item(slashCommand())).toMatchObject({
      team: TEAM,
      item: {
        source: "command",
        user: "U0JO",
        name: "jo",
        channel: "C0INTAKE",
        ts: null,
        threadTs: null,
        trigger: "111.222.abc",
        text: "Need an NDA with Acme",
      },
    });
    expect(read(slashCommand({ text: "  " })).kind).toBe("empty_command");
  });

  it("reads a message shortcut as the person who used it, under that message", () => {
    expect(item(shortcut())).toMatchObject({
      item: {
        source: "shortcut",
        user: "U0SAM",
        name: "sam",
        ts: "1800000000.000900",
        threadTs: "1800000000.000900",
        reply: false,
        text: "Can we get an NDA?",
      },
    });
    const inThread = shortcut({
      message: { text: "see above", ts: "1800000000.000950", thread_ts: "1800000000.000900" },
    });
    expect(item(inThread).item).toMatchObject({ threadTs: "1800000000.000900", reply: false });
  });

  it("ignores other interactions and shortcuts on a bot's message", () => {
    expect(read(shortcut({ type: "block_actions" })).kind).toBe("ignore");
    const bot = shortcut({ message: { text: "hi", ts: "1800000000.000900", bot_id: "B1" } });
    expect(read(bot).kind).toBe("ignore");
  });
});
