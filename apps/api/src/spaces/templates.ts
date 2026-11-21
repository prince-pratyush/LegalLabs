import {
  type SpaceLevel,
  type SpaceSkipped,
  SpaceTemplateDefinition,
  type TemplateInput,
} from "@legallabs/contracts";
import type { Client, Principal } from "../auth/auth.js";
import {
  type Db,
  isId,
  type Kit,
  needAdmin,
  needMember,
  one,
  type ResourceCatalog,
  type Result,
  refusal,
} from "./kit.js";

export interface TemplateView {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  /** Only the owner sees how it is shared. */
  sharedTo: { workspace: boolean; groupIds: string[] };
  definition: SpaceTemplateDefinition;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  shared_to: { workspace: boolean; group_ids: string[] };
  definition: unknown;
  created_at: Date;
  updated_at: Date;
}

const TEMPLATE_SQL =
  "select id, name, description, owner_id, shared_to, definition, created_at, updated_at from work.space_template";

/** Reads a stored definition; one that no longer parses is treated as absent, never half-applied. */
const parse = (value: unknown) => {
  const parsed = SpaceTemplateDefinition.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** A template the caller may use, or null. Row-level security decides who may see it. */
export async function loadTemplate(db: Db, id: string) {
  if (!isId(id)) return null;
  const row = await one<TemplateRow>(db, `${TEMPLATE_SQL} where id = $1`, [id]);
  const definition = row ? parse(row.definition) : null;
  return row && definition ? { id: row.id, definition } : null;
}

const grant = (
  db: Db,
  p: Principal,
  spaceId: string,
  type: "agent" | "workflow" | "vault",
  id: string,
  level: SpaceLevel,
) =>
  db.query(
    `insert into work.space_resource
       (workspace_id, space_id, resource_type, resource_id, access, granted_by)
     values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
    [p.workspaceId, spaceId, type, id, level, p.userId],
  );

/**
 * Adds a template's phases, tasks and grants to a Space. Additive: nothing is removed. Tasks come
 * unassigned and undated. A reference the caller can't use is skipped and reported, never dropped
 * silently.
 */
export async function applyTemplate(
  db: Db,
  kit: Kit,
  p: Principal,
  spaceId: string,
  definition: SpaceTemplateDefinition,
  catalog: ResourceCatalog,
): Promise<SpaceSkipped[]> {
  const skipped: SpaceSkipped[] = [];
  const start = await one<{ n: number }>(
    db,
    "select coalesce(max(ordinal), 0)::int as n from work.phase where space_id = $1",
    [spaceId],
  );
  let ordinal = start?.n ?? 0;
  for (const phase of definition.phases) {
    ordinal += 1;
    const made = await one<{ id: string }>(
      db,
      `insert into work.phase (workspace_id, space_id, ordinal, name) values ($1, $2, $3, $4) returning id`,
      [p.workspaceId, spaceId, ordinal, phase.name],
    );
    for (const task of phase.tasks) {
      await db.query(
        `insert into work.task (workspace_id, space_id, phase_id, name, description_md, gate, linked, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          p.workspaceId,
          spaceId,
          made?.id,
          task.name,
          task.description ?? "",
          task.gate,
          JSON.stringify({
            resources: task.agent_id
              ? [{ resource_type: "agent", resource_id: task.agent_id }]
              : [],
            outputs: [],
          }),
          p.userId,
        ],
      );
    }
  }

  for (const [type, items] of [
    ["agent", definition.agents],
    ["workflow", definition.workflows],
  ] as const) {
    for (const item of items) {
      const found = await catalog[type]?.(db, item.id);
      if (!found) {
        skipped.push({ kind: type, id: item.id, reason: "not_found" });
        continue;
      }
      await grant(db, p, spaceId, type, item.id, item.level);
    }
  }
  for (const link of definition.vault_links) {
    const found = await catalog.vault?.(db, link.id);
    if (!found) {
      const walled = await one<{ walled: boolean }>(db, "select work.vault_walled($1) as walled", [
        link.id,
      ]);
      skipped.push({ kind: "vault", id: link.id, reason: walled?.walled ? "wall" : "not_found" });
    } else if (!found.full) {
      // The new Space must be able to grant the access, so a vault it can only read is skipped.
      skipped.push({ kind: "vault", id: link.id, reason: "not_shared" });
    } else {
      await grant(db, p, spaceId, "vault", link.id, link.level);
    }
  }

  if (definition.customization.accent_color) {
    await db.query(
      "update work.space set customization = customization || $2::jsonb where id = $1",
      [spaceId, JSON.stringify({ accent_color: definition.customization.accent_color })],
    );
  }
  await kit.activity(db, p, spaceId, "template.applied", null, {
    phases: definition.phases.length,
    skipped: skipped.length,
  });
  return skipped;
}

