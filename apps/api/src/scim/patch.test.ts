import { describe, expect, it } from "vitest";
import { ScimError } from "./errors.js";
import { applyPatch, normalizeBody, parsePatchPath } from "./patch.js";
import { ENTERPRISE_URN, groupResource, PATCH_URN, userResource } from "./schemas.js";

const user = () => ({
  userName: "ana@x.test",
  active: true,
  name: { givenName: "Ana", familyName: "Silva" },
  emails: [
    { value: "ana@x.test", type: "work", primary: true },
    { value: "ana@home.test", type: "home" },
  ],
  title: "Associate",
});
const patch = (...Operations: object[]) => ({ schemas: [PATCH_URN], Operations });
const run = (doc: object, ...ops: object[]) =>
  applyPatch(userResource, doc as Record<string, unknown>, patch(...ops));

const fails = (fn: () => unknown, scimType: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).scimType).toBe(scimType);
    return;
  }
  throw new Error(`expected ${scimType}`);
};

describe("path parsing", () => {
  it("reads attributes, sub-attributes, filters and extension URNs", () => {
    expect(parsePatchPath("title")).toEqual({ attr: "title" });
    expect(parsePatchPath("name.givenName")).toEqual({ attr: "name", sub: "givenName" });
    expect(parsePatchPath(`${ENTERPRISE_URN}:department`)).toEqual({
      urn: ENTERPRISE_URN,
      attr: "department",
    });
    expect(parsePatchPath(ENTERPRISE_URN)).toEqual({ urn: ENTERPRISE_URN });
    const p = parsePatchPath('emails[type eq "work"].value');
    expect(p.attr).toBe("emails");
    expect(p.sub).toBe("value");
    expect(p.filter?.type).toBe("compare");
    expect(parsePatchPath('members[value eq "a]b"]').filter).toBeDefined();
  });

  it.each(["", "a..b", "emails[type eq", "x:y:z", "emails[type eq 1]x", "a.b.c"])(
    "refuses %j",
    (bad) => {
      expect(() => parsePatchPath(bad)).toThrow(ScimError);
    },
  );
});

