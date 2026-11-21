import type {
  MemberInput,
  ResourceInput,
  SpaceContext,
  SpaceContextInput,
  SpaceCreate,
  SpaceCustomisation,
  SpaceLevel,
  SpacePatch,
  SpaceResourceType,
  SpaceRole,
  SpaceSkipped,
} from "@legallabs/contracts";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import {
  createKit,
  type Db,
  isId,
  type Kit,
  matterDisplay,
  needAdmin,
  needMember,
  noNotifications,
  one,
  type ResourceCatalog,
  type ResourceInfo,
  type Result,
  refusal,
  roleOf,
  type SpaceNotifier,
} from "./kit.js";
import { applyTemplate, loadTemplate } from "./templates.js";

type InfoRow = { name: string; owner_id: string | null; matter_id: string | null; full: boolean };
const info = (row: InfoRow | null): ResourceInfo | null =>
  row ? { name: row.name, ownerId: row.owner_id, matterId: row.matter_id, full: row.full } : null;

/** What exists today. Agents, workflows and scans register themselves when their epics land. */
const defaultCatalog: ResourceCatalog = {
  vault: async (db, id) =>
    info(
      await one<InfoRow>(
        db,
        `select name, owner_id, matter_id,
                (owner_id = core.current_user_id() or work.has_direct_access('vault', id, 'full')) as full
           from content.vault where id = $1 and deleted_at is null`,
        [id],
      ),
    ),
  // Review tables, playbooks and threads are owner-only until their policies honour Space grants.
};

/** Resources a person runs rather than edits. */
const RUNNABLE = new Set<SpaceResourceType>(["agent", "workflow", "playbook", "scan"]);
const RANK = { view: 1, run: 2, edit: 3, full: 4 } as const;

const levelAllowed = (type: SpaceResourceType, level: SpaceLevel) =>
  RUNNABLE.has(type) || level !== "run";

export interface SpaceView {
  id: string;
  name: string;
  kind: "internal" | "external";
  matter: { id: string; display: string } | null;
  context: SpaceContext;
  customization: SpaceCustomisation;
  myRole: SpaceRole;
  templateId: string | null;
  /** Always empty until external Spaces arrive. */
  externalParties: string[];
  counts: { members: number; resources: number; openTasks: number };
  createdBy: string;
  createdAt: string;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  kind: "internal" | "external";
  matterId: string | null;
  /** The caller can reach the matter but is not in the Space. */
  locked: boolean;
}

export interface MemberView {
  id: string;
  principalType: "user" | "group";
  principalId: string;
  label: string | null;
  role: SpaceRole;
  joinedAt: string;
}

export interface ResourceView {
  id: string;
  resourceType: SpaceResourceType;
  resourceId: string;
  name: string | null;
  access: SpaceLevel;
  externalParties: string[];
  grantedBy: string;
  createdAt: string;
}

export interface ActivityView {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  objectType: string | null;
  objectId: string | null;
  details: Record<string, unknown>;
  at: string;
}

export interface AccessRequestView {
  id: string;
  userId: string;
  userName: string;
  message: string;
  status: "pending" | "accepted" | "denied";
  createdAt: string;
}

export interface Spaces {
  list(p: Principal, q: { q?: string; memberOnly?: boolean }): Promise<SpaceView[]>;
  directory(p: Principal, q?: string): Promise<DirectoryEntry[]>;
  /** What picking a matter or a Space in the "Work in" selector means for a thread. */
  workIn(
    p: Principal,
    pick: { matterId: string } | { spaceId: string },
  ): Promise<Result<{ matterId: string | null; spaceId: string | null; locked: boolean }>>;
  create(
    p: Principal,
    input: SpaceCreate,
    client: Client,
  ): Promise<Result<{ space: SpaceView; skipped: SpaceSkipped[] }>>;
  get(p: Principal, id: string): Promise<SpaceView | null>;
  patch(p: Principal, id: string, patch: SpacePatch, client: Client): Promise<Result<SpaceView>>;
  remove(p: Principal, id: string, client: Client): Promise<Result<null>>;
  setContext(
    p: Principal,
    id: string,
    input: SpaceContextInput,
    client: Client,
  ): Promise<Result<SpaceView>>;
  attachMatter(
    p: Principal,
    id: string,
    matterId: string,
    client: Client,
  ): Promise<Result<SpaceView>>;

