import { describe, expect, it } from "vitest";
import { replyToOf } from "./headers.js";

const headers = (...lines: string[]) => ["From: Sam <sam@acme.test>", ...lines, ""].join("\r\n");

describe("reading Reply-To", () => {
  it("finds the addresses, folded lines and all", () => {
    expect(replyToOf(headers("Reply-To: a@x.test"))).toEqual(["a@x.test"]);
    expect(replyToOf(headers('reply-to: "Doe, J" <j@x.test>,', " b@y.test"))).toEqual([
      "j@x.test",
      "b@y.test",
    ]);
  });

  it("isn't fooled by an address written as a name or a comment", () => {
    expect(replyToOf(headers('Reply-To: "sam@acme.test" <thief@evil.test>'))).toEqual([
      "thief@evil.test",
    ]);
    expect(replyToOf(headers("Reply-To: (sam@acme.test) thief@evil.test"))).toEqual([
      "thief@evil.test",
    ]);
  });

  it("is empty when there is none, and unknown when it can't be told", () => {
    expect(replyToOf(headers("Subject: Reply-To: a@x.test"))).toEqual([]);
    expect(replyToOf("")).toBeNull();
    expect(replyToOf(headers("Reply-To: =?utf-8?B?eA==?="))).toBeNull();
  });
});
