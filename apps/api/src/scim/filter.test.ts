import { describe, expect, it } from "vitest";
import { ScimError } from "./errors.js";
import { matches, parseFilter, simpleEquality } from "./filter.js";
import { ENTERPRISE_URN } from "./schemas.js";

const doc = {
  id: "a1",
  externalId: "Ext-9",
  userName: "Ana.Silva@Example.com",
  name: { givenName: "Ana", familyName: "Silva" },
  title: "Partner",
  active: true,
  emails: [
    { value: "ana@example.com", type: "work", primary: true },
    { value: "ana@home.test", type: "home" },
  ],
  meta: { created: "2026-01-01T00:00:00Z", lastModified: "2026-03-05T10:00:00Z" },
  [ENTERPRISE_URN]: { department: "Disputes" },
};

const hit = (f: string) => matches(parseFilter(f), doc);

describe("filter parsing and matching", () => {
  it("compares strings without regard to case, except ids", () => {
    expect(hit('userName eq "ana.silva@example.com"')).toBe(true);
    expect(hit('USERNAME EQ "ANA.SILVA@EXAMPLE.COM"')).toBe(true);
    expect(hit('id eq "A1"')).toBe(false);
    expect(hit('externalId eq "ext-9"')).toBe(false);
    expect(hit('externalId eq "Ext-9"')).toBe(true);
  });

  it("supports ne, co, sw, ew and pr", () => {
    expect(hit('userName ne "someone@else.test"')).toBe(true);
    expect(hit('userName ne "ana.silva@example.com"')).toBe(false);
    expect(hit('userName co "silva"')).toBe(true);
    expect(hit('userName sw "ana."')).toBe(true);
    expect(hit('userName ew ".COM"')).toBe(true);
    expect(hit("title pr")).toBe(true);
    expect(hit("nickName pr")).toBe(false);
  });

  it("orders strings, numbers and dates", () => {
    expect(hit('meta.lastModified gt "2026-03-01T00:00:00Z"')).toBe(true);
    expect(hit('meta.lastModified ge "2026-03-05T10:00:00Z"')).toBe(true);
    expect(hit('meta.lastModified lt "2026-03-05T10:00:00Z"')).toBe(false);
    expect(hit('meta.lastModified le "2026-03-05T10:00:00Z"')).toBe(true);
    expect(hit('meta.lastModified gt "not a date"')).toBe(false);
    expect(hit('name.familyName gt "Silv"')).toBe(true);
  });

  it("handles booleans, including the quoted form Entra sends", () => {
    expect(hit("active eq true")).toBe(true);
    expect(hit("active eq false")).toBe(false);
    expect(hit('active eq "True"')).toBe(true);
    expect(hit('active eq "False"')).toBe(false);
  });

  it("combines with and, or, not and parentheses by precedence", () => {
    expect(hit('title eq "x" or title eq "Partner" and active eq true')).toBe(true);
    expect(hit('(title eq "x" or title eq "Partner") and active eq false')).toBe(false);
    expect(hit('not (title eq "Partner")')).toBe(false);
    expect(hit('not(title eq "x") and userName pr')).toBe(true);
  });

  it("matches inside multi-valued attributes", () => {
    expect(hit('emails.value eq "ana@home.test"')).toBe(true);
    expect(hit('emails[type eq "work" and value co "@example.com"]')).toBe(true);
    expect(hit('emails[type eq "home" and primary eq true]')).toBe(false);
    expect(hit('emails[type eq "work"] and not (emails[type eq "other"])')).toBe(true);
  });

  it("reads extension attributes by their schema prefix", () => {
    expect(hit(`${ENTERPRISE_URN}:department eq "disputes"`)).toBe(true);
    expect(hit(`${ENTERPRISE_URN.toLowerCase()}:department sw "Disp"`)).toBe(true);
  });

  it("treats an unset attribute as no match for eq and a match for ne", () => {
    expect(hit('nickName eq "x"')).toBe(false);
    expect(hit('nickName ne "x"')).toBe(true);
    expect(hit("nickName eq null")).toBe(true);
    expect(hit("title eq null")).toBe(false);
  });

  it.each([
    "",
    "userName",
    "userName eq",
    "userName eq unquoted",
    'userName xx "a"',
    '(userName eq "a"',
    'userName eq "a" and',
    'userName eq "a" )',
    'userName eq "unterminated',
    'not userName eq "a"',
    'emails[type eq "work"',
    'urn:made:up:schema:userName eq "a"',
    "a.b.c eq 1",
  ])("rejects %j as invalidFilter or invalidPath", (bad) => {
    try {
      parseFilter(bad);
      throw new Error("should have failed");
    } catch (err) {
      expect(err).toBeInstanceOf(ScimError);
      expect(["invalidFilter", "invalidPath"]).toContain((err as ScimError).scimType);
      expect((err as ScimError).status).toBe(400);
    }
  });

  it("refuses absurd nesting rather than overflowing the stack", () => {
    const nested = `${"(".repeat(500)}userName pr${")".repeat(500)}`;
    expect(() => parseFilter(nested)).toThrow(ScimError);
  });

  it("recognises the lookups a provider makes before it creates", () => {
    expect(simpleEquality(parseFilter('userName eq "a@b.test"'))).toEqual({
      attr: "userName",
      value: "a@b.test",
    });
    expect(simpleEquality(parseFilter('externalId eq "9"'))?.attr).toBe("externalId");
    expect(simpleEquality(parseFilter('userName co "a"'))).toBeNull();
    expect(simpleEquality(parseFilter('userName eq "a" and active eq true'))).toBeNull();
  });
});
