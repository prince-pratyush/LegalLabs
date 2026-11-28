import {
  type AssignmentRule,
  type CiAssignee,
  ciAssignmentOrder,
  type IntakeFieldDef,
  type IntakeFieldValues,
  type IntakeRouting,
} from "@legallabs/contracts";
import { type Gateway, GatewayError } from "@legallabs/model-gateway";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { asWorker } from "../db.js";
import { type Notifier, noNotifier } from "../notifications/notify.js";
import { type Classifiable, classify, requestText } from "./classify.js";
import { type IntakeMail, sendIntakeMail } from "./mail.js";
import { type IntakeSlack, sendIntakeSlack } from "./slack-post.js";
import { sweepIntake } from "./sweep.js";

// Takes each request that has something new: classifies it, asks for what is missing and
// routes it; judges what is late; then sends the mail that is queued. It has no identity of
// its own.

export interface IntakeWorkerOptions {
  gateway: Gateway;
  /** Where the filed message is read from. */
  store: ObjectStore;
  /** Without a mail server nothing is sent and the mail stays queued. */
  mail?: IntakeMail;
  /** Without it nothing is posted to Slack and what is queued stays. */
  slack?: IntakeSlack;
  notifier?: Notifier;
  intervalMs?: number;
  /** What the sweep judges lateness against. */
  now?: () => Date;
  /** Ids and codes only: never an address, a name or any text. */
  log?: (line: string) => void;
}

interface Type extends Classifiable {
  routing: IntakeRouting | null;
  default_owners: string[];
}

interface Job {
  request_id: string;
  workspace_id: string;
  lease: string;
  attempt: number;
  calls: number;
  status: string;
  type_id: string | null;
  fields: IntakeFieldValues;
  asked_field: string | null;
  message_sha256: Buffer | null;
  attachment_id: string | null;
  types: Type[];
}

const BATCH = 25;
/** Past these a request is being worked or is finished, and nothing more is read from it. */
const SORTABLE = new Set(["new", "unclassified", "awaiting_requester", "triaged"]);
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 4;
/** Model calls a request may cost in its life, however many times it is answered. */
const MAX_CALLS = 10;

/**
 * Who to try, first to last. A field rule reads values a requester may have influenced, but it
 * only picks among the people the type's author named. A default owner is a user or a group,
 * so its id is offered as both.
 */
function candidates(type: Type, values: IntakeFieldValues): CiAssignee[] {
  const rules: AssignmentRule[] = type.routing?.kind === "lawyer" ? type.routing.assignment : [];
  return [
    ...ciAssignmentOrder(rules, values as Parameters<typeof ciAssignmentOrder>[1]),
    ...type.default_owners.flatMap((id): CiAssignee[] => [{ user_id: id }, { group_id: id }]),
  ];
}

export function createIntakeWorker(pool: pg.Pool, options: IntakeWorkerOptions) {
  const { gateway, store } = options;
  const notifier = options.notifier ?? noNotifier;
  const log = options.log ?? (() => {});

  const query = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    asWorker(pool, async (db) => (await db.query<T>(sql, params)).rows);

  async function message(job: Job): Promise<string> {
    if (!job.message_sha256) return "";
    const bytes = await store.get(contentKey(job.workspace_id, job.message_sha256.toString("hex")));
    return bytes ? requestText(Buffer.from(bytes).toString("utf8")) : "";
  }

  async function handle(job: Job) {
    const fixed = job.type_id ? (job.types.find((t) => t.id === job.type_id) ?? null) : null;
    // Nothing to do, or a type since deleted: a person picks another.
    if (!SORTABLE.has(job.status) || (job.type_id && !fixed)) {
      return query("select apps.postpone_intake_work($1, $2, null)", [job.request_id, job.lease]);
    }
    const text = await message(job);
    const model = job.calls < MAX_CALLS;
    if (model && text) {
      await query("select apps.spend_intake_call($1, $2)", [job.request_id, job.lease]);
    }
    let result: Awaited<ReturnType<typeof classify>>;
    try {
      result = await classify(gateway, {
        types: job.types,
        fixed,
        text,
        asked: job.asked_field,
        workspace: job.workspace_id,
        trace: `intake:${job.request_id}`,
        model,
      });
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      // A refusal stays one however often it is asked.
      if (!err.refused && job.attempt < MAX_ATTEMPTS) throw err;
      // No model to be had: keyword rules still apply, and the rest waits for a person.
      result = await classify(gateway, {
        types: job.types,
        fixed,
        text,
        workspace: job.workspace_id,
        trace: `intake:${job.request_id}`,
        model: false,
      });
    }
    const type = job.types.find((t) => t.id === result.typeId);
    const values: IntakeFieldValues = { ...result.fields };
    // A file is never read from words: it is the file that came with the request.
    const file = type?.fields.find((f: IntakeFieldDef) => f.type === "file" && f.required);
    if (file && job.attachment_id) values[file.key] = job.attachment_id;
    const [done] = await query<{
      assignee_id: string | null;
      number: number;
      matter_id: string | null;
    }>("select * from apps.apply_intake_work($1, $2, $3, $4, $5, $6)", [
      job.request_id,
      job.lease,
      result.typeId,
      result.confidence,
      JSON.stringify(values),
      JSON.stringify(type ? candidates(type, { ...values, ...job.fields }) : []),
    ]);
    if (done?.assignee_id) {
      await notifier.notify(
        { sessionId: "intake", userId: done.assignee_id, workspaceId: job.workspace_id },
        {
          kind: "intake.request_assigned",
          actorId: null,
          objectType: "intake_request",
          objectId: job.request_id,
          objectTitle: `request #${done.number}`,
          matterId: done.matter_id,
          people: { assignee: done.assignee_id },
          url: `#/intake/requests/${job.request_id}`,
        },
      );
    }
  }

  async function classifyDue(only: string[]) {
    for (let n = 0; n < BATCH; n++) {
      const [job] = await query<Job>("select * from apps.claim_intake_work($1, $2)", [
        LEASE_SECONDS,
        only.length > 0 ? only : null,
      ]);
      if (!job) return;
      try {
        await handle(job);
      } catch (err) {
        const { code } = err as { code?: string };
        log(`intake request ${job.request_id} failed: ${code ?? (err as Error).constructor.name}`);
        await query("select apps.postpone_intake_work($1, $2, $3)", [
          job.request_id,
          job.lease,
          job.attempt >= MAX_ATTEMPTS ? null : 60 * 2 ** (job.attempt - 1),
        ]);
      }
    }
  }

  /** Works through what is due. Tests name workspaces to keep to their own. */
  async function tick(...only: string[]): Promise<void> {
    await classifyDue(only);
    await sweepIntake(pool, { now: options.now?.() ?? new Date(), notifier, log }, only);
    if (options.mail) await sendIntakeMail(pool, options.mail, only, log);
    if (options.slack) await sendIntakeSlack(pool, options.slack, only, log);
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const guarded = () => {
    running ??= tick()
      .catch((err) => log(`intake pass failed: ${(err as { code?: string }).code ?? ""}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    tick,
    start() {
      timer ??= setInterval(() => void guarded(), options.intervalMs ?? 5000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
