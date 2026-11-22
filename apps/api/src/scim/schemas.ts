// The attribute catalogue: one source for /Schemas, PATCH coercion, mutability checks and the
// URN prefixes a path or filter may carry.

export const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const LEGALLABS_URN = "urn:legallabs:params:scim:schemas:extension:1.0:User";
export const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const LIST_URN = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SPC_URN = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const RESOURCE_TYPE_URN = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_URN = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export type AttrType = "string" | "boolean" | "complex" | "integer" | "dateTime" | "reference";

export interface AttrDef {
  name: string;
  type: AttrType;
  multi?: boolean;
  required?: boolean;
  readOnly?: boolean;
  /** Fixed once set, like a member's value. */
  immutable?: boolean;
  caseExact?: boolean;
  unique?: "none" | "server";
  description?: string;
  sub?: AttrDef[];
}

export interface SchemaDef {
  id: string;
  name: string;
  description: string;
  attributes: AttrDef[];
}

const str = (name: string, more: Partial<AttrDef> = {}): AttrDef => ({
  name,
  type: "string",
  ...more,
});
const bool = (name: string, more: Partial<AttrDef> = {}): AttrDef => ({
  name,
  type: "boolean",
  ...more,
});
const complex = (name: string, sub: AttrDef[], more: Partial<AttrDef> = {}): AttrDef => ({
  name,
  type: "complex",
  sub,
  ...more,
});

const typed = [str("value"), str("display"), str("type"), bool("primary")];

export const userSchema: SchemaDef = {
  id: USER_URN,
  name: "User",
  description: "User Account",
  attributes: [
    str("id", { readOnly: true, caseExact: true, unique: "server" }),
    str("externalId", { caseExact: true }),
    str("userName", { required: true, unique: "server" }),
    complex("name", [
      str("formatted"),
      str("familyName"),
      str("givenName"),
      str("middleName"),
      str("honorificPrefix"),
      str("honorificSuffix"),
    ]),
    str("displayName"),
    str("nickName"),
    str("profileUrl"),
    str("title"),
    str("userType"),
    str("preferredLanguage"),
    str("locale"),
    str("timezone"),
    bool("active"),
    complex("emails", typed, { multi: true }),
    complex("phoneNumbers", typed, { multi: true }),
    complex(
      "addresses",
      [
        str("formatted"),
        str("streetAddress"),
        str("locality"),
        str("region"),
        str("postalCode"),
        str("country"),
        str("type"),
        bool("primary"),
      ],
      { multi: true },
    ),
    complex(
      "groups",
      [
        str("value", { readOnly: true }),
        { name: "$ref", type: "reference", readOnly: true },
        str("display", { readOnly: true }),
        str("type", { readOnly: true }),
      ],
      { multi: true, readOnly: true },
    ),
    complex(
      "meta",
      [
        str("resourceType"),
        { name: "created", type: "dateTime" },
        { name: "lastModified", type: "dateTime" },
        str("location"),
        str("version"),
      ],
      { readOnly: true },
    ),
  ],
};

export const enterpriseSchema: SchemaDef = {
  id: ENTERPRISE_URN,
  name: "EnterpriseUser",
  description: "Enterprise User",
  attributes: [
    str("employeeNumber"),
    str("costCenter"),
    str("organization"),
    str("division"),
    str("department"),
    complex("manager", [str("value"), { name: "$ref", type: "reference" }, str("displayName")]),
  ],
};

export const legallabsSchema: SchemaDef = {
  id: LEGALLABS_URN,
  name: "LegalLabsUser",
  description: "Professional profile kept on the person",
  attributes: [str("practiceArea"), str("profession"), str("country")],
};

export const groupSchema: SchemaDef = {
  id: GROUP_URN,
  name: "Group",
  description: "Group",
  attributes: [
    str("id", { readOnly: true, caseExact: true, unique: "server" }),
    str("externalId", { caseExact: true }),
    str("displayName", { required: true, unique: "server" }),
    complex(
      "members",
      [
        str("value", { immutable: true }),
        { name: "$ref", type: "reference", immutable: true },
        str("type", { immutable: true }),
        str("display", { readOnly: true }),
      ],
      { multi: true },
    ),
    complex(
      "meta",
      [
        str("resourceType"),
        { name: "created", type: "dateTime" },
        { name: "lastModified", type: "dateTime" },
        str("location"),
        str("version"),
      ],
      { readOnly: true },
    ),
  ],
};

export interface ResourceDef {
  name: "User" | "Group";
  endpoint: "/Users" | "/Groups";
  description: string;
  core: SchemaDef;
  extensions: SchemaDef[];
}

export const userResource: ResourceDef = {
  name: "User",
  endpoint: "/Users",
  description: "User Account",
  core: userSchema,
  extensions: [enterpriseSchema, legallabsSchema],
};
export const groupResource: ResourceDef = {
  name: "Group",
  endpoint: "/Groups",
  description: "Group",
  core: groupSchema,
  extensions: [],
};

export const allSchemas = [userSchema, groupSchema, enterpriseSchema, legallabsSchema];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const findAttr = (attrs: AttrDef[], name: string) => attrs.find((a) => same(a.name, name));

/** The URN a path names, matched without regard to case; undefined when it names none we hold. */
export const knownUrn = (urn: string) => allSchemas.find((s) => same(s.id, urn))?.id;

export const extensionAttrs = (def: ResourceDef, urn: string): AttrDef[] | undefined =>
  def.extensions.find((e) => same(e.id, urn))?.attributes;

const mutability = (a: AttrDef) =>
  a.readOnly ? "readOnly" : a.immutable ? "immutable" : "readWrite";

function describe(a: AttrDef): object {
  return {
    name: a.name,
    type: a.type,
    multiValued: a.multi ?? false,
    description: a.description ?? a.name,
    required: a.required ?? false,
    caseExact: a.caseExact ?? false,
    mutability: mutability(a),
    returned: "default",
    uniqueness: a.unique ?? "none",
    ...(a.sub ? { subAttributes: a.sub.map(describe) } : {}),
  };
}

export const schemaDocument = (s: SchemaDef, base: string) => ({
  schemas: [SCHEMA_URN],
  id: s.id,
  name: s.name,
  description: s.description,
  attributes: s.attributes.map(describe),
  meta: { resourceType: "Schema", location: `${base}/Schemas/${s.id}` },
});
