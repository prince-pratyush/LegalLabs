// RFC 7643/7644 self-check, run against createApp over HTTP.
// This checks our reading of the RFCs. It is NOT a vendor certification.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { testPool } from "../../test-db.js";
import { scimHarness, seedScim } from "../../test-scim.js";
import { ENTERPRISE_URN, PATCH_URN, USER_URN } from "../schemas.js";

const pool = testPool();
afterAll(() => pool.end());

const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

async function setup() {
  const w = await seedScim(pool);
  const h = scimHarness(pool);
  const call = (m: string, p: string, b?: unknown, hd?: Record<string, string>) =>
    h.call(w.token, m, p, b, hd);
  const mk = async (name: string, extra: object = {}) => {
    const r = await call("POST", "/Users", {
      schemas: [USER_URN],
      userName: `${name}-${randomUUID().slice(0, 5)}@x.test`,
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body;
  };
  return { w, h, call, mk };
}

describe("discovery", () => {
  it("serves ServiceProviderConfig, ResourceTypes and Schemas", async () => {
    const { call } = await setup();
    const spc = await call("GET", "/ServiceProviderConfig");
    expect(spc.status).toBe(200);
    expect(spc.headers.get("content-type")).toContain("application/scim+json");
    expect(spc.body).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true },
      sort: { supported: true },
      etag: { supported: true },
      changePassword: { supported: false },
    });
    const types = await call("GET", "/ResourceTypes");
    expect(types.body.Resources.map((r: { name: string }) => r.name).sort()).toEqual([
      "Group",
      "User",
    ]);
    expect((await call("GET", "/ResourceTypes/User")).body.schema).toBe(USER_URN);
    const schemas = await call("GET", "/Schemas");
    expect(schemas.body.totalResults).toBe(4);
    expect((await call("GET", `/Schemas/${USER_URN}`)).body.id).toBe(USER_URN);
    expect((await call("GET", "/Schemas/nope")).status).toBe(404);
  });
});

describe("errors", () => {
  it("uses the SCIM error format with application/scim+json", async () => {
    const { call } = await setup();
    const r = await call("GET", `/Users/${randomUUID()}`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/scim+json");
    expect(r.body).toMatchObject({ schemas: [ERROR], status: "404" });
    expect((await call("GET", "/Users/not-a-uuid")).status).toBe(404);
    expect((await call("GET", "/Nothing")).body.schemas).toEqual([ERROR]);
  });

  it("answers bad JSON and bad filters with 400 and a scimType", async () => {
    const { w, h, call } = await setup();
    const raw = await h.app.request("http://api.test/scim/v2/Users", {
      method: "POST",
      headers: { authorization: `Bearer ${w.token}`, "content-type": "application/scim+json" },
      body: "{nope",
    });
    expect(raw.status).toBe(400);
    expect((await raw.json()).scimType).toBe("invalidSyntax");
    const bad = await call("GET", "/Users?filter=userName%20bogus%20%22x%22");
    expect(bad.status).toBe(400);
    expect(bad.body.scimType).toBe("invalidFilter");
    const missing = await call("POST", "/Users", { schemas: [USER_URN] });
    expect(missing.body.scimType).toBe("invalidValue");
  });

  it("answers 401 without a usable token", async () => {
    const { h } = await setup();
    const none = await h.app.request("http://api.test/scim/v2/Users");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await h.call("made-up-token-value", "GET", "/Users")).status).toBe(401);
  });
});

