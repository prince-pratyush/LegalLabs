import { ENTERPRISE_URN, GROUP_URN, LEGALLABS_URN, USER_URN } from "./schemas.js";

// Maps core.user and core."group" rows to SCIM documents and back. userName is the sign-in
// email; title, practice area, profession and country live in profile; the rest of what a
// provider writes is kept as sent in profile.scim.

type Doc = Record<string, unknown>;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  profile: Doc;
  created_at: Date;
  updated_at: Date;
  scim_external_id: string | null;
  scim_version: number;
  groups: { id: string; name: string }[];
}

export interface GroupRow {
  id: string;
  name: string;
  scim_group_id: string | null;
  created_at: Date;
  updated_at: Date;
  scim_version: number;
  members: { id: string; email: string }[];
}

export const etagOf = (version: number) => `W/"${version}"`;

const MANAGED = ["title", "practice_area", "profession", "country", "scim"];
const BAG = [
  "name",
  "nickName",
  "profileUrl",
  "userType",
  "preferredLanguage",
  "locale",
  "timezone",
  "emails",
  "phoneNumbers",
  "addresses",
];

export function toUserDoc(row: UserRow, base: string): Doc {
  const bag = (row.profile.scim ?? {}) as Doc;
  const legal: Doc = {};
  if (typeof row.profile.practice_area === "string") legal.practiceArea = row.profile.practice_area;
  if (typeof row.profile.profession === "string") legal.profession = row.profile.profession;
  if (typeof row.profile.country === "string") legal.country = row.profile.country;
  const enterprise = bag[ENTERPRISE_URN];
  const doc: Doc = {
    schemas: [
      USER_URN,
      ...(enterprise ? [ENTERPRISE_URN] : []),
      ...(Object.keys(legal).length > 0 ? [LEGALLABS_URN] : []),
    ],
    id: row.id,
    ...(row.scim_external_id ? { externalId: row.scim_external_id } : {}),
    userName: row.email,
    ...Object.fromEntries(BAG.filter((k) => bag[k] !== undefined).map((k) => [k, bag[k]])),
    ...(row.name ? { displayName: row.name } : {}),
    ...(typeof row.profile.title === "string" ? { title: row.profile.title } : {}),
    active: row.status === "active",
    emails: bag.emails ?? [{ value: row.email, type: "work", primary: true }],
    groups: row.groups.map((g) => ({
      value: g.id,
      display: g.name,
      $ref: `${base}/Groups/${g.id}`,
      type: "direct",
    })),
    meta: {
      resourceType: "User",
      created: row.created_at.toISOString(),
      lastModified: row.updated_at.toISOString(),
      location: `${base}/Users/${row.id}`,
      version: etagOf(row.scim_version),
    },
  };
  if (enterprise) doc[ENTERPRISE_URN] = enterprise;
  if (Object.keys(legal).length > 0) doc[LEGALLABS_URN] = legal;
  return doc;
}

export interface UserColumns {
  email: string;
  name: string;
  externalId: string | null;
  /** undefined: the document did not say, so the status stays. */
  active: boolean | undefined;
  profile: Doc;
}

/** The columns a SCIM document sets; other keys already in profile are kept. */
export function fromUserDoc(doc: Doc, existingProfile: Doc): UserColumns {
  const name = (doc.name ?? {}) as Doc;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const display =
    text(doc.displayName) ||
    text(name.formatted) ||
    [text(name.givenName), text(name.familyName)].filter(Boolean).join(" ");
  const legal = (doc[LEGALLABS_URN] ?? {}) as Doc;
  const profile: Doc = { ...existingProfile };
  for (const k of MANAGED) delete profile[k];
  if (typeof doc.title === "string") profile.title = doc.title;
  if (typeof legal.practiceArea === "string") profile.practice_area = legal.practiceArea;
  if (typeof legal.profession === "string") profile.profession = legal.profession;
  if (typeof legal.country === "string") profile.country = legal.country;
  const bag: Doc = {};
  for (const k of BAG) if (doc[k] !== undefined) bag[k] = doc[k];
  if (doc[ENTERPRISE_URN] !== undefined) bag[ENTERPRISE_URN] = doc[ENTERPRISE_URN];
  if (Object.keys(bag).length > 0) profile.scim = bag;
  return {
    email: text(doc.userName).trim(),
    name: display.slice(0, 500),
    externalId: typeof doc.externalId === "string" && doc.externalId ? doc.externalId : null,
    active: typeof doc.active === "boolean" ? doc.active : undefined,
    profile,
  };
}

export function toGroupDoc(row: GroupRow, base: string, withMembers = true): Doc {
  return {
    schemas: [GROUP_URN],
    id: row.id,
    ...(row.scim_group_id ? { externalId: row.scim_group_id } : {}),
    displayName: row.name,
    ...(withMembers
      ? {
          members: row.members.map((m) => ({
            value: m.id,
            display: m.email,
            $ref: `${base}/Users/${m.id}`,
            type: "User",
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: row.created_at.toISOString(),
      lastModified: row.updated_at.toISOString(),
      location: `${base}/Groups/${row.id}`,
      version: etagOf(row.scim_version),
    },
  };
}

/** A copy holding only the attributes asked for, or without the ones excluded. */
export function project(
  doc: Doc,
  attributes: string | undefined,
  excluded: string | undefined,
): Doc {
  const list = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  const want = list(attributes);
  const drop = list(excluded);
  if (want.length === 0 && drop.length === 0) return doc;
  const out: Doc = {};
  const wanted = (top: string, urn?: string) =>
    want.some((w) => w === top || w.startsWith(`${top}.`) || (urn && w.startsWith(`${urn}:`)));
  for (const [k, v] of Object.entries(doc)) {
    const lower = k.toLowerCase();
    if (lower === "schemas" || lower === "id") {
      out[k] = v;
      continue;
    }
    if (want.length > 0) {
      if (lower.startsWith("urn:")) {
        const inner = (v ?? {}) as Doc;
        const keep = Object.fromEntries(
          Object.entries(inner).filter(
            ([ik]) => want.includes(lower) || want.includes(`${lower}:${ik.toLowerCase()}`),
          ),
        );
        if (Object.keys(keep).length > 0) out[k] = keep;
      } else if (want.includes(lower)) out[k] = v;
      else if (wanted(lower) && typeof v === "object" && v !== null) {
        const subs = want
          .filter((w) => w.startsWith(`${lower}.`))
          .map((w) => w.slice(lower.length + 1));
        const pick = (o: Doc) =>
          Object.fromEntries(Object.entries(o).filter(([sk]) => subs.includes(sk.toLowerCase())));
        out[k] = Array.isArray(v) ? v.map((e) => pick(e as Doc)) : pick(v as Doc);
      }
      continue;
    }
    const gone = drop.some(
      (d) => d === lower || (lower.startsWith("urn:") && d.startsWith(`${lower}:`)),
    );
    if (!gone) out[k] = v;
  }
  if (want.length === 0) {
    for (const d of drop) {
      const [top, sub] = d.split(".");
      const key = Object.keys(out).find((k) => k.toLowerCase() === top);
      if (!key || !sub || typeof out[key] !== "object" || out[key] === null) continue;
      const strip = (o: Doc) =>
        Object.fromEntries(Object.entries(o).filter(([sk]) => sk.toLowerCase() !== sub));
      const cur = out[key];
      out[key] = Array.isArray(cur) ? cur.map((e) => strip(e as Doc)) : strip(cur as Doc);
    }
  }
  return out;
}