  members(p: Principal, id: string): Promise<MemberView[] | null>;
  addMember(
    p: Principal,
    id: string,
    input: MemberInput,
    client: Client,
  ): Promise<Result<MemberView>>;
  setRole(
    p: Principal,
    id: string,
    memberId: string,
    role: SpaceRole,
    client: Client,
  ): Promise<Result<MemberView>>;
  removeMember(p: Principal, id: string, memberId: string, client: Client): Promise<Result<null>>;

  resources(p: Principal, id: string): Promise<ResourceView[] | null>;
  addResource(
    p: Principal,
    id: string,
    input: ResourceInput,
    client: Client,
  ): Promise<Result<ResourceView>>;
  setResourceLevel(
    p: Principal,
    id: string,
    resourceId: string,
    access: SpaceLevel,
    client: Client,
  ): Promise<Result<ResourceView>>;
  removeResource(
    p: Principal,
    id: string,
    resourceId: string,
    client: Client,
  ): Promise<Result<null>>;

  activity(
    p: Principal,
    id: string,
    q: { type?: string; actorId?: string; before?: string; limit?: number },
  ): Promise<{ items: ActivityView[]; next: string | null } | null>;

  requestAccess(
    p: Principal,
    id: string,
    message: string,
    client: Client,
  ): Promise<Result<AccessRequestView>>;
  requests(p: Principal, id: string): Promise<AccessRequestView[] | null>;
  decideRequest(
    p: Principal,
    id: string,
    requestId: string,
    decision: { accept: true } | { accept: false; reason: string },
    client: Client,
  ): Promise<Result<AccessRequestView>>;
}

interface SpaceRow {
  id: string;
  name: string;
  kind: "internal" | "external";
  matter_id: string | null;
  context: SpaceContext;
  customization: SpaceCustomisation;
  template_id: string | null;
  created_by: string;
  created_at: Date;
  my_role: SpaceRole;
  client_id: string | null;
  client_name: string | null;
  matter_number: string | null;
  members: number;
  resources: number;
  open_tasks: number;
}

const SPACE_SQL = `
  select s.id, s.name, s.kind, s.matter_id, s.context, s.customization, s.template_id,
         s.created_by, s.created_at, work.space_role(s.id) as my_role,
         m.client_id, m.client_name, m.matter_number,
         (select count(*) from work.space_member x where x.space_id = s.id)::int as members,
         (select count(*) from work.space_resource x where x.space_id = s.id)::int as resources,
         (select count(*) from work.task t
           where t.space_id = s.id and t.status in ('todo', 'in_progress'))::int as open_tasks
    from work.space s left join core.matter m on m.id = s.matter_id`;

const spaceView = (r: SpaceRow): SpaceView => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  matter:
    r.matter_id && r.client_id && r.client_name && r.matter_number
      ? {
          id: r.matter_id,
          display:
            matterDisplay({
              client_id: r.client_id,
              client_name: r.client_name,
              matter_number: r.matter_number,
            }) ?? "",
        }
      : null,
  context: r.context,
  customization: r.customization,
  myRole: r.my_role,
  templateId: r.template_id,
  externalParties: [],
  counts: { members: r.members, resources: r.resources, openTasks: r.open_tasks },
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

interface MemberRow {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  role: SpaceRole;
  joined_at: Date;
  label: string | null;
}

const MEMBER_SQL = `
  select m.id, m.principal_type, m.principal_id, m.role, m.joined_at,
         case m.principal_type when 'user' then coalesce(nullif(u.name, ''), u.email) else g.name end as label
    from work.space_member m
    left join core."user" u on m.principal_type = 'user' and u.id = m.principal_id
    left join core."group" g on m.principal_type = 'group' and g.id = m.principal_id`;

const memberView = (r: MemberRow): MemberView => ({
  id: r.id,
  principalType: r.principal_type,
  principalId: r.principal_id,
  label: r.label,
  role: r.role,
  joinedAt: r.joined_at.toISOString(),
});

interface ResourceRow {
  id: string;
  resource_type: SpaceResourceType;
  resource_id: string;
  access: SpaceLevel;
  granted_by: string;
  created_at: Date;
}