describe("add, replace and remove", () => {
  it("replaces and adds simple and complex attributes", () => {
    const out = run(
      user(),
      { op: "replace", path: "title", value: "Partner" },
      { op: "add", path: "name.middleName", value: "M" },
      { op: "replace", path: "name.givenName", value: "Anna" },
    );
    expect(out.title).toBe("Partner");
    expect(out.name).toEqual({ givenName: "Anna", familyName: "Silva", middleName: "M" });
  });

  it("does not modify its input, and applies all operations or none", () => {
    const before = user();
    fails(
      () =>
        run(
          before,
          { op: "replace", path: "title", value: "X" },
          { op: "replace", path: "id", value: "y" },
        ),
      "mutability",
    );
    expect(before.title).toBe("Associate");
  });

  it("edits one entry of a multi-valued attribute by filter", () => {
    const out = run(user(), {
      op: "replace",
      path: 'emails[type eq "work"].value',
      value: "ana@new.test",
    });
    expect((out.emails as { value: string }[])[0]?.value).toBe("ana@new.test");
    expect((out.emails as { value: string }[])[1]?.value).toBe("ana@home.test");
  });

  it("adds a missing entry by filter, building it from the filter's terms", () => {
    const out = run(
      { userName: "a@b.test" },
      { op: "add", path: 'emails[type eq "work"].value', value: "a@b.test" },
    );
    expect(out.emails).toEqual([{ type: "work", value: "a@b.test" }]);
  });

  it("refuses to replace an entry that is not there", () => {
    fails(
      () =>
        run(user(), { op: "replace", path: 'emails[type eq "other"].value', value: "x@y.test" }),
      "noTarget",
    );
  });

  it("appends to a multi-valued attribute without duplicating, and keeps one primary", () => {
    const out = run(
      user(),
      { op: "add", path: "emails", value: [{ value: "ana@home.test", type: "home" }] },
      { op: "add", path: "emails", value: { value: "b@x.test", type: "other", primary: true } },
    );
    const emails = out.emails as { value: string; primary?: boolean }[];
    expect(emails).toHaveLength(3);
    expect(emails.filter((e) => e.primary).map((e) => e.value)).toEqual(["b@x.test"]);
  });

  it("removes by filter, a sub-attribute, or the whole attribute", () => {
    const out = run(
      user(),
      { op: "remove", path: 'emails[type eq "home"]' },
      { op: "remove", path: "name.familyName" },
      { op: "remove", path: "title" },
    );
    expect(out.emails).toEqual([{ value: "ana@x.test", type: "work", primary: true }]);
    expect(out.name).toEqual({ givenName: "Ana" });
    expect(out.title).toBeUndefined();
    expect(run(user(), { op: "remove", path: "emails[type pr]" }).emails).toBeUndefined();
  });

  it("treats removing something that is not there as nothing to do", () => {
    expect(run(user(), { op: "remove", path: "nickName" })).toEqual(user());
    expect(run(user(), { op: "remove", path: 'emails[type eq "zzz"]' })).toEqual(user());
  });

  it("will not remove a required attribute or change a read-only one", () => {
    fails(() => run(user(), { op: "remove", path: "userName" }), "mutability");
    fails(() => run(user(), { op: "replace", path: "meta.version", value: "1" }), "mutability");
    fails(() => run(user(), { op: "add", path: "groups", value: [] }), "mutability");
  });

  it("needs a path to remove", () => {
    fails(() => run(user(), { op: "remove" }), "noTarget");
  });

  it("refuses unknown attributes, schemas and operations", () => {
    fails(() => run(user(), { op: "replace", path: "shoeSize", value: "9" }), "invalidPath");
    fails(() => run(user(), { op: "replace", path: "x:y:z:title", value: "9" }), "invalidPath");
    fails(() => run(user(), { op: "move", path: "title", value: "9" }), "invalidSyntax");
    fails(() => run(user(), { op: "replace", path: "title", value: 7 }), "invalidValue");
  });

  it("writes extension attributes, and drops an extension left empty", () => {
    const out = run(user(), {
      op: "add",
      path: `${ENTERPRISE_URN}:department`,
      value: "Disputes",
    });
    expect(out[ENTERPRISE_URN]).toEqual({ department: "Disputes" });
    const gone = run(out, { op: "remove", path: `${ENTERPRISE_URN}:department` });
    expect(gone[ENTERPRISE_URN]).toBeUndefined();
  });
});

describe("Entra ID habits", () => {
  it("accepts capitalised operation names and an Operations key in any case", () => {
    const out = applyPatch(userResource, user(), {
      schemas: [PATCH_URN.toLowerCase()],
      Operations: [
        { op: "Replace", path: "title", value: "Partner" },
        { op: "Add", path: "nickName", value: "A" },
        { op: "Remove", path: "nickName" },
      ],
    });
    expect(out.title).toBe("Partner");
    expect(out.nickName).toBeUndefined();
  });

  it('turns "True" and "False" into booleans for active', () => {
    expect(run(user(), { op: "Replace", path: "active", value: "False" }).active).toBe(false);
    expect(run(user(), { op: "Replace", path: "active", value: "True" }).active).toBe(true);
    fails(() => run(user(), { op: "Replace", path: "active", value: "maybe" }), "invalidValue");
  });

  it("treats a path-less object as a set of paths, dotted and URN-qualified keys included", () => {
    const out = run(user(), {
      op: "Replace",
      value: {
        active: "False",
        "name.givenName": "Anna",
        [`${ENTERPRISE_URN}:department`]: "Tax",
        'emails[type eq "work"].value': "w@x.test",
        title: "Partner",
        id: "ignored",
      },
    });
    expect(out).toMatchObject({
      active: false,
      title: "Partner",
      name: { givenName: "Anna" },
      [ENTERPRISE_URN]: { department: "Tax" },
    });
    expect((out.emails as { value: string }[])[0]?.value).toBe("w@x.test");
    expect(out.id).toBeUndefined();
  });

  it("matches attribute names without regard to case", () => {
    const out = run(user(), { op: "replace", path: "TITLE", value: "P" });
    expect(out.title).toBe("P");
    expect(Object.keys(out)).not.toContain("TITLE");
  });
});

