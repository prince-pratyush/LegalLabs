// UNVERIFIED against real Okta. Modelled on the "Okta SCIM 2.0 SPEC Test" scenarios and the
// Okta SCIM 2.0 provisioning docs (create, lookup before create, PUT/PATCH update, deactivate
// by active=false, group push, 1-based startIndex, count=1 probes).
import type { Scenario } from "./types.js";

const CORE = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const oktaUser = (email: string, extra: object = {}) => ({
  schemas: [CORE],
  userName: email,
  name: { givenName: "Okta", familyName: "Tester", formatted: "Okta Tester" },
  displayName: "Okta Tester",
  emails: [{ primary: true, value: email, type: "work" }],
  active: true,
  ...extra,
});

export const oktaScenarios: Scenario[] = [
  {
    name: "ServiceProviderConfig and discovery",
    source: "Okta SPEC Test: Test Users and Groups endpoints; SCIM 2.0 setup",
    steps: [
      {
        name: "ServiceProviderConfig advertises patch and filter",
        method: "GET",
        path: "/ServiceProviderConfig",
        status: 200,
        match: { "patch.supported": true, "filter.supported": true },
      },
      {
        name: "ResourceTypes",
        method: "GET",
        path: "/ResourceTypes",
        status: 200,
        match: { totalResults: 2 },
      },
      {
        name: "Schemas",
        method: "GET",
        path: "/Schemas",
        status: 200,
        match: { "Resources.0.schemas.0": { $exists: true } },
      },
    ],
  },
  {
    name: "Lookup before create, then create",
    source: "Okta SPEC Test: Get users with filter; Create user (userName eq lookup precedes POST)",
    steps: [
      {
        name: "probe with count=1 finds nothing",
        method: "GET",
        path: "/Users",
        query: { filter: 'userName eq "okta-{{n}}@example.test"', startIndex: "1", count: "1" },
        status: 200,
        match: { totalResults: 0, startIndex: 1 },
      },
      {
        name: "create",
        method: "POST",
        path: "/Users",
        body: oktaUser("okta-{{n}}@example.test"),
        status: 201,
        save: { uid: "id" },
        match: { active: true, userName: "okta-{{n}}@example.test", "meta.resourceType": "User" },
      },
      {
        name: "lookup now finds exactly one",
        method: "GET",
        path: "/Users",
        query: { filter: 'userName eq "okta-{{n}}@example.test"', startIndex: "1", count: "1" },
        status: 200,
        match: { totalResults: 1, itemsPerPage: 1, "Resources.0.id": "{{uid}}" },
      },
      {
        name: "creating the same userName again is a 409",
        method: "POST",
        path: "/Users",
        body: oktaUser("okta-{{n}}@example.test"),
        status: 409,
        match: { scimType: "uniqueness" },
      },
      {
        name: "get by id",
        method: "GET",
        path: "/Users/{{uid}}",
        status: 200,
        match: { id: "{{uid}}" },
      },
      {
        name: "unknown id is a 404 in SCIM error form",
        method: "GET",
        path: "/Users/00000000-0000-4000-8000-000000000000",
        status: 404,
        match: { status: "404", "schemas.0": "urn:ietf:params:scim:api:messages:2.0:Error" },
      },
    ],
  },
  {
    name: "Update with PUT, then PATCH, then deactivate and reactivate",
    source: "Okta SPEC Test: Update user (PUT), Update user attributes (PATCH), Deactivate user",
    steps: [
      {
        name: "create",
        method: "POST",
        path: "/Users",
        body: oktaUser("okta-{{n}}@example.test"),
        status: 201,
        save: { uid: "id" },
      },
      {
        name: "PUT replaces the profile",
        method: "PUT",
        path: "/Users/{{uid}}",
        body: oktaUser("okta-{{n}}@example.test", {
          name: { givenName: "Updated", familyName: "Name", formatted: "Updated Name" },
          displayName: "Updated Name",
          title: "Partner",
        }),
        status: 200,
        match: { "name.givenName": "Updated", title: "Partner", displayName: "Updated Name" },
      },
      {
        name: "PATCH replaces an attribute with a path",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "title", value: "Counsel" }],
        },
        status: 200,
        match: { title: "Counsel" },
      },
      {
        name: "PATCH replace without a path takes an object",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "replace", value: { displayName: "Via Object" } }],
        },
        status: 200,
        match: { displayName: "Via Object" },
      },
      {
        name: "deactivate with active=false",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] },
        status: 200,
        match: { active: false },
      },
      {
        name: "a deactivated user is still found by userName",
        method: "GET",
        path: "/Users",
        query: { filter: 'userName eq "okta-{{n}}@example.test"' },
        status: 200,
        match: { totalResults: 1, "Resources.0.active": false },
      },
      {
        name: "reactivate",
        method: "PUT",
        path: "/Users/{{uid}}",
        body: oktaUser("okta-{{n}}@example.test"),
        status: 200,
        match: { active: true },
      },
    ],
  },
  {
    name: "Pagination uses a 1-based startIndex",
    source: "Okta SPEC Test: Users pagination (startIndex 1-based, count)",
    steps: [
      {
        name: "a",
        method: "POST",
        path: "/Users",
        body: oktaUser("pa-{{n}}@example.test"),
        status: 201,
      },
      {
        name: "b",
        method: "POST",
        path: "/Users",
        body: oktaUser("pb-{{n}}@example.test"),
        status: 201,
      },
      {
        name: "c",
        method: "POST",
        path: "/Users",
        body: oktaUser("pc-{{n}}@example.test"),
        status: 201,
      },
      {
        name: "first page",
        method: "GET",
        path: "/Users",
        query: { startIndex: "1", count: "2", sortBy: "userName" },
        status: 200,
        match: { startIndex: 1, itemsPerPage: 2, totalResults: { $gte: 3 } },
      },
      {
        name: "second page starts at 3",
        method: "GET",
        path: "/Users",
        query: { startIndex: "3", count: "2", sortBy: "userName" },
        status: 200,
        match: { startIndex: 3, itemsPerPage: { $gte: 1 } },
      },
      {
        name: "past the end is empty, not an error",
        method: "GET",
        path: "/Users",
        query: { startIndex: "500", count: "2" },
        status: 200,
        match: { itemsPerPage: 0, Resources: { $len: 0 } },
      },
    ],
  },
  {
    name: "Group push: create, add and remove members, rename, delete",
    source: "Okta SPEC Test: Create group, Add/remove group members, Group filter; Group Push",
    steps: [
      {
        name: "member 1",
        method: "POST",
        path: "/Users",
        body: oktaUser("gm1-{{n}}@example.test"),
        status: 201,
        save: { u1: "id" },
      },
      {
        name: "member 2",
        method: "POST",
        path: "/Users",
        body: oktaUser("gm2-{{n}}@example.test"),
        status: 201,
        save: { u2: "id" },
      },
      {
        name: "lookup before create finds no group",
        method: "GET",
        path: "/Groups",
        query: { filter: 'displayName eq "Okta Group {{n}}"', count: "1" },
        status: 200,
        match: { totalResults: 0 },
      },
      {
        name: "create with no members",
        method: "POST",
        path: "/Groups",
        body: { schemas: [GROUP], displayName: "Okta Group {{n}}", members: [] },
        status: 201,
        save: { gid: "id" },
        match: { displayName: "Okta Group {{n}}" },
      },
      {
        name: "add members",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: {
          schemas: [PATCH],
          Operations: [
            {
              op: "add",
              path: "members",
              value: [{ value: "{{u1}}", display: "one" }, { value: "{{u2}}" }],
            },
          ],
        },
        status: 200,
        match: { members: { $len: 2 } },
      },
      {
        name: "the user lists its group",
        method: "GET",
        path: "/Users/{{u1}}",
        status: 200,
        match: { "groups.0.value": "{{gid}}" },
      },
      {
        name: "remove one member by value filter",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "remove", path: 'members[value eq "{{u2}}"]' }],
        },
        status: 200,
        match: { members: { $len: 1 }, "members.0.value": "{{u1}}" },
      },
      {
        name: "rename",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "displayName", value: "Okta Renamed {{n}}" }],
        },
        status: 200,
        match: { displayName: "Okta Renamed {{n}}" },
      },
      {
        name: "filter finds it by displayName",
        method: "GET",
        path: "/Groups",
        query: { filter: 'displayName eq "Okta Renamed {{n}}"' },
        status: 200,
        match: { totalResults: 1 },
      },
      { name: "delete", method: "DELETE", path: "/Groups/{{gid}}", status: 204 },
      { name: "gone", method: "GET", path: "/Groups/{{gid}}", status: 404 },
    ],
  },
];
