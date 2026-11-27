import {
  INTAKE_LIMITS,
  type IntakeAttachment,
  type IntakeChannel,
  type IntakeEscalate,
  type IntakeEvent,
  type IntakeFieldDef,
  type IntakeFieldValues,
  type IntakeMine,
  type IntakeMyTask,
  type IntakeRequest,
  type IntakeRequestCreate,
  type IntakeRequestDetail,
  type IntakeRouting,
  type IntakeStatus,
  type IntakeStatusChange,
  type IntakeType,
  type IntakeTypeCreate,
  type IntakeTypePatch,
  intakeCanMove,
  intakeCheckFields,
  intakeIsOpen,
  intakeSlaState,
} from "@legallabs/contracts";
import type pg from "pg";
import type { z } from "zod";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { trackOutcome, trackUsage } from "../command-center/record.js";
import { asApp, RLS_REFUSED, showIntakeFiles } from "../db.js";
import type { Documents, UploadResult } from "../documents/documents.js";
import { type Notifier, noNotifier } from "../notifications/notify.js";
import { tellEscalated } from "./sweep.js";

type Db = pg.PoolClient;
type TypeIn = z.output<typeof IntakeTypeCreate>;
type TypePatch = z.output<typeof IntakeTypePatch>;
type RequestIn = z.output<typeof IntakeRequestCreate>;

export type IntakeFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "TYPE_NOT_FOUND"
  | "INVALID_FIELDS"
  | "MATTER_NOT_FOUND"
  | "ATTACHMENT_NOT_FOUND"
  | "ASSIGNEE_NOT_ALLOWED"
  | "ROUTE_NOT_ACCESSIBLE"
  | "UNKNOWN_PRINCIPAL"
  | "NAME_TAKEN"
  | "DUPLICATE"
  | "TYPE_REQUIRED"
  | "WRONG_STATE"
  | "CANNOT_MERGE"
  | "BAD_CURSOR"
  | Extract<UploadResult, { ok: false }>["reason"];

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: IntakeFailure; details?: string[] };

export interface IntakeFilter {
  /** "open" is every status that isn't finished. */
  status?: IntakeStatus | "open" | undefined;
  assigneeId?: string | undefined;
  typeId?: string | undefined;
  channel?: IntakeChannel | undefined;
  oldestFirst?: boolean | undefined;
  cursor?: string | undefined;
}

export interface Intake {
  listTypes(principal: Principal): Promise<Result<{ types: IntakeType[]; can_manage: boolean }>>;
  createType(principal: Principal, input: TypeIn, client: Client): Promise<Result<IntakeType>>;
  patchType(
    principal: Principal,
    id: string,
    patch: TypePatch,
    client: Client,
  ): Promise<Result<IntakeType>>;
  deleteType(principal: Principal, id: string, client: Client): Promise<Result<null>>;
  /** Files something sent in under the intake service user, ready to attach to a request. */
  upload(
    principal: Principal,
    input: { name: string; bytes: Uint8Array },
    client: Client,
  ): Promise<Result<IntakeAttachment>>;
  create(
    principal: Principal,
    input: RequestIn,
    client: Client,
  ): Promise<Result<IntakeRequestDetail>>;
  list(
    principal: Principal,
    filter: IntakeFilter,
  ): Promise<Result<{ requests: IntakeRequest[]; next_cursor: string | null }>>;
  get(principal: Principal, id: string): Promise<Result<IntakeRequestDetail>>;
  events(principal: Principal, id: string): Promise<Result<IntakeEvent[]>>;
  /** Who the request can be given to: triage staff who can open it. */
  assignees(principal: Principal, id: string): Promise<Result<{ id: string; name: string }[]>>;
  assign(
    principal: Principal,
    id: string,
    assigneeId: string | null,
    client: Client,
  ): Promise<Result<IntakeRequestDetail>>;
  setType(
    principal: Principal,
    id: string,
    typeId: string,
    client: Client,
  ): Promise<Result<IntakeRequestDetail>>;
  setStatus(
    principal: Principal,
    id: string,
    change: IntakeStatusChange,
    client: Client,
  ): Promise<Result<IntakeRequestDetail>>;
  /** Queues words to an email requester; the worker sends them from the intake address. */
  reply(
    principal: Principal,
    id: string,
    text: string,
    client: Client,
  ): Promise<Result<{ delivery: "queued" }>>;
  /** Combines two open requests of one matter; the older is kept and returned. */
  merge(
    principal: Principal,
    id: string,
    otherId: string,
    client: Client,
  ): Promise<Result<IntakeRequestDetail>>;
  escalate(
    principal: Principal,
    id: string,
    input: IntakeEscalate,
    client: Client,
  ): Promise<Result<IntakeRequestDetail>>;
  /** The caller's own open requests and Space tasks. Needs no intake permission. */
  mine(principal: Principal): Promise<Result<IntakeMine>>;
}