describe("group members", () => {
  const group = () => ({
    displayName: "Partners",
    members: [{ value: "u1" }, { value: "u2" }, { value: "u3" }],
  });
  const gp = (...ops: object[]) => applyPatch(groupResource, group(), patch(...ops));

  it("adds members, without repeating one already there", () => {
    const out = gp({ op: "add", path: "members", value: [{ value: "u3" }, { value: "u4" }] });
    expect(out.members).toEqual([
      { value: "u1" },
      { value: "u2" },
      { value: "u3" },
      { value: "u4" },
    ]);
  });

  it("removes one member by value filter", () => {
    expect(gp({ op: "remove", path: 'members[value eq "u2"]' }).members).toEqual([
      { value: "u1" },
      { value: "u3" },
    ]);
  });

  it("removes the named members when Entra sends them as a value", () => {
    expect(
      gp({ op: "Remove", path: "members", value: [{ value: "u1" }, { value: "u3" }] }).members,
    ).toEqual([{ value: "u2" }]);
  });

  it("removes every member when no filter and no value is given", () => {
    expect(gp({ op: "remove", path: "members" }).members).toBeUndefined();
  });

  it("replaces the whole membership", () => {
    expect(gp({ op: "replace", path: "members", value: [{ value: "u9" }] }).members).toEqual([
      { value: "u9" },
    ]);
  });

  it("renames through a path-less replace, as Okta does", () => {
    expect(gp({ op: "replace", value: { displayName: "Equity Partners" } }).displayName).toBe(
      "Equity Partners",
    );
  });
});

describe("request shape", () => {
  it("needs the PatchOp schema and a non-empty list", () => {
    fails(
      () =>
        applyPatch(userResource, user(), {
          Operations: [{ op: "add", path: "title", value: "x" }],
        }),
      "invalidSyntax",
    );
    fails(
      () => applyPatch(userResource, user(), { schemas: [PATCH_URN], Operations: [] }),
      "invalidSyntax",
    );
    fails(() => applyPatch(userResource, user(), "nope"), "invalidSyntax");
  });
});

describe("POST and PUT bodies", () => {
  it("keeps writable attributes, coerces types and ignores the rest", () => {
    const out = normalizeBody(userResource, {
      schemas: ["x"],
      id: "client-chosen",
      meta: { a: 1 },
      groups: [{ value: "g" }],
      userName: "a@b.test",
      active: "True",
      whatever: 1,
      [ENTERPRISE_URN]: { department: "Tax", nope: 1 },
    });
    expect(out).toEqual({
      userName: "a@b.test",
      active: true,
      [ENTERPRISE_URN]: { department: "Tax" },
    });
  });

  it("requires userName", () => {
    fails(() => normalizeBody(userResource, { active: true }), "invalidValue");
    fails(() => normalizeBody(userResource, { userName: "" }), "invalidValue");
    fails(() => normalizeBody(userResource, []), "invalidSyntax");
    fails(() => normalizeBody(groupResource, { members: [] }), "invalidValue");
  });

  it("refuses wrong types", () => {
    fails(() => normalizeBody(userResource, { userName: 5 }), "invalidValue");
    fails(() => normalizeBody(userResource, { userName: "a@b.test", emails: "x" }), "invalidValue");
    fails(() => normalizeBody(userResource, { userName: "a@b.test", name: "x" }), "invalidValue");
  });
});