export interface Templates {
  list(p: Principal): Promise<TemplateView[]>;
  get(p: Principal, id: string): Promise<TemplateView | null>;
  create(p: Principal, input: TemplateInput, client: Client): Promise<Result<TemplateView>>;
  update(
    p: Principal,
    id: string,
    patch: {
      name?: string | undefined;
      description?: string | undefined;
      shared_to?: { workspace: boolean; group_ids: string[] } | undefined;
    },
    client: Client,
  ): Promise<Result<TemplateView>>;
  remove(p: Principal, id: string, client: Client): Promise<Result<null>>;
  /** Adds a template to an existing Space. Needs its admin. */
  applyTo(
    p: Principal,
    templateId: string,
    spaceId: string,
    client: Client,
  ): Promise<Result<{ skipped: SpaceSkipped[] }>>;
}

const templateView = (r: TemplateRow, me: string): TemplateView | null => {
  const definition = parse(r.definition);
  if (!definition) return null;
  const mine = r.owner_id === me;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ownerId: r.owner_id,
    sharedTo: mine
      ? { workspace: r.shared_to.workspace, groupIds: r.shared_to.group_ids }
      : { workspace: false, groupIds: [] },
    definition,
    mine,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
};

/** A Space's skeleton: what "Save Space as template" keeps. */
async function skeletonOf(db: Db, spaceId: string): Promise<SpaceTemplateDefinition> {
  const phases = await db.query<{ id: string; name: string }>(
    "select id, name from work.phase where space_id = $1 order by ordinal",
    [spaceId],
  );
  const out: SpaceTemplateDefinition["phases"] = [];
  for (const phase of phases.rows) {
    const tasks = await db.query<{
      name: string;
      description_md: string;
      gate: boolean;
      assignee_type: string | null;
      assignee_id: string | null;
    }>(
      `select name, description_md, gate, assignee_type, assignee_id
         from work.task where space_id = $1 and phase_id = $2 and status <> 'cancelled' order by id`,
      [spaceId, phase.id],
    );
    out.push({
      name: phase.name,
      tasks: tasks.rows.map((t) => ({
        name: t.name,
        ...(t.description_md ? { description: t.description_md } : {}),
        gate: t.gate,
        ...(t.assignee_type === "agent" && t.assignee_id ? { agent_id: t.assignee_id } : {}),
      })),
    });
  }
  const resources = await db.query<{ resource_type: string; resource_id: string; access: string }>(
    "select resource_type, resource_id, access from work.space_resource where space_id = $1",
    [spaceId],
  );
  const level = (access: string): "run" | "view" => (access === "view" ? "view" : "run");
  const accent = await one<{ accent: string | null }>(
    db,
    "select customization ->> 'accent_color' as accent from work.space where id = $1",
    [spaceId],
  );
  return SpaceTemplateDefinition.parse({
    schema: "counsel.space-template/1",
    phases: out,
    agents: resources.rows
      .filter((r) => r.resource_type === "agent")
      .map((r) => ({ id: r.resource_id, level: level(r.access) })),
    workflows: resources.rows
      .filter((r) => r.resource_type === "workflow")
      .map((r) => ({ id: r.resource_id, level: level(r.access) })),
    vault_links: resources.rows
      .filter((r) => r.resource_type === "vault")
      .slice(0, 20)
      .map((r) => ({ id: r.resource_id, level: r.access === "view" ? "view" : "edit" })),
    customization: accent?.accent ? { accent_color: accent.accent } : {},
  });
}