export interface IntakeOptions {
  /** Attachments go through the same store, checks and ingest queue as any upload. */
  documents: Pick<Documents, "upload">;
  notifier?: Notifier;
  pageSize?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE = "23505";

class Refused extends Error {
  constructor(
    readonly reason: IntakeFailure,
    readonly details?: string[],
  ) {
    super(reason);
  }
}
const refuse = (reason: IntakeFailure, details?: string[]): never => {
  throw new Refused(reason, details);
};

const may = async (db: Db, ...permissions: string[]) =>
  (
    await db.query<{ ok: boolean }>(
      "select bool_or(apps.intake_may(p)) ok from unnest($1::text[]) p",
      [permissions],
    )
  ).rows[0]?.ok === true;
const mustTriage = async (db: Db) => (await may(db, "intake.triage")) || refuse("FORBIDDEN");
const canManage = (db: Db) => may(db, "intake.manage", "admin.config");

const audit = (
  db: Db,
  principal: Principal,
  action: string,
  object: [type: string | null, id: string | null],
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
    action,
    principal.userId,
    ...object,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

const event = (
  db: Db,
  principal: Principal,
  requestId: string,
  kind: IntakeEvent["kind"],
  details: object,
) =>
  db.query(
    `insert into apps.intake_event (workspace_id, request_id, kind, actor_type, actor_id, details)
     values ($1, $2, $3, 'user', $4, $5)`,
    [principal.workspaceId, requestId, kind, principal.userId, JSON.stringify(details)],
  );

interface TypeRow extends Omit<IntakeType, "created_at" | "updated_at"> {
  created_at: Date;
  updated_at: Date;
}
const TYPE_COLUMNS = `id, name, description, fields, routing, default_owners, reviewers,
  escalations, sla_hours, timeout_hours awaiting_requester_timeout_hours, keyword_rules,
  created_at, updated_at`;
const toType = (row: TypeRow): IntakeType => ({
  ...row,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

// Request field name to column; only these can be patched.
const TYPE_PATCH: Record<keyof TypePatch, string> = {
  name: "name",
  description: "description",
  fields: "fields",
  routing: "routing",
  default_owners: "default_owners",
  reviewers: "reviewers",
  escalations: "escalations",
  sla_hours: "sla_hours",
  awaiting_requester_timeout_hours: "timeout_hours",
  keyword_rules: "keyword_rules",
};
const JSON_COLUMNS = new Set(["fields", "routing", "escalations"]);
const param = (column: string, value: unknown) =>
  JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value;

async function loadType(db: Db, id: string): Promise<TypeRow | null> {
  const { rows } = await db.query<TypeRow>(
    `select ${TYPE_COLUMNS} from apps.intake_request_type where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0] ?? null;
}

/** The routing target must be something the person setting it up can open themselves. */
async function checkRouting(db: Db, routing: IntakeRouting) {
  const [sql, id] =
    routing.kind === "agent"
      ? ["select 1 from work.agent where id = $1 and deleted_at is null", routing.agent_id]
      : routing.kind === "contract_intelligence"
        ? ["select 1 from apps.ci_review_agent where id = $1", routing.ci_agent_id]
        : [
            `select 1 from work.space
              where id = $1 and deleted_at is null
                and work.space_role(id) in ('admin', 'collaborator')`,
            routing.space_id,
          ];
  const { rowCount } = await db.query(sql as string, [id]);
  if (!rowCount) refuse("ROUTE_NOT_ACCESSIBLE");
}

/** Everyone a type names must be an active member or a group of this workspace. */
async function checkPeople(db: Db, type: TypePatch) {
  const users = new Set<string>();
  const groups = new Set<string>();
  const either = [...(type.default_owners ?? []), ...(type.reviewers ?? [])];
  const add = (to: { user_id: string } | { group_id: string }) =>
    "user_id" in to ? users.add(to.user_id) : groups.add(to.group_id);
  for (const escalation of type.escalations ?? []) add(escalation.target);
  if (type.routing?.kind === "lawyer") {
    for (const rule of type.routing.assignment) {
      if (rule.kind === "fixed") users.add(rule.user_id);
      else if (rule.kind === "round_robin") groups.add(rule.group_id);
      else for (const one of rule.cases) add(one.assignee);
    }
  }
  const { rows } = await db.query<{ ok: boolean }>(
    `with people as (
       select id from core."user" where kind = 'member' and status = 'active'
     ), teams as (
       select id from core."group"
     )
     select not exists (select 1 from unnest($1::uuid[]) x where x not in (select id from people))
        and not exists (select 1 from unnest($2::uuid[]) x where x not in (select id from teams))
        and not exists (select 1 from unnest($3::uuid[]) x
                         where x not in (select id from people union select id from teams)) ok`,
    [[...users], [...groups], either],
  );
  if (!rows[0]?.ok) refuse("UNKNOWN_PRINCIPAL");
}

interface RequestRow {
  id: string;
  number: number;
  channel: IntakeChannel;
  external_ref: string;
  requester_name: string;
  requester_email: string | null;
  external_user_id: string;
  type_id: string | null;
  type_name: string | null;
  fields: IntakeFieldValues;
  missing_fields: string[];
  status: IntakeStatus;
  closed_reason: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  matter_id: string | null;
  sla_due_at: Date | null;
  classification_confidence: number | null;
  task_id: string | null;
  merged_into: string | null;
  created_at: Date;
  updated_at: Date;
}

const REQUEST_COLUMNS = `r.id, r.number, r.channel, r.external_ref, r.requester_name,
  r.requester_email, q.external_user_id, r.type_id, t.name type_name, r.fields, r.missing_fields,
  r.status, r.closed_reason, r.assignee_id,
  nullif(coalesce(nullif(u.name, ''), u.email), '') assignee_name, r.matter_id, r.sla_due_at,
  r.classification_confidence, r.task_id,
  r.merged_into, r.created_at, r.updated_at`;
const REQUEST_FROM = `apps.intake_request r
  join apps.intake_requester q on q.id = r.requester_id
  left join apps.intake_request_type t on t.id = r.type_id
  left join core."user" u on u.id = r.assignee_id`;

function toRequest(row: RequestRow): IntakeRequest {
  return {
    id: row.id,
    number: row.number,
    channel: row.channel,
    external_ref: row.external_ref,
    requester: {
      display_name: row.requester_name,
      email: row.requester_email,
      external_user_id: row.external_user_id,
    },
    type_id: row.type_id,
    type_name: row.type_name,
    fields: row.fields,
    missing_fields: row.missing_fields,
    status: row.status,
    closed_reason: row.closed_reason,
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name,
    matter_id: row.matter_id,
    classification_confidence: row.classification_confidence,
    task_id: row.task_id,
    merged_into: row.merged_into,
    // A finished request's clock has stopped where it was.
    sla: row.sla_due_at
      ? {
          due_at: row.sla_due_at.toISOString(),
          state: intakeSlaState(
            row.created_at,
            row.sla_due_at,
            intakeIsOpen(row.status) ? new Date() : row.updated_at,
          ),
        }
      : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function loadRequest(db: Db, id: string): Promise<RequestRow> {
  if (!UUID.test(id)) refuse("NOT_FOUND");
  const { rows } = await db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from ${REQUEST_FROM} where r.id = $1`,
    [id],
  );
  return rows[0] ?? refuse("NOT_FOUND");
}

async function loadDetail(db: Db, id: string): Promise<IntakeRequestDetail> {
  const row = await loadRequest(db, id);
  await showIntakeFiles(db);
  const { rows } = await db.query<IntakeAttachment & { size: string }>(
    `select d.id document_id, d.name, d.size, coalesce(j.status, 'indexed') state
       from apps.intake_attachment a
       join content.document d on d.id = a.document_id
       left join content.ingest_job j on j.version_id = (
         select v.id from content.document_version v
          where v.document_id = d.id order by v.version_no desc limit 1)
      where a.request_id = $1 order by a.created_at, d.id`,
    [id],
  );
  return {
    ...toRequest(row),
    attachments: rows.map((a) => ({ ...a, size: Number(a.size) })),
  };
}

/** Locks an open request, so two people can't both move it. */
async function openRequest(db: Db, id: string) {
  await mustTriage(db);
  if (!UUID.test(id)) refuse("NOT_FOUND");
  const { rows } = await db.query<{
    number: number;
    status: IntakeStatus;
    type_id: string | null;
    fields: IntakeFieldValues;
    matter_id: string | null;
    assignee_id: string | null;
    created_at: Date;
  }>(
    `select number, status, type_id, fields, matter_id, assignee_id, created_at
       from apps.intake_request where id = $1 for update`,
    [id],
  );
  const row = rows[0] ?? refuse("NOT_FOUND");
  if (!intakeIsOpen(row.status)) refuse("WRONG_STATE");
  return row;
}

/**
 * Values that can't count under a type: a matter other than the request's own (changing type
 * must never bring one in) and a file that isn't attached to it.
 */
function unusable(
  defs: readonly IntakeFieldDef[],
  values: IntakeFieldValues,
  matterId: string | null,
  attachments: readonly string[],
): string[] {
  return defs
    .filter((def) => {
      const value = values[def.key];
      if (value === undefined || value === "") return false;
      if (def.type === "matter") return value !== matterId;
      return def.type === "file" && !attachments.includes(String(value));
    })
    .map((def) => def.key);
}

export function createIntake(pool: pg.Pool, options: IntakeOptions): Intake {
  const { documents } = options;
  const notifier = options.notifier ?? noNotifier;
  const pageSize = options.pageSize ?? INTAKE_LIMITS.page_size;

  async function guarded<T>(
    principal: Principal,
    work: (db: Db) => Promise<T>,
  ): Promise<Result<T>> {
    try {
      return { ok: true, value: await asApp(pool, principal, work) };
    } catch (err) {
      if (err instanceof Refused) {
        return { ok: false, reason: err.reason, ...(err.details && { details: err.details }) };
      }
      if ((err as { code?: string }).code === RLS_REFUSED) {
        return { ok: false, reason: "FORBIDDEN" };
      }
      throw err;
    }
  }

  /**
   * A write that records its refusals: the attempt is rolled back, so the audit event is written
   * on its own afterwards. Someone without the permission is not recorded, as elsewhere.
   */
  async function audited<T>(
    principal: Principal,
    requestId: string | null,
    client: Client,
    work: (db: Db) => Promise<T>,
  ): Promise<Result<T>> {
    const result = await guarded(principal, work);
    if (!result.ok && result.reason !== "FORBIDDEN" && result.reason !== "NOT_FOUND") {
      await asApp(pool, principal, (db) =>
        audit(
          db,
          principal,
          "intake.request.refused",
          [requestId ? "intake_request" : null, requestId],
          { reason: result.reason },
          client,
        ),
      );
    }
    return result;
  }

  const inbox = async (db: Db) => {
    const { rows } = await db.query<{ service_user_id: string; vault_id: string }>(
      "select service_user_id, vault_id from apps.ensure_intake_inbox()",
    );
    return rows[0] as { service_user_id: string; vault_id: string };
  };

  async function insertRequest(db: Db, principal: Principal, input: RequestIn) {
    await mustTriage(db);
    const type = input.type_id ? await loadType(db, input.type_id) : null;
    if (input.type_id && !type) refuse("TYPE_NOT_FOUND");
    let matterId = input.matter_id ?? null;
    if (type) {
      const { invalid } = intakeCheckFields(type.fields, input.fields);
      if (invalid.length) refuse("INVALID_FIELDS", invalid);
      for (const def of type.fields) {
        const value = input.fields[def.key];
        if (def.type === "matter" && value !== undefined && value !== "") {
          matterId ??= String(value);
        }
      }
      const wrong = unusable(type.fields, input.fields, matterId, input.attachments);
      if (wrong.length) refuse("INVALID_FIELDS", wrong);
    }
    if (matterId) {
      const { rows } = await db.query<{ ok: boolean }>("select core.can_access_matter($1) ok", [
        matterId,
      ]);
      if (!rows[0]?.ok) refuse("MATTER_NOT_FOUND");
    }
    const { requester } = input;
    const email = requester.email ?? null;
    const external = requester.external_user_id ?? email?.toLowerCase() ?? null;
    const who = await db.query<{ id: string }>(
      "select apps.intake_requester_id('api', coalesce($1, core.uuid7()::text), $2, $3) id",
      [external, requester.display_name, email],
    );
    let id: string;
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into apps.intake_request (workspace_id, channel, external_ref, requester_id,
           requester_name, requester_email, type_id, fields, missing_fields, status, matter_id,
           sla_due_at, created_by)
         values ($1, 'api', coalesce($2, core.uuid7()::text), $3, $4, $5, $6, $7, $8, $9, $10,
                 now() + make_interval(hours => $11), $12)
         returning id`,
        [
          principal.workspaceId,
          input.external_ref ?? null,
          who.rows[0]?.id,
          requester.display_name,
          email,
          type?.id ?? null,
          JSON.stringify(input.fields),
          type ? intakeCheckFields(type.fields, input.fields).missing : [],
          type ? "new" : "unclassified",
          matterId,
          type?.sla_hours ?? null,
          principal.userId,
        ],
      );
      id = rows[0]?.id as string;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE) refuse("DUPLICATE");
      throw err;
    }
    if (input.attachments.length) {
      const { rowCount } = await db.query(
        `update apps.intake_attachment set request_id = $1
          where document_id = any($2) and added_by = $3 and request_id is null`,
        [id, input.attachments, principal.userId],
      );
      if (rowCount !== input.attachments.length) refuse("ATTACHMENT_NOT_FOUND");
    }
    return { id, type };
  }

  const tell = async (principal: Principal, row: IntakeRequest) => {
    if (!row.assignee_id) return;
    await notifier.notify(principal, {
      kind: "intake.request_assigned",
      actorId: principal.userId,
      objectType: "intake_request",
      objectId: row.id,
      // The number only: a title is also what email carries.
      objectTitle: `request #${row.number}`,
      matterId: row.matter_id,
      people: { assignee: row.assignee_id },
      url: `#/intake/requests/${row.id}`,
    });
  };

  return {
    listTypes(principal) {
      return guarded(principal, async (db) => {
        const manage = await canManage(db);
        if (!manage && !(await may(db, "intake.triage"))) refuse("FORBIDDEN");
        const { rows } = await db.query<TypeRow>(
          `select ${TYPE_COLUMNS} from apps.intake_request_type
            where deleted_at is null order by lower(name) limit 200`,
        );
        return { types: rows.map(toType), can_manage: manage };
      });
    },

    createType(principal, input, client) {
      return guarded(principal, async (db) => {
        if (!(await canManage(db))) refuse("FORBIDDEN");
        if (input.routing) await checkRouting(db, input.routing);
        await checkPeople(db, input);
        const entries = Object.entries(TYPE_PATCH).map(([field, column]) => ({
          column,
          value: param(column, input[field as keyof TypeIn]),
        }));
        let row: TypeRow;
        try {
          const { rows } = await db.query<TypeRow>(
            `insert into apps.intake_request_type
               (workspace_id, created_by, ${entries.map((e) => e.column).join(", ")})
             values ($1, $2, ${entries.map((_, i) => `$${i + 3}`).join(", ")})
             returning ${TYPE_COLUMNS}`,
            [principal.workspaceId, principal.userId, ...entries.map((e) => e.value)],
          );
          row = rows[0] as TypeRow;
        } catch (err) {
          if ((err as { code?: string }).code === UNIQUE) refuse("NAME_TAKEN");
          throw err;
        }
        await audit(db, principal, "intake.type.created", ["intake_type", row.id], {}, client);
        return toType(row);
      });
    },

    patchType(principal, id, patch, client) {
      return guarded(principal, async (db) => {
        if (!(await canManage(db))) refuse("FORBIDDEN");
        if (!UUID.test(id) || !(await loadType(db, id))) refuse("NOT_FOUND");
        if (patch.routing) await checkRouting(db, patch.routing);
        await checkPeople(db, patch);
        const changed = Object.entries(patch)
          .filter(([, value]) => value !== undefined)
          .map(([field, value]) => {
            const column = TYPE_PATCH[field as keyof TypePatch];
            return { column, value: param(column, value) };
          });
        let row: TypeRow;
        try {
          const { rows } = await db.query<TypeRow>(
            `update apps.intake_request_type
                set ${changed.map((c, i) => `${c.column} = $${i + 2}`).join(", ")},
                    updated_at = now()
              where id = $1 and deleted_at is null returning ${TYPE_COLUMNS}`,
            [id, ...changed.map((c) => c.value)],
          );
          row = rows[0] ?? refuse("NOT_FOUND");
        } catch (err) {
          if ((err as { code?: string }).code === UNIQUE) refuse("NAME_TAKEN");
          throw err;
        }
        await audit(
          db,
          principal,
          "intake.type.updated",
          ["intake_type", id],
          { changed: changed.map((c) => c.column) },
          client,
        );
        return toType(row);
      });
    },

    deleteType(principal, id, client) {
      return guarded(principal, async (db) => {
        if (!(await canManage(db))) refuse("FORBIDDEN");
        if (!UUID.test(id)) refuse("NOT_FOUND");
        const { rowCount } = await db.query(
          `update apps.intake_request_type set deleted_at = now(), updated_at = now()
            where id = $1 and deleted_at is null`,
          [id],
        );
        if (!rowCount) refuse("NOT_FOUND");
        await audit(db, principal, "intake.type.deleted", ["intake_type", id], {}, client);
        return null;
      });
    },

    async upload(principal, input, client) {
      const box = await guarded(principal, async (db) => {
        await mustTriage(db);
        return inbox(db);
      });
      if (!box.ok) return box;
      // Filed as the intake service user: the file belongs to the Inbox, not to whoever
      // happened to type it in. Who added it is written with it, or the file isn't kept.
      const service = {
        sessionId: "intake",
        userId: box.value.service_user_id,
        workspaceId: principal.workspaceId,
      };
      const stored = await documents.upload(
        service,
        {
          ...input,
          matterId: null,
          vaultId: box.value.vault_id,
          keepName: true,
          within: async (db, documentId) => {
            await db.query(
              `insert into apps.intake_attachment (workspace_id, document_id, added_by)
               values ($1, $2, $3)`,
              [principal.workspaceId, documentId, principal.userId],
            );
            await db.query(
              `select admin.append_audit_event('intake.attachment_added', 'service', $1,
                 'document', $2, $3, $4, $5)`,
              [
                service.userId,
                documentId,
                JSON.stringify({ added_by: principal.userId, size: input.bytes.length }),
                client.ip,
                uaHash(client),
              ],
            );
          },
        },
        client,
      );
      if (!stored.ok) return { ok: false, reason: stored.reason };
      const { id, name, size, status } = stored.document;
      return { ok: true, value: { document_id: id, name, size, state: status } };
    },

    create(principal, input, client) {
      return audited(principal, null, client, async (db) => {
        const { id, type } = await insertRequest(db, principal, input);
        await event(db, principal, id, "inbound", {
          channel: "api",
          attachments: input.attachments.length,
        });
        if (type) await event(db, principal, id, "classified", { type_id: type.id });
        await trackUsage(db, {
          surface: "apps",
          action: "intake_request",
          actionClass: "other",
          objectType: "intake_request",
          objectId: id,
          documentCount: input.attachments.length,
        });
        const detail = await loadDetail(db, id);
        await audit(
          db,
          principal,
          "intake.request.created",
          ["intake_request", id],
          { channel: "api", attachments: input.attachments.length },
          client,
        );
        return detail;
      });
    },

    list(principal, filter) {
      return guarded(principal, async (db) => {
        await mustTriage(db);
        const params: unknown[] = [];
        const where: string[] = [];
        const add = (sql: (n: string) => string, value: unknown) => {
          params.push(value);
          where.push(sql(`$${params.length}`));
        };
        if (filter.status === "open") where.push("r.status not in ('done', 'closed')");
        else if (filter.status) add((n) => `r.status = ${n}`, filter.status);
        if (filter.assigneeId) add((n) => `r.assignee_id = ${n}`, filter.assigneeId);
        if (filter.typeId) add((n) => `r.type_id = ${n}`, filter.typeId);
        if (filter.channel) add((n) => `r.channel = ${n}`, filter.channel);
        if (filter.cursor !== undefined) {
          if (!/^[1-9]\d{0,8}$/.test(filter.cursor)) refuse("BAD_CURSOR");
          add((n) => `r.number ${filter.oldestFirst ? ">" : "<"} ${n}`, Number(filter.cursor));
        }
        params.push(pageSize + 1);
        const { rows } = await db.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from ${REQUEST_FROM}
            ${where.length ? `where ${where.join(" and ")}` : ""}
            order by r.number ${filter.oldestFirst ? "asc" : "desc"} limit $${params.length}`,
          params,
        );
        const page = rows.slice(0, pageSize);
        return {
          requests: page.map(toRequest),
          next_cursor: rows.length > pageSize ? String(page.at(-1)?.number) : null,
        };
      });
    },

    get(principal, id) {
      return guarded(principal, async (db) => {
        await mustTriage(db);
        return loadDetail(db, id);
      });
    },

    events(principal, id) {
      return guarded(principal, async (db) => {
        await mustTriage(db);
        await loadRequest(db, id);
        const { rows } = await db.query<Omit<IntakeEvent, "at"> & { at: Date }>(
          `select e.id, e.at, e.kind, e.actor_type, e.actor_id,
                  nullif(coalesce(nullif(u.name, ''), u.email), '') actor_name, e.details
             from apps.intake_event e
             left join core."user" u on u.id = e.actor_id
            where e.request_id = $1 order by e.seq limit 2000`,
          [id],
        );
        return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
      });
    },

    assignees(principal, id) {
      return guarded(principal, async (db) => {
        await mustTriage(db);
        const row = await loadRequest(db, id);
        const { rows } = await db.query<{ id: string; name: string }>(
          `select u.id, coalesce(nullif(u.name, ''), u.email) name
             from core."user" u
            where u.kind = 'member' and u.status = 'active' and apps.intake_can_take(u.id, $1)
            order by 2 limit 500`,
          [row.matter_id],
        );
        return rows;
      });
    },

    async assign(principal, id, assigneeId, client) {
      let changed = false;
      const result = await audited(principal, id, client, async (db) => {
        const row = await openRequest(db, id);
        if (assigneeId === row.assignee_id) return loadDetail(db, id);
        if (assigneeId) {
          const { rows } = await db.query<{ ok: boolean }>(
            "select apps.intake_can_take($1, $2) ok",
            [assigneeId, row.matter_id],
          );
          if (!rows[0]?.ok) refuse("ASSIGNEE_NOT_ALLOWED");
        }
        await db.query(
          "update apps.intake_request set assignee_id = $2, updated_at = now() where id = $1",
          [id, assigneeId],
        );
        await event(db, principal, id, "assigned", { assignee_id: assigneeId });
        await audit(
          db,
          principal,
          "intake.request.assigned",
          ["intake_request", id],
          { assignee_id: assigneeId },
          client,
        );
        changed = true;
        return loadDetail(db, id);
      });
      if (result.ok && changed) await tell(principal, result.value);
      return result;
    },

    setType(principal, id, typeId, client) {
      return audited(principal, id, client, async (db) => {
        const row = await openRequest(db, id);
        const type = (await loadType(db, typeId)) ?? refuse("TYPE_NOT_FOUND");
        const files = await db.query<{ document_id: string }>(
          "select document_id from apps.intake_attachment where request_id = $1",
          [id],
        );
        const wrong = new Set(
          unusable(
            type.fields,
            row.fields,
            row.matter_id,
            files.rows.map((f) => f.document_id),
          ),
        );
        const usable = Object.fromEntries(
          Object.entries(row.fields).filter(([key]) => !wrong.has(key)),
        );
        await db.query(
          `update apps.intake_request
              set type_id = $2, missing_fields = $3, updated_at = now(),
                  status = case when status = 'unclassified' then 'new' else status end,
                  sla_due_at = created_at + make_interval(hours => $4)
            where id = $1`,
          [id, type.id, intakeCheckFields(type.fields, usable).missing, type.sla_hours],
        );
        const details = { type_id: type.id, previous_type_id: row.type_id };
        await event(db, principal, id, "classified", details);
        await audit(
          db,
          principal,
          "intake.request.classified",
          ["intake_request", id],
          details,
          client,
        );
        return loadDetail(db, id);
      });
    },

    setStatus(principal, id, change, client) {
      return audited(principal, id, client, async (db) => {
        const row = await openRequest(db, id);
        if (!intakeCanMove(row.status, change.status)) refuse("WRONG_STATE");
        if (!row.type_id && change.status !== "closed" && change.status !== "awaiting_requester") {
          refuse("TYPE_REQUIRED");
        }
        await db.query(
          `update apps.intake_request set status = $2, closed_reason = $3, updated_at = now()
            where id = $1`,
          [id, change.status, change.reason ?? null],
        );
        const details = { from: row.status, to: change.status };
        await event(db, principal, id, "status", details);
        if (!intakeIsOpen(change.status)) {
          await trackOutcome(db, {
            workflowType: "request_resolved",
            since: row.created_at,
            once: `intake_request:${id}`,
          });
        }
        await audit(
          db,
          principal,
          "intake.request.status_changed",
          ["intake_request", id],
          details,
          client,
        );
        return loadDetail(db, id);
      });
    },

    reply(principal, id, text, client) {
      return audited(principal, id, client, async (db) => {
        await openRequest(db, id);
        const request = await loadRequest(db, id);
        if (request.channel !== "email" || !request.requester_email) refuse("WRONG_STATE");
        // The words wait here until they are sent; the audit log never holds them.
        await db.query(
          `insert into apps.intake_outbound (workspace_id, request_id, kind, ref, body, created_by)
           values ($1, $2, 'reply', 'reply:' || core.uuid7()::text, $3, $4)`,
          [principal.workspaceId, id, text, principal.userId],
        );
        await event(db, principal, id, "outbound", { mail: "reply", outcome: "queued" });
        await audit(db, principal, "intake.request.replied", ["intake_request", id], {}, client);
        return { delivery: "queued" as const };
      });
    },

    merge(principal, id, otherId, client) {
      return audited(principal, id, client, async (db) => {
        if (id === otherId) refuse("CANNOT_MERGE");
        // Locked in id order, so two merges the other way round can't hold each other up.
        const rows = new Map<string, Awaited<ReturnType<typeof openRequest>>>();
        for (const one of [id, otherId].sort()) rows.set(one, await openRequest(db, one));
        const [kept, gone] = [id, otherId].sort(
          (a, b) => (rows.get(a)?.number ?? 0) - (rows.get(b)?.number ?? 0),
        ) as [string, string];
        if (rows.get(kept)?.matter_id !== rows.get(gone)?.matter_id) refuse("CANNOT_MERGE");
        await db.query(
          `update apps.intake_request
              set status = 'closed', closed_reason = 'merged', merged_into = $2, updated_at = now()
            where id = $1`,
          [gone, kept],
        );
        await event(db, principal, gone, "merged", { into: kept });
        await audit(
          db,
          principal,
          "intake.request.merged",
          ["intake_request", gone],
          { into: kept },
          client,
        );
        return loadDetail(db, kept);
      });
    },

    async escalate(principal, id, input, client) {
      let people: string[] = [];
      const result = await audited(principal, id, client, async (db) => {
        await openRequest(db, id);
        const { to } = input;
        const { rows } = await db.query<{ people: string[] }>(
          "select apps.escalate_intake_request($1, $2, $3, $4) people",
          [
            id,
            "user_id" in to ? to.user_id : null,
            "group_id" in to ? to.group_id : null,
            input.note,
          ],
        );
        people = rows[0]?.people ?? [];
        if (people.length === 0) refuse("ASSIGNEE_NOT_ALLOWED");
        // The note stays on the request: the audit log holds no words.
        await audit(
          db,
          principal,
          "intake.request.escalated",
          ["intake_request", id],
          { recipients: people.length },
          client,
        );
        return loadDetail(db, id);
      });
      if (result.ok) {
        await tellEscalated(
          notifier,
          principal.workspaceId,
          { id, number: result.value.number, matterId: result.value.matter_id },
          people,
          principal.userId,
        );
      }
      return result;
    },

    mine(principal) {
      return guarded(principal, async (db) => {
        // Policies decide what is visible: requests need triage, tasks need the Space.
        const requests = await db.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from ${REQUEST_FROM}
            where r.assignee_id = $1 and r.status not in ('done', 'closed')
            order by r.sla_due_at nulls last, r.number limit $2`,
          [principal.userId, pageSize],
        );
        const tasks = await db.query<IntakeMyTask>(
          `select t.id, t.space_id, t.name, to_char(t.due_at, 'YYYY-MM-DD') due_at, t.status
             from work.task t
             join work.space s on s.id = t.space_id and s.deleted_at is null
            where t.assignee_type = 'user' and t.assignee_id = $1
              and t.status in ('todo', 'in_progress')
            order by t.due_at nulls last, t.id limit $2`,
          [principal.userId, pageSize],
        );
        return { requests: requests.rows.map(toRequest), tasks: tasks.rows };
      });
    },
  };
}