describe("Users", () => {
  it("creates with 201, Location, ETag and meta; ignores a client-chosen id", async () => {
    const { call } = await setup();
    const r = await call("POST", "/Users", {
      schemas: [USER_URN],
      id: "client-chosen",
      userName: "New.Person@x.test",
      name: { givenName: "New", familyName: "Person" },
      title: "Associate",
      emails: [{ value: "np@work.test", type: "work", primary: true }],
      [ENTERPRISE_URN]: { department: "Tax" },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers.get("location")).toBe(`http://api.test/scim/v2/Users/${r.body.id}`);
    expect(r.headers.get("etag")).toMatch(/^W\/"\d+"$/);
    expect(r.body.meta).toMatchObject({
      resourceType: "User",
      location: r.headers.get("location"),
    });
    expect(r.body).toMatchObject({
      userName: "New.Person@x.test",
      displayName: "New Person",
      title: "Associate",
      active: true,
      emails: [{ value: "np@work.test", type: "work", primary: true }],
      [ENTERPRISE_URN]: { department: "Tax" },
    });
    expect(r.body.schemas).toContain(ENTERPRISE_URN);
  });

  it("409s a duplicate userName, ignoring case", async () => {
    const { call } = await setup();
    await call("POST", "/Users", { schemas: [USER_URN], userName: "dup@x.test" });
    const again = await call("POST", "/Users", { schemas: [USER_URN], userName: "DUP@x.test" });
    expect(again.status).toBe(409);
    expect(again.body.scimType).toBe("uniqueness");
  });

  it("gets one user, and 304s a matching If-None-Match", async () => {
    const { call, mk } = await setup();
    const u = await mk("get");
    const r = await call("GET", `/Users/${u.id}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(u.id);
    const again = await call("GET", `/Users/${u.id}`, undefined, {
      "if-none-match": r.headers.get("etag") ?? "",
    });
    expect(again.status).toBe(304);
  });

  it("lists with filter, pagination, sorting and attribute selection", async () => {
    const { call, mk } = await setup();
    const a = await mk("aa", { title: "Partner" });
    await mk("bb", { title: "Associate" });
    await mk("cc", { title: "Associate" });
    const all = await call("GET", "/Users");
    expect(all.body).toMatchObject({ schemas: [LIST], totalResults: 4, startIndex: 1 });
    // The seeded admin is the fourth person.
    const page = await call("GET", "/Users?startIndex=2&count=2&sortBy=userName");
    expect(page.body).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
    const desc = await call("GET", "/Users?sortBy=userName&sortOrder=descending&count=1");
    const asc = await call("GET", "/Users?sortBy=userName&sortOrder=ascending&count=1");
    expect(desc.body.Resources[0].userName >= asc.body.Resources[0].userName).toBe(true);
    const zero = await call("GET", "/Users?count=0");
    expect(zero.body).toMatchObject({ totalResults: 4, itemsPerPage: 0, Resources: [] });
    const eq = await call(
      "GET",
      `/Users?filter=${encodeURIComponent(`userName eq "${a.userName.toUpperCase()}"`)}`,
    );
    expect(eq.body.totalResults).toBe(1);
    const co = await call(
      "GET",
      `/Users?filter=${encodeURIComponent('title eq "Associate" and userName co "-"')}`,
    );
    expect(co.body.totalResults).toBe(2);
    const pr = await call("GET", `/Users?filter=${encodeURIComponent("title pr")}`);
    expect(pr.body.totalResults).toBe(3);
    const nested = await call(
      "GET",
      `/Users?filter=${encodeURIComponent('emails[type eq "work" and value co "@x.test"]')}`,
    );
    expect(nested.body.totalResults).toBe(3);
    const only = await call("GET", "/Users?attributes=userName&count=1");
    expect(Object.keys(only.body.Resources[0]).sort()).toEqual(["id", "schemas", "userName"]);
    const without = await call("GET", "/Users?excludedAttributes=emails,name.givenName&count=1");
    expect(without.body.Resources[0].emails).toBeUndefined();
    const lm = await call(
      "GET",
      `/Users?filter=${encodeURIComponent('meta.lastModified gt "2000-01-01T00:00:00Z"')}`,
    );
    expect(lm.body.totalResults).toBe(4);
  });

  it("returns a filter on id and externalId", async () => {
    const { call, mk } = await setup();
    const u = await mk("ext", { externalId: "EXT-1" });
    expect(
      (await call("GET", `/Users?filter=${encodeURIComponent('externalId eq "EXT-1"')}`)).body
        .totalResults,
    ).toBe(1);
    expect(
      (await call("GET", `/Users?filter=${encodeURIComponent(`id eq "${u.id}"`)}`)).body
        .totalResults,
    ).toBe(1);
    expect(
      (await call("GET", `/Users?filter=${encodeURIComponent('id eq "zzz"')}`)).body.totalResults,
    ).toBe(0);
  });

  it("replaces with PUT, honouring If-Match", async () => {
    const { call, mk } = await setup();
    const u = await mk("put", { title: "Old" });
    const etag = (await call("GET", `/Users/${u.id}`)).headers.get("etag") ?? "";
    const r = await call(
      "PUT",
      `/Users/${u.id}`,
      { schemas: [USER_URN], userName: u.userName, title: "New", active: true },
      { "if-match": etag },
    );
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("New");
    expect(r.headers.get("etag")).not.toBe(etag);
    const stale = await call(
      "PUT",
      `/Users/${u.id}`,
      { schemas: [USER_URN], userName: u.userName },
      { "if-match": etag },
    );
    expect(stale.status).toBe(412);
    expect(stale.body.scimType).toBe("invalidVers");
    // A PUT without a title clears it.
    const cleared = await call("PUT", `/Users/${u.id}`, {
      schemas: [USER_URN],
      userName: u.userName,
    });
    expect(cleared.body.title).toBeUndefined();
  });

  it("409s a PUT that renames onto another person", async () => {
    const { call, mk } = await setup();
    const a = await mk("a");
    const b = await mk("b");
    const r = await call("PUT", `/Users/${b.id}`, { schemas: [USER_URN], userName: a.userName });
    expect(r.status).toBe(409);
  });

  it("patches, atomically", async () => {
    const { call, mk } = await setup();
    const u = await mk("patch", { title: "A" });
    const ok = await call("PATCH", `/Users/${u.id}`, {
      schemas: [PATCH_URN],
      Operations: [
        { op: "replace", path: "title", value: "B" },
        { op: "add", path: "name.givenName", value: "Pat" },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: "B", name: { givenName: "Pat" } });
    const bad = await call("PATCH", `/Users/${u.id}`, {
      schemas: [PATCH_URN],
      Operations: [
        { op: "replace", path: "title", value: "C" },
        { op: "replace", path: "id", value: "x" },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.scimType).toBe("mutability");
    expect((await call("GET", `/Users/${u.id}`)).body.title).toBe("B");
    const noTarget = await call("PATCH", `/Users/${u.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: 'emails[type eq "zzz"].value', value: "a@b.test" }],
    });
    expect(noTarget.body.scimType).toBe("noTarget");
    const badPath = await call("PATCH", `/Users/${u.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "shoeSize", value: "9" }],
    });
    expect(badPath.body.scimType).toBe("invalidPath");
  });

  it("deactivates with active=false, keeps the user visible, and can reactivate", async () => {
    const { call, mk } = await setup();
    const u = await mk("deact");
    const off = await call("PATCH", `/Users/${u.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.body.active).toBe(false);
    expect((await call("GET", `/Users/${u.id}`)).body.active).toBe(false);
    const on = await call("PATCH", `/Users/${u.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(on.body.active).toBe(true);
  });

  it("deletes with 204, then 404, and lets the same userName be created again", async () => {
    const { call, mk } = await setup();
    const u = await mk("del");
    expect((await call("DELETE", `/Users/${u.id}`)).status).toBe(204);
    expect((await call("GET", `/Users/${u.id}`)).status).toBe(404);
    expect((await call("DELETE", `/Users/${u.id}`)).status).toBe(404);
    const back = await call("POST", "/Users", { schemas: [USER_URN], userName: u.userName });
    expect(back.status).toBe(201);
    expect(back.body.id).toBe(u.id);
  });
});

describe("Groups", () => {
  it("creates with members, reads them back, and lists with the user's groups", async () => {
    const { call, mk } = await setup();
    const u = await mk("m");
    const g = await call("POST", "/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Litigation",
      externalId: "grp-1",
      members: [{ value: u.id }],
    });
    expect(g.status).toBe(201);
    expect(g.headers.get("location")).toContain(`/Groups/${g.body.id}`);
    expect(g.body.members).toMatchObject([{ value: u.id, type: "User" }]);
    expect((await call("GET", `/Users/${u.id}`)).body.groups).toMatchObject([
      { value: g.body.id, display: "Litigation" },
    ]);
    const list = await call(
      "GET",
      `/Groups?filter=${encodeURIComponent('displayName eq "litigation"')}`,
    );
    expect(list.body.totalResults).toBe(1);
    const noMembers = await call("GET", "/Groups?excludedAttributes=members");
    expect(noMembers.body.Resources[0].members).toBeUndefined();
  });

  it("409s a duplicate name and 400s an unknown member", async () => {
    const { call } = await setup();
    await call("POST", "/Groups", { displayName: "Dup" });
    expect((await call("POST", "/Groups", { displayName: "Dup" })).status).toBe(409);
    const bad = await call("POST", "/Groups", {
      displayName: "X",
      members: [{ value: randomUUID() }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.scimType).toBe("invalidValue");
    expect(
      (await call("POST", "/Groups", { displayName: "Y", members: [{ value: "nope" }] })).status,
    ).toBe(400);
  });

  it("adds, removes and replaces members by PATCH, and removes all without a filter", async () => {
    const { call, mk } = await setup();
    const [a, b, c] = [await mk("a"), await mk("b"), await mk("c")];
    const g = await call("POST", "/Groups", { displayName: "Team" });
    const url = `/Groups/${g.body.id}`;
    const patch = (...Operations: object[]) =>
      call("PATCH", url, { schemas: [PATCH_URN], Operations });
    const added = await patch({
      op: "add",
      path: "members",
      value: [{ value: a.id }, { value: b.id }],
    });
    expect(added.body.members).toHaveLength(2);
    const one = await patch({ op: "remove", path: `members[value eq "${a.id}"]` });
    expect(one.body.members.map((m: { value: string }) => m.value)).toEqual([b.id]);
    const replaced = await patch({ op: "replace", path: "members", value: [{ value: c.id }] });
    expect(replaced.body.members.map((m: { value: string }) => m.value)).toEqual([c.id]);
    const renamed = await patch({ op: "replace", path: "displayName", value: "Team 2" });
    expect(renamed.body.displayName).toBe("Team 2");
    await patch({ op: "add", path: "members", value: [{ value: a.id }] });
    const none = await patch({ op: "remove", path: "members" });
    expect(none.body.members).toEqual([]);
  });

  it("replaces with PUT and deletes", async () => {
    const { call, mk } = await setup();
    const a = await mk("a");
    const g = await call("POST", "/Groups", { displayName: "G", members: [{ value: a.id }] });
    const put = await call("PUT", `/Groups/${g.body.id}`, { displayName: "G2", members: [] });
    expect(put.body).toMatchObject({ displayName: "G2" });
    expect(put.body.members).toEqual([]);
    expect((await call("DELETE", `/Groups/${g.body.id}`)).status).toBe(204);
    expect((await call("GET", `/Groups/${g.body.id}`)).status).toBe(404);
  });
});
