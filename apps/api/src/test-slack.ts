import { createHmac } from "node:crypto";

// What Slack posts, written from its public API documentation. None of it has been checked
// against a live workspace.

export const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
export const TEAM = "T0001";
export const INTAKE_CHANNEL = "C0INTAKE";
export const BOT_USER = "U0BOT";

type Json = Record<string, unknown>;

/** A message event. `over` replaces fields of the event itself. */
export function messageEvent(over: Json = {}, envelope: Json = {}): Json {
  const ts = (over.ts as string | undefined) ?? "1800000000.000100";
  return {
    type: "event_callback",
    team_id: TEAM,
    event_id: `Ev${ts.replace(".", "")}`,
    authorizations: [{ team_id: TEAM, user_id: BOT_USER, is_bot: true }],
    event: {
      type: "message",
      channel: INTAKE_CHANNEL,
      channel_type: "channel",
      user: "U0JO",
      text: "Need an NDA with Acme by Friday",
      ts,
      ...over,
    },
    ...envelope,
  };
}

export const slashCommand = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    command: "/legal",
    team_id: TEAM,
    channel_id: INTAKE_CHANNEL,
    user_id: "U0JO",
    user_name: "jo",
    text: "Need an NDA with Acme",
    trigger_id: "111.222.abc",
    ...over,
  }).toString();

export const shortcut = (over: Json = {}) =>
  new URLSearchParams({
    payload: JSON.stringify({
      type: "message_action",
      team: { id: TEAM },
      channel: { id: INTAKE_CHANNEL },
      user: { id: "U0SAM", username: "sam" },
      trigger_id: "333.444.def",
      message: {
        type: "message",
        user: "U0JO",
        text: "Can we get an NDA?",
        ts: "1800000000.000900",
      },
      ...over,
    }),
  }).toString();

/** The headers Slack signs a body with. */
export function signed(body: string, at: number, secret = SIGNING_SECRET) {
  const timestamp = String(Math.floor(at / 1000));
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return {
    "content-type": body.startsWith("{") ? "application/json" : "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${digest}`,
  };
}
