// UNVERIFIED against real Microsoft Entra ID. Modelled on Microsoft's public documentation:
// "Tutorial: Develop and plan provisioning for a SCIM endpoint" and "Known issues and
// resolutions with SCIM 2.0 protocol compliance" (capitalised op names, "True"/"False"
// strings, path-less replace objects, member add/remove, userName/externalId lookups,
// soft delete through active).
import type { Scenario } from "./types.js";

const CORE = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const entraUser = (upn: string, ext: string) => ({
  schemas: [CORE, ENT],
  externalId: ext,
  userName: upn,
  active: true,
  displayName: "Entra Person",
  title: "Associate",
  emails: [{ type: "work", value: upn, primary: true }],
  name: { givenName: "Entra", familyName: "Person" },
  [ENT]: { department: "Disputes", employeeNumber: "E-1001" },
});

export const entraScenarios: Scenario[] = [
  {
    name: "Probe, create and match by externalId",
    source: "Entra provisioning: GET /Users?filter=userName eq / externalId eq before create",
    steps: [
      {
        name: "userName probe",
        method: "GET",
        path: "/Users",
        query: { filter: 'userName eq "entra-{{n}}@example.test"' },
        status: 200,
        match: {
          totalResults: 0,
          "schemas.0": "urn:ietf:params:scim:api:messages:2.0:ListResponse",
        },
      },
      {
        name: "externalId probe",
        method: "GET",
        path: "/Users",
        query: { filter: 'externalId eq "ext-{{n}}"' },
        status: 200,
        match: { totalResults: 0 },
      },
      {
        name: "create with the enterprise extension",
        method: "POST",
        path: "/Users",
        body: entraUser("entra-{{n}}@example.test", "ext-{{n}}"),
        status: 201,
        save: { uid: "id" },
        match: {
          externalId: "ext-{{n}}",
          active: true,
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User.department": "Disputes",
        },
      },
      {
        name: "externalId lookup finds it",
        method: "GET",
        path: "/Users",
        query: { filter: 'externalId eq "ext-{{n}}"' },
        status: 200,
        match: { totalResults: 1, "Resources.0.id": "{{uid}}" },
      },
      {
        name: "userName is matched case-insensitively",
        method: "GET",
        path: "/Users",
        query: { filter: 'userName eq "ENTRA-{{n}}@EXAMPLE.TEST"' },
        status: 200,
        match: { totalResults: 1 },
      },
    ],
  },
  {
    name: "PATCH with Entra's quirks",
    source:
      "Entra provisioning: PATCH Operations use Add/Replace/Remove, filter paths and string booleans",
    steps: [
      {
        name: "create",
        method: "POST",
        path: "/Users",
        body: entraUser("entra-{{n}}@example.test", "ext-{{n}}"),
        status: 201,
        save: { uid: "id" },
      },
      {
        name: "capitalised ops with sub-attribute, filter and extension paths",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: {
          schemas: [PATCH],
          Operations: [
            { op: "Replace", path: "displayName", value: "Entra Renamed" },
            { op: "Replace", path: "name.givenName", value: "Renamed" },
            {
              op: "Replace",
              path: 'emails[type eq "work"].value',
              value: "work-{{n}}@example.test",
            },
            { op: "Add", path: `${ENT}:department`, value: "Tax" },
            { op: "Add", path: 'phoneNumbers[type eq "mobile"].value', value: "+61 400 000 000" },
          ],
        },
        status: 200,
        match: {
          displayName: "Entra Renamed",
          "name.givenName": "Renamed",
          "emails.0.value": "work-{{n}}@example.test",
          "phoneNumbers.0.type": "mobile",
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User.department": "Tax",
          userName: "entra-{{n}}@example.test",
        },
      },
      {
        name: "Remove a sub-attribute and an extension attribute",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: {
          schemas: [PATCH],
          Operations: [
            { op: "Remove", path: "title" },
            { op: "Remove", path: `${ENT}:employeeNumber` },
          ],
        },
        status: 200,
        match: { title: { $absent: true } },
      },
      {
        name: "path-less Replace with dotted keys",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: {
          schemas: [PATCH],
          Operations: [
            { op: "Replace", value: { "name.familyName": "Surname", title: "Counsel" } },
          ],
        },
        status: 200,
        match: { "name.familyName": "Surname", title: "Counsel" },
      },
    ],
  },
  {
    name: "Soft delete through active",
    source: 'Entra provisioning: disabled users are sent active="False"; hard delete is DELETE',
    settings: { scim_mass_delete_percent: 100 },
    steps: [
      {
        name: "create",
        method: "POST",
        path: "/Users",
        body: entraUser("entra-{{n}}@example.test", "ext-{{n}}"),
        status: 201,
        save: { uid: "id" },
      },
      {
        name: "active as the string False",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] },
        status: 200,
        match: { active: false },
      },
      {
        name: "active as the string True brings them back",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "True" }] },
        status: 200,
        match: { active: true },
      },
      {
        name: "path-less active as a string",
        method: "PATCH",
        path: "/Users/{{uid}}",
        body: { schemas: [PATCH], Operations: [{ op: "Replace", value: { active: "False" } }] },
        status: 200,
        match: { active: false },
      },
      { name: "hard delete", method: "DELETE", path: "/Users/{{uid}}", status: 204 },
      { name: "then 404", method: "GET", path: "/Users/{{uid}}", status: 404 },
    ],
  },
  {
    name: "Group sync: members add and remove",
    source: "Entra provisioning: group objects, member Add/Remove, excludedAttributes=members",
    steps: [
      {
        name: "u1",
        method: "POST",
        path: "/Users",
        body: entraUser("e1-{{n}}@example.test", "x1-{{n}}"),
        status: 201,
        save: { u1: "id" },
      },
      {
        name: "u2",
        method: "POST",
        path: "/Users",
        body: entraUser("e2-{{n}}@example.test", "x2-{{n}}"),
        status: 201,
        save: { u2: "id" },
      },
      {
        name: "create group with externalId and members",
        method: "POST",
        path: "/Groups",
        body: {
          schemas: [GROUP],
          externalId: "grp-{{n}}",
          displayName: "Entra Group {{n}}",
          members: [{ value: "{{u1}}" }],
        },
        status: 201,
        save: { gid: "id" },
        match: { externalId: "grp-{{n}}", "members.0.value": "{{u1}}" },
      },
      {
        name: "lookup with excludedAttributes=members",
        method: "GET",
        path: "/Groups",
        query: { excludedAttributes: "members", filter: 'displayName eq "Entra Group {{n}}"' },
        status: 200,
        match: { totalResults: 1, "Resources.0.members": { $absent: true } },
      },
      {
        name: "Add a member",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "Add", path: "members", value: [{ value: "{{u2}}" }] }],
        },
        status: 200,
        match: { members: { $len: 2 } },
      },
      {
        name: "Remove a member, named in the value",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "Remove", path: "members", value: [{ value: "{{u1}}" }] }],
        },
        status: 200,
        match: { members: { $len: 1 }, "members.0.value": "{{u2}}" },
      },
      {
        name: "Remove with no value removes all members",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: { schemas: [PATCH], Operations: [{ op: "Remove", path: "members" }] },
        status: 200,
        match: { members: { $len: 0 } },
      },
      {
        name: "Replace the display name",
        method: "PATCH",
        path: "/Groups/{{gid}}",
        body: {
          schemas: [PATCH],
          Operations: [{ op: "Replace", path: "displayName", value: "Entra Renamed {{n}}" }],
        },
        status: 200,
        match: { displayName: "Entra Renamed {{n}}" },
      },
    ],
  },
];