const RESOURCE_SQL =
  "select id, resource_type, resource_id, access, granted_by, created_at from work.space_resource";

const REQUEST_SQL = `
  select r.id, r.user_id, coalesce(nullif(u.name, ''), u.email) as user_name, r.message,
         r.status, r.created_at
    from work.space_access_request r join core."user" u on u.id = r.user_id`;

interface RequestRow {
  id: string;
  user_id: string;
  user_name: string;
  message: string;
  status: AccessRequestView["status"];
  created_at: Date;
}

const requestView = (r: RequestRow): AccessRequestView => ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  message: r.message,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});

export interface SpacesOptions {
  notifier?: SpaceNotifier;
  catalog?: ResourceCatalog;
  /** The matters epic's workspace option; until then a Space and its resources must share a matter. */
  allowMatterMismatch?: (db: Db) => Promise<boolean>;
}

type SpacesModule = Spaces & { kit: Kit; catalog: ResourceCatalog };

export function createSpaces(pool: pg.Pool, options: SpacesOptions = {}): SpacesModule {
  const kit = createKit(pool, options.notifier ?? noNotifications);
  const catalog: ResourceCatalog = { ...defaultCatalog, ...options.catalog };
  const allowMismatch = options.allowMatterMismatch ?? (async () => false);

  const view = async (db: Db, id: string) => {
    const row = await one<SpaceRow>(db, `${SPACE_SQL} where s.id = $1`, [id]);
    return row ? spaceView(row) : null;
  };
  const mustView = async (db: Db, id: string) => {
    const space = await view(db, id);
    if (!space) throw refusal("NOT_FOUND");
    return space;
  };
  const memberRow = async (db: Db, id: string) => {
    const row = await one<MemberRow>(db, `${MEMBER_SQL} where m.id = $1`, [id]);
    if (!row) throw refusal("NOT_FOUND");
    return memberView(row);
  };

  const resourceView = async (db: Db, row: ResourceRow): Promise<ResourceView> => {
    const lookup = catalog[row.resource_type];
    const found = lookup ? await lookup(db, row.resource_id) : null;
    return {
      id: row.id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      name: found?.name ?? null,
      access: row.access,
      externalParties: [],
      grantedBy: row.granted_by,
      createdAt: row.created_at.toISOString(),
    };
  };

  /** A Space always keeps an admin: the last one can't be removed or demoted. */
  const keepAnAdmin = async (db: Db, spaceId: string, memberId: string) => {
    const others = await one<{ n: number }>(
      db,
      "select count(*)::int as n from work.space_member where space_id = $1 and role = 'admin' and id <> $2",
      [spaceId, memberId],
    );
    if (!others || others.n === 0) throw refusal("LAST_ADMIN");
  };

  const find = async (db: Db, spaceId: string, resourceId: string) => {
    const row = isId(resourceId)
      ? await one<ResourceRow>(db, `${RESOURCE_SQL} where id = $1 and space_id = $2`, [
          resourceId,
          spaceId,
        ])
      : null;
    if (!row) throw refusal("NOT_FOUND");
    return row;
  };

  return {
    kit,
    catalog,

    async list(p, q) {
      const r = await kit.attempt(p, async (db) => {
        const params: unknown[] = [];
        const where: string[] = [];
        if (q.q) {
          params.push(`%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
          where.push(`s.name ilike $${params.length}`);
        }
        if (q.memberOnly) where.push("work.space_membership(s.id) is not null");
        const rows = await db.query<SpaceRow>(
          `${SPACE_SQL} ${where.length ? `where ${where.join(" and ")}` : ""} order by s.name limit 200`,
          params,
        );
        return rows.rows.map(spaceView);
      });
      return r.ok ? r.value : [];
    },

    async directory(p, q) {
      const r = await kit.attempt(p, async (db) =>
        (
          await db.query<{
            id: string;
            name: string;
            kind: "internal" | "external";
            matter_id: string | null;
            locked: boolean;
          }>("select * from work.space_directory($1)", [q ?? null])
        ).rows.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          matterId: d.matter_id,
          locked: d.locked,
        })),
      );
      return r.ok ? r.value : [];
    },

    async workIn(p, pick) {
      return kit.attempt(p, async (db) => {
        if ("matterId" in pick) {
          // A walled matter is absent, so picking it by id finds nothing.
          const matter = isId(pick.matterId)
            ? await one(db, "select id from core.matter where id = $1", [pick.matterId])
            : null;
          if (!matter) throw refusal("MATTER_NOT_FOUND");
          const space = await one<{ id: string; locked: boolean }>(
            db,
            "select id, locked from work.space_directory() where matter_id = $1",
            [pick.matterId],
          );
          return {
            matterId: pick.matterId,
            // A locked Space proceeds with the matter only: no Space id, no context.
            spaceId: space && !space.locked ? space.id : null,
            locked: space?.locked ?? false,
          };
        }
        const space = isId(pick.spaceId)
          ? await one<{ id: string; matter_id: string | null; locked: boolean }>(
              db,
              "select id, matter_id, locked from work.space_directory() where id = $1",
              [pick.spaceId],
            )
          : null;
        if (!space) throw refusal("NOT_FOUND");
        return {
          matterId: space.matter_id,
          spaceId: space.locked ? null : space.id,
          locked: space.locked,
        };
      });
    },

    async create(p, input, client) {
      return kit.attempt(p, async (db) => {
        // Checked before anything is written.
        if (input.kind === "external") throw refusal("EXTERNAL_NOT_ENABLED");
        if (input.matter_id) {
          const matter = isId(input.matter_id)
            ? await one(db, "select id from core.matter where id = $1", [input.matter_id])
            : null;
          if (!matter) throw refusal("MATTER_NOT_FOUND");
        }
        const template = input.template_id ? await loadTemplate(db, input.template_id) : null;
        if (input.template_id && !template) throw refusal("NOT_FOUND");
        const made = await one<{ id: string }>(db, "select core.uuid7() as id", []);
        const id = made?.id ?? "";
        // No `returning`: the creator is a member only once the insert has finished.
        await db.query(
          `insert into work.space (id, workspace_id, name, kind, matter_id, template_id, created_by)
           values ($1, $2, $3, 'internal', $4, $5, $6)`,
          [
            id,
            p.workspaceId,
            input.name,
            input.matter_id ?? null,
            input.template_id ?? null,
            p.userId,
          ],
        );
        let skipped: SpaceSkipped[] = [];
        if (template) {
          skipped = await applyTemplate(db, kit, p, id, template.definition, catalog);
          await kit.audit(db, p, client, "space.template_applied", "space", id, {
            template_id: template.id,
            skipped: skipped.length,
          });
        }
        await kit.audit(db, p, client, "space.created", "space", id, {
          kind: "internal",
          matter_id: input.matter_id ?? null,
          template_id: input.template_id ?? null,
        });
        await kit.activity(db, p, id, "space.created", { type: "space", id });
        return { space: await mustView(db, id), skipped };
      });
    },

    async get(p, id) {
      if (!isId(id)) return null;
      const r = await kit.attempt(p, (db) => view(db, id));
      return r.ok ? r.value : null;
    },

    async patch(p, id, patch, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        await db.query(
          `update work.space
              set name = coalesce($2, name),
                  customization = customization || coalesce($3::jsonb, '{}'::jsonb)
            where id = $1`,
          [
            id,
            patch.name ?? null,
            patch.customization ? JSON.stringify(patch.customization) : null,
          ],
        );
        await kit.audit(db, p, client, "space.updated", "space", id, {
          fields: Object.keys(patch),
        });
        return mustView(db, id);
      });
    },

    async remove(p, id, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        // Allowed to its creator, or to someone who manages every Space; the function checks.
        await db.query("select work.delete_space($1)", [id]);
        await kit.audit(db, p, client, "space.deleted", "space", id);
        return null;
      });
    },

    async setContext(p, id, input, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        const row = await one<{ context: SpaceContext }>(
          db,
          "select context from work.space where id = $1",
          [id],
        );
        if (!row) throw refusal("NOT_FOUND");
        const next: SpaceContext = { ...input, version: (row.context.version ?? 0) + 1 };
        await db.query("update work.space set context = $2 where id = $1", [
          id,
          JSON.stringify(next),
        ]);
        await kit.audit(db, p, client, "space.context_updated", "space", id, {
          version: next.version,
        });
        await kit.activity(db, p, id, "context.updated", { type: "space", id });
        return mustView(db, id);
      });
    },

    async attachMatter(p, id, matterId, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        const row = await one<{ matter_id: string | null }>(
          db,
          "select matter_id from work.space where id = $1",
          [id],
        );
        // Settable once.
        if (row?.matter_id) throw refusal("INVALID");
        const matter = isId(matterId)
          ? await one(db, "select id from core.matter where id = $1", [matterId])
          : null;
        if (!matter) throw refusal("MATTER_NOT_FOUND");
        await db.query("update work.space set matter_id = $2 where id = $1", [id, matterId]);
        await kit.audit(db, p, client, "space.matter_attached", "space", id, {
          matter_id: matterId,
        });
        await kit.activity(db, p, id, "matter.attached", { type: "space", id });
        return mustView(db, id);
      });
    },

    async members(p, id) {
      const r = await kit.attempt(p, async (db) => {
        if (!(await roleOf(db, id))) return null;
        const rows = await db.query<MemberRow>(
          `${MEMBER_SQL} where m.space_id = $1 order by m.role, m.joined_at`,
          [id],
        );
        return rows.rows.map(memberView);
      });
      return r.ok ? r.value : null;
    },

    async addMember(p, id, input, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        const added = await one<{ id: string }>(
          db,
          `insert into work.space_member
             (workspace_id, space_id, principal_type, principal_id, role, invited_by)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [p.workspaceId, id, input.principal_type, input.principal_id, input.role, p.userId],
        );
        await kit.audit(db, p, client, "space.member_added", "space", id, {
          principal_type: input.principal_type,
          principal_id: input.principal_id,
          role: input.role,
        });
        await kit.activity(db, p, id, "member.added", {
          type: input.principal_type,
          id: input.principal_id,
        });
        return memberRow(db, added?.id ?? "");
      });
    },

    async setRole(p, id, memberId, role, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        const target = isId(memberId)
          ? await one<{ role: SpaceRole }>(
              db,
              "select role from work.space_member where id = $1 and space_id = $2",
              [memberId, id],
            )
          : null;
        if (!target) throw refusal("NOT_FOUND");
        if (target.role === "admin" && role !== "admin") await keepAnAdmin(db, id, memberId);
        await db.query("update work.space_member set role = $2 where id = $1", [memberId, role]);
        await kit.audit(db, p, client, "space.member_role_changed", "space", id, {
          member_id: memberId,
          from: target.role,
          to: role,
        });
        await kit.activity(db, p, id, "member.role_changed", null, { role });
        return memberRow(db, memberId);
      });
    },

    async removeMember(p, id, memberId, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        const target = isId(memberId)
          ? await one<{ role: SpaceRole; principal_type: string; principal_id: string }>(
              db,
              "select role, principal_type, principal_id from work.space_member where id = $1 and space_id = $2",
              [memberId, id],
            )
          : null;
        if (!target) throw refusal("NOT_FOUND");
        if (target.role === "admin") await keepAnAdmin(db, id, memberId);
        await db.query("delete from work.space_member where id = $1", [memberId]);
        await kit.audit(db, p, client, "space.member_removed", "space", id, {
          principal_type: target.principal_type,
          principal_id: target.principal_id,
        });
        await kit.activity(db, p, id, "member.removed", {
          type: target.principal_type,
          id: target.principal_id,
        });
        return null;
      });
    },

    async resources(p, id) {
      const r = await kit.attempt(p, async (db) => {
        if (!(await roleOf(db, id))) return null;
        const rows = await db.query<ResourceRow>(
          `${RESOURCE_SQL} where space_id = $1 order by created_at, id`,
          [id],
        );
        return Promise.all(rows.rows.map((row) => resourceView(db, row)));
      });
      return r.ok ? r.value : null;
    },

    async addResource(p, id, input, client) {
      return kit.attempt(p, async (db) => {
        await needMember(db, id);
        const lookup = catalog[input.resource_type];
        if (!lookup) throw refusal("RESOURCE_UNSUPPORTED");
        if (!levelAllowed(input.resource_type, input.access)) throw refusal("INVALID");
        // Hidden (walled, deleted or never there) all look the same: nothing found.
        const found = isId(input.resource_id) ? await lookup(db, input.resource_id) : null;
        if (!found) throw refusal("RESOURCE_NOT_FOUND");
        if (!found.full) throw refusal("FORBIDDEN");
        const space = await one<{ matter_id: string | null }>(
          db,
          "select matter_id from work.space where id = $1",
          [id],
        );
        if (
          space?.matter_id &&
          found.matterId &&
          space.matter_id !== found.matterId &&
          !(await allowMismatch(db))
        ) {
          throw refusal("MATTER_MISMATCH");
        }
        const existing = await one<{ id: string; access: SpaceLevel }>(
          db,
          "select id, access from work.space_resource where space_id = $1 and resource_type = $2 and resource_id = $3",
          [id, input.resource_type, input.resource_id],
        );
        let rowId = existing?.id ?? "";
        if (existing) {
          if (existing.access !== input.access) {
            await db.query("update work.space_resource set access = $2 where id = $1", [
              rowId,
              input.access,
            ]);
            await kit.audit(db, p, client, "space.resource_level_changed", "space", id, {
              resource_type: input.resource_type,
              resource_id: input.resource_id,
              access: input.access,
            });
          }
        } else {
          const added = await one<{ id: string }>(
            db,
            `insert into work.space_resource
               (workspace_id, space_id, resource_type, resource_id, access, granted_by)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [p.workspaceId, id, input.resource_type, input.resource_id, input.access, p.userId],
          );
          rowId = added?.id ?? "";
          await kit.audit(db, p, client, "space.resource_added", "space", id, {
            resource_type: input.resource_type,
            resource_id: input.resource_id,
            access: input.access,
          });
          await kit.activity(
            db,
            p,
            id,
            "resource.added",
            { type: input.resource_type, id: input.resource_id },
            { access: input.access },
          );
        }
        return resourceView(db, await find(db, id, rowId));
      });
    },

    async setResourceLevel(p, id, resourceId, access, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, id);
        const row = await find(db, id, resourceId);
        if (!levelAllowed(row.resource_type, access)) throw refusal("INVALID");
        // Raising a level hands out access the caller must hold on their own, not through a Space.
        if (RANK[access] > RANK[row.access]) {
          const lookup = catalog[row.resource_type];
          const found = lookup ? await lookup(db, row.resource_id) : null;
          if (!found?.full) throw refusal("FORBIDDEN");
        }
        await db.query("update work.space_resource set access = $2 where id = $1", [
          resourceId,
          access,
        ]);
        await kit.audit(db, p, client, "space.resource_level_changed", "space", id, {
          resource_type: row.resource_type,
          resource_id: row.resource_id,
          from: row.access,
          to: access,
        });
        await kit.activity(
          db,
          p,
          id,
          "resource.level_changed",
          { type: row.resource_type, id: row.resource_id },
          { access },
        );
        return resourceView(db, { ...row, access });
      });
    },

    async removeResource(p, id, resourceId, client) {
      return kit.attempt(p, async (db) => {
        await needMember(db, id);
        const row = await find(db, id, resourceId);
        // The policy lets an admin or the person who shared it remove it; anyone else matches no row.
        const removed = await db.query("delete from work.space_resource where id = $1", [
          resourceId,
        ]);
        if (removed.rowCount === 0) throw refusal("FORBIDDEN");
        await kit.audit(db, p, client, "space.resource_removed", "space", id, {
          resource_type: row.resource_type,
          resource_id: row.resource_id,
        });
        await kit.activity(db, p, id, "resource.removed", {
          type: row.resource_type,
          id: row.resource_id,
        });
        return null;
      });
    },

    async activity(p, id, q) {
      const r = await kit.attempt(p, async (db) => {
        if (!(await roleOf(db, id))) return null;
        const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
        const params: unknown[] = [id];
        const where = ["a.space_id = $1"];
        if (q.type) {
          params.push(q.type);
          where.push(`a.type = $${params.length}`);
        }
        if (q.actorId && isId(q.actorId)) {
          params.push(q.actorId);
          where.push(`a.actor_id = $${params.length}`);
        }
        if (q.before && isId(q.before)) {
          params.push(q.before);
          where.push(`a.id < $${params.length}`);
        }
        params.push(limit + 1);
        const rows = await db.query<{
          id: string;
          type: string;
          actor_type: string;
          actor_id: string | null;
          actor_name: string | null;
          object_type: string | null;
          object_id: string | null;
          details: Record<string, unknown>;
          at: Date;
        }>(
          `select a.id, a.type, a.actor_type, a.actor_id,
                  coalesce(nullif(u.name, ''), u.email) as actor_name,
                  a.object_type, a.object_id, a.details, a.at
             from work.space_activity a left join core."user" u on u.id = a.actor_id
            where ${where.join(" and ")} order by a.id desc limit $${params.length}`,
          params,
        );
        const items = rows.rows.slice(0, limit).map((a) => ({
          id: a.id,
          type: a.type,
          actorType: a.actor_type,
          actorId: a.actor_id,
          actorName: a.actor_name,
          objectType: a.object_type,
          objectId: a.object_id,
          details: a.details,
          at: a.at.toISOString(),
        }));
        return { items, next: rows.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
      });
      return r.ok ? r.value : null;
    },

    async requestAccess(p, id, message, client) {
      return kit.attempt(p, async (db, notify) => {
        // A Space whose matter walls the caller is not in the directory, so it looks absent.
        const listed = isId(id)
          ? await one<{ locked: boolean; name: string }>(
              db,
              "select locked, name from work.space_directory() where id = $1",
              [id],
            )
          : null;
        if (!listed) throw refusal("NOT_FOUND");
        if (!listed.locked) throw refusal("ALREADY_MEMBER");
        const added = await one<{ id: string }>(
          db,
          `insert into work.space_access_request (workspace_id, space_id, user_id, message)
           values ($1, $2, $3, $4) returning id`,
          [p.workspaceId, id, p.userId, message],
        );
        await kit.audit(db, p, client, "space.access_requested", "space", id);
        const admins = await db.query<{ id: string }>("select work.space_admin_ids($1) as id", [
          id,
        ]);
        notify({
          kind: "space.access_requested",
          userIds: admins.rows.map((a) => a.id),
          spaceId: id,
          title: listed.name,
        });
        const row = await one<RequestRow>(db, `${REQUEST_SQL} where r.id = $1`, [added?.id]);
        if (!row) throw refusal("NOT_FOUND");
        return requestView(row);
      });
    },

    async requests(p, id) {
      const r = await kit.attempt(p, async (db) => {
        if ((await roleOf(db, id)) !== "admin") return null;
        const rows = await db.query<RequestRow>(
          `${REQUEST_SQL} where r.space_id = $1 and r.status = 'pending' order by r.created_at`,
          [id],
        );
        return rows.rows.map(requestView);
      });
      return r.ok ? r.value : null;
    },

    async decideRequest(p, id, requestId, decision, client) {
      return kit.attempt(p, async (db, notify) => {
        await needAdmin(db, id);
        const row = isId(requestId)
          ? await one<RequestRow>(db, `${REQUEST_SQL} where r.id = $1 and r.space_id = $2`, [
              requestId,
              id,
            ])
          : null;
        if (!row) throw refusal("NOT_FOUND");
        if (row.status !== "pending") throw refusal("ALREADY_DECIDED");
        if (decision.accept) {
          await db.query(
            `insert into work.space_member
               (workspace_id, space_id, principal_type, principal_id, role, invited_by)
             values ($1, $2, 'user', $3, 'collaborator', $4) on conflict do nothing`,
            [p.workspaceId, id, row.user_id, p.userId],
          );
        }
        await db.query(
          `update work.space_access_request
              set status = $2, decided_by = $3, decided_at = now(), reason = $4 where id = $1`,
          [
            requestId,
            decision.accept ? "accepted" : "denied",
            p.userId,
            decision.accept ? null : decision.reason,
          ],
        );
        await kit.audit(
          db,
          p,
          client,
          decision.accept ? "space.access_accepted" : "space.access_denied",
          "space",
          id,
          { user_id: row.user_id },
        );
        const spaceName = await one<{ name: string }>(
          db,
          "select name from work.space where id = $1",
          [id],
        );
        notify({
          kind: "space.access_decided",
          userIds: [row.user_id],
          spaceId: id,
          title: spaceName?.name ?? "a Space",
          accepted: decision.accept,
        });
        const next = await one<RequestRow>(db, `${REQUEST_SQL} where r.id = $1`, [requestId]);
        if (!next) throw refusal("NOT_FOUND");
        return requestView(next);
      });
    },
  };
}
