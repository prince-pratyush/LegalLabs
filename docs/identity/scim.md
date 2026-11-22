# SCIM 2.0 provisioning

**Status: UNVERIFIED against real Okta or Microsoft Entra ID.** The server follows RFC 7643 and
RFC 7644. The vendor conformance suite (`apps/api/src/scim/conformance/`) uses fixtures written
from the vendors' public documentation, because no real tenant was available. A green run means
"matches our reading of the docs", not vendor certification. An RFC self-check
(`rfc7644.test.ts`) runs against `createApp` over HTTP.

## Turning it on

1. An admin with `admin.config` enables SCIM: `PUT /api/v1/admin/scim {"enabled": true}`. This
   writes `core.workspace.settings.scim_enabled = true`, which the OIDC sign-in reads to refuse
   just-in-time account creation. An optional `ip_allowlist` (addresses or CIDR ranges) limits
   which callers may use the token.
2. An admin with `admin.users` issues a token: `POST /api/v1/admin/scim/tokens`. The secret is
   shown once; only its SHA-256 is stored. Tokens expire (default 180 days, at most 365) and can
   be revoked with `DELETE /api/v1/admin/scim/tokens/:id`.
3. Point the identity provider at `https://<host>/scim/v2` with the token as a bearer token.

The token belongs to a `service` user, carries only the `scim` scope, and works on `/scim/v2`
alone. It cannot sign in, and a person's session does not work on `/scim/v2`.

## Supported

- Discovery: `ServiceProviderConfig`, `ResourceTypes`, `Schemas`.
- `Users` and `Groups`: GET list, GET, POST (201 with `Location`), PUT, PATCH, DELETE.
- Filters: `eq ne co sw ew pr gt ge lt le`, `and or not`, parentheses, value paths such as
  `emails[type eq "work"]`, extension-schema prefixes. Case-insensitive except `id` and
  `externalId`. Single `userName`/`externalId`/`id` equality is answered by the database; other
  filters load the workspace's people and evaluate in memory.
- `startIndex` (1-based) and `count` (default 100, max 200), `sortBy`/`sortOrder`,
  `attributes`/`excludedAttributes`.
- ETag and `If-Match` (412 `invalidVers`), `If-None-Match` on GET (304).
- Errors in the `urn:ietf:params:scim:api:messages:2.0:Error` format with `scimType`:
  `uniqueness`, `invalidFilter`, `invalidPath`, `invalidValue`, `invalidSyntax`, `mutability`,
  `noTarget`, `invalidVers`.
- PATCH `add`, `replace`, `remove` with and without a path, value-filter paths
  (`emails[type eq "work"].value`, `members[value eq "id"]`), extension attributes; all
  operations apply or none do.
- Entra habits: capitalised op names, `"True"`/`"False"` for booleans, path-less objects whose keys
  are paths (dotted keys included), `members` removal by value or, with no value, all members.
- Okta habits: `userName eq` lookup before create, `count=1` probes, PATCH `active:false`, PUT
  full replace, group member add/remove.

Not supported (and advertised as such): Bulk, `/.search`, `/Me`, change password.

## Mapping

| SCIM                                                                                                 | Stored in                                                                  |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `userName`                                                                                           | `core.user.email` (unique per workspace, case-insensitive)                 |
| `displayName`, `name`                                                                                | `core.user.name`                                                           |
| `title`, practice area, profession, country (`urn:legallabs:params:scim:schemas:extension:1.0:User`) | `core.user.profile`                                                        |
| other writable attributes (emails, phones, addresses, enterprise extension)                          | `core.user.profile.scim`, as sent                                          |
| `externalId`                                                                                         | `core.user.scim_external_id`; for groups `core."group".scim_group_id`      |
| `active`                                                                                             | `status` `active` / `deprovisioned`. A `suspended` person stays suspended. |
| group                                                                                                | `core."group"` and `core.group_member`                                     |

SCIM never sets a person's role or permissions. New people have no role. `active` absent from a
PUT leaves the status unchanged. A group's `displayName` is unique per workspace (case-sensitive).

## Deprovisioning

`active=false` or `DELETE` sets status to `deprovisioned` and, in the same transaction, revokes
every session and API token of that person (SEC-012). `DELETE` also hides the person from SCIM
(404) and removes them from groups; the row stays for history. Creating the same `userName`
again reuses the row.

## Mass-delete guard (SEC-013)

If deprovisionings within one hour exceed 10% of the people (and are at least 2), the one that
crosses the line is refused with 403, provisioning enters a paused state, the audit event
`scim.mass_delete_paused` is written and the injected webhook port is called. While paused, all
deletes and deactivations are refused; creates and updates continue. An admin lifts the pause
with `POST /api/v1/admin/scim/resume`. Tunable through workspace settings
`scim_mass_delete_percent` and `scim_mass_delete_min`. The webhook has no real delivery yet
(`noWebhook` by default).

## Group to role mapping

`POST /api/v1/admin/scim/group-roles {group_id, role_id}`. People in a mapped group get its role;
leaving every mapped group takes back a role only a mapping gave them. A mapping to a role with
admin rights stays `pending` until a different admin confirms it
(`POST .../group-roles/:id/confirm`); the requester cannot confirm their own.

## Audit

`scim.user_created`, `scim.user_updated`, `scim.user_deactivated`, `scim.group_synced`,
`scim.mass_delete_paused` (actor type `service`), plus `settings.changed`, `token.created`,
`token.revoked`, `token.used_denied` and `permission.granted|revoked` for admin actions.
Details hold ids and counts only.

## Database

Migrations 0105-0108. SCIM runs as the `legallabs_app` role under a service user; RLS policies
and `security definer` functions in the `scim` schema (`is_principal`, `authenticate`,
`revoke_user_access`, `record_deprovision`, group-role functions) bound what it can do.

## Known gaps

- `meta.location` and `Location` use the request's origin; behind a proxy, forward the host.
- The IP allow-list uses the socket address, not forwarded headers.
- No vendor has validated this server yet.