export function createTemplates(kit: Kit, catalog: ResourceCatalog): Templates {
  const mine = async (db: Db, id: string, me: string) => {
    const row = isId(id) ? await one<TemplateRow>(db, `${TEMPLATE_SQL} where id = $1`, [id]) : null;
    if (!row) throw refusal("NOT_FOUND");
    // Others may use a shared template but not change it.
    if (row.owner_id !== me) throw refusal("FORBIDDEN");
    return row;
  };
  const view = async (db: Db, id: string, me: string) => {
    const row = await one<TemplateRow>(db, `${TEMPLATE_SQL} where id = $1`, [id]);
    const out = row ? templateView(row, me) : null;
    if (!out) throw refusal("NOT_FOUND");
    return out;
  };

  return {
    async list(p) {
      const r = await kit.attempt(p, async (db) => {
        const rows = await db.query<TemplateRow>(`${TEMPLATE_SQL} order by name, id limit 200`);
        return rows.rows.flatMap((row) => templateView(row, p.userId) ?? []);
      });
      return r.ok ? r.value : [];
    },

    async get(p, id) {
      if (!isId(id)) return null;
      const r = await kit.attempt(p, (db) => view(db, id, p.userId));
      return r.ok ? r.value : null;
    },

    async create(p, input, client) {
      return kit.attempt(p, async (db) => {
        let definition: SpaceTemplateDefinition;
        if (input.from_space_id) {
          await needMember(db, input.from_space_id);
          definition = await skeletonOf(db, input.from_space_id);
        } else if (input.definition) {
          definition = input.definition;
        } else {
          throw refusal("INVALID");
        }
        // The policy needs `spaces.templates`; without it the insert is refused.
        const made = await one<{ id: string }>(
          db,
          `insert into work.space_template
             (workspace_id, owner_id, name, description, definition, shared_to)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [
            p.workspaceId,
            p.userId,
            input.name,
            input.description ?? "",
            JSON.stringify(definition),
            JSON.stringify(input.shared_to ?? { workspace: false, group_ids: [] }),
          ],
        );
        const id = made?.id ?? "";
        await kit.audit(db, p, client, "space.template_created", "space_template", id, {
          from_space: input.from_space_id ?? null,
        });
        return view(db, id, p.userId);
      });
    },

    async update(p, id, patch, client) {
      return kit.attempt(p, async (db) => {
        await mine(db, id, p.userId);
        await db.query(
          `update work.space_template
              set name = coalesce($2, name), description = coalesce($3, description),
                  shared_to = coalesce($4::jsonb, shared_to), updated_at = now()
            where id = $1`,
          [
            id,
            patch.name ?? null,
            patch.description ?? null,
            patch.shared_to ? JSON.stringify(patch.shared_to) : null,
          ],
        );
        if (patch.shared_to) {
          await kit.audit(db, p, client, "space.template_shared", "space_template", id, {
            workspace: patch.shared_to.workspace,
            groups: patch.shared_to.group_ids.length,
          });
        }
        return view(db, id, p.userId);
      });
    },

    async remove(p, id, client) {
      return kit.attempt(p, async (db) => {
        await mine(db, id, p.userId);
        await db.query("delete from work.space_template where id = $1", [id]);
        await kit.audit(db, p, client, "template.deleted", "space_template", id);
        return null;
      });
    },

    async applyTo(p, templateId, spaceId, client) {
      return kit.attempt(p, async (db) => {
        await needAdmin(db, spaceId);
        const template = await loadTemplate(db, templateId);
        if (!template) throw refusal("NOT_FOUND");
        const skipped = await applyTemplate(db, kit, p, spaceId, template.definition, catalog);
        await kit.audit(db, p, client, "space.template_applied", "space", spaceId, {
          template_id: templateId,
          skipped: skipped.length,
        });
        return { skipped };
      });
    },
  };
}
