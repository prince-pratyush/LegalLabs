import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacMatches, verifyTimestamped } from "./signature.js";

const secret = "test-signing-secret";
const body = Buffer.from([0x7b, 0x22, 0xff, 0x00, 0x7d]); // not valid UTF-8
const now = 1_700_000_000_000;
const stamp = String(now / 1000);

const sign = (timestamp: string, data: Buffer = body, key = secret) =>
  `v0=${createHmac("sha256", key).update(`v0:${timestamp}:`).update(data).digest("hex")}`;
const verify = (timestamp: string, signature: string, data = body, key = secret) =>
  verifyTimestamped(key, data, { timestamp, signature }, { now });

describe("verifyTimestamped", () => {
  it("accepts a fresh signature over the raw bytes", () => {
    expect(verify(stamp, sign(stamp))).toBe(true);
  });

  it("matches the published Slack example", () => {
    const example = Buffer.from(
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
    );
    expect(
      verifyTimestamped(
        "8f742231b10e8888abcd99yyyzzz85a5",
        example,
        {
          timestamp: "1531420618",
          signature: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
        },
        { now: 1_531_420_618_000 },
      ),
    ).toBe(true);
  });

  it.each([-300, 300])("accepts %s seconds of difference", (offset) => {
    const t = String(now / 1000 + offset);
    expect(verify(t, sign(t))).toBe(true);
  });

  it.each([-301, 301, -86_400, 86_400])("refuses a replay %s seconds out", (offset) => {
    const t = String(now / 1000 + offset);
    expect(verify(t, sign(t))).toBe(false);
  });

  it("refuses an old signature given a new timestamp", () => {
    expect(verify(stamp, sign(String(now / 1000 - 3600)))).toBe(false);
  });

  it.each(["", "abc", "1700000000.5", " 1700000000", "1.7e9", "-1700000000", "0x6553f100", "NaN"])(
    "refuses the timestamp %j even when signed",
    (t) => {
      expect(verify(t, sign(t))).toBe(false);
    },
  );

  const good = sign(stamp);
  it.each([
    ["empty", ""],
    ["without the version", good.slice(3)],
    ["truncated", good.slice(0, -2)],
    ["extended", `${good}00`],
    ["followed by junk", `${good}zz`],
    ["changed by one digit", `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`],
    ["of the same length in wider characters", `v0=${"é".repeat(64)}`],
    ["made with another secret", sign(stamp, body, "other")],
  ])("refuses a signature %s", (_name, signature) => {
    expect(verify(stamp, signature)).toBe(false);
  });

  it("refuses a changed body", () => {
    expect(verify(stamp, sign(stamp), Buffer.concat([body, Buffer.from(" ")]))).toBe(false);
  });

  it("refuses everything when no secret is set", () => {
    expect(verify(stamp, sign(stamp, body, ""), body, "")).toBe(false);
  });

  it("refuses missing headers", () => {
    expect(verifyTimestamped(secret, body, {}, { now })).toBe(false);
  });
});

describe("hmacMatches", () => {
  const key = Buffer.from("a2V5", "base64");
  const mac = createHmac("sha256", key).update(body).digest("base64");

  it("accepts a base64 signature with a binary key", () => {
    expect(hmacMatches(key, body, mac, "base64")).toBe(true);
  });

  it("refuses a wrong, differently encoded or missing one", () => {
    expect(hmacMatches(key, body, mac.slice(0, -1), "base64")).toBe(false);
    expect(hmacMatches(key, body, mac, "hex")).toBe(false);
    expect(hmacMatches(key, body, undefined, "base64")).toBe(false);
    expect(hmacMatches(Buffer.alloc(0), body, mac, "base64")).toBe(false);
  });
});
