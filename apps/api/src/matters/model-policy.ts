import type { Gateway, TaskClass } from "@legallabs/model-gateway";
import type pg from "pg";

// A matter's model policy (deny_providers, deny_models), applied to any model call that reads
// its material. Every such call goes through here.

const TASKS: readonly TaskClass[] = ["synthesize", "plan", "read_extract", "draft_edit"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NO_MODEL_MESSAGE = "This matter's model policy leaves no model for this.";

type Ids = readonly (string | null | undefined)[];

/** What a call is about. The matter of any of it applies; none of it means no policy. */
export interface Material {
  matters?: Ids;
  documents?: Ids;
  versions?: Ids;
  threads?: Ids;
  spaces?: Ids;
  /** Review tables: the table's own matter and those of the files in its rows. */
  tables?: Ids;
}

export interface MatterModels {
  /** Models a matter keeps its material from; every call about it leaves these out. */
  exclude: string[];
  /** False when the policy leaves no model for this kind of work. */
  allows(task: TaskClass): boolean;
  /** The models left for this kind of work. */
  left(task: TaskClass): string[];
  /** False for a "provider/model" the policy denies. */
  permits(model: string): boolean;
}

/** What the model policies of the material's matters leave usable, read as the caller. */
export async function modelsFor(
  db: pg.PoolClient,
  gateway: Gateway,
  material: Material,
): Promise<MatterModels> {
  const params = [
    material.matters,
    material.documents,
    material.versions,
    material.threads,
    material.spaces,
    material.tables,
  ].map((ids) => [...new Set(ids?.filter((id): id is string => !!id && UUID.test(id)))]);
  const { rows } = params.some((ids) => ids.length > 0)
    ? await db.query<{
        model_policy: { deny_providers?: string[]; deny_models?: string[] } | null;
      }>(
        `select m.model_policy from core.matter m
          where m.model_policy is not null and m.id in (
            select unnest($1::uuid[])
            union select d.matter_id from content.document d where d.id = any($2::uuid[])
            union select d.matter_id from content.document_version v
                    join content.document d on d.id = v.document_id where v.id = any($3::uuid[])
            union select t.matter_id from work.thread t where t.id = any($4::uuid[])
            union select s.matter_id from work.space s where s.id = any($5::uuid[])
            union select t.matter_id from work.review_table t where t.id = any($6::uuid[])
            union select d.matter_id from work.rt_row r
                    join content.document d on d.id = any(r.document_ids)
                   where r.table_id = any($6::uuid[]) and r.deleted_at is null)`,
        params,
      )
    : { rows: [] };
  const permits = (id: string) => {
    const [provider = "", ...name] = id.split("/");
    return !rows.some(
      ({ model_policy: policy }) =>
        policy?.deny_providers?.includes(provider) ||
        policy?.deny_models?.includes(id) ||
        policy?.deny_models?.includes(name.join("/")),
    );
  };
  const ids = (task: TaskClass) => gateway.models(task).map((m) => m.id);
  const left = (task: TaskClass) => ids(task).filter(permits);
  return {
    exclude: [...new Set(TASKS.flatMap(ids))].filter((id) => !permits(id)),
    // An install with no model at all is reported by the call itself, as unavailable.
    allows: (task) => ids(task).length === 0 || left(task).length > 0,
    left,
    permits,
  };
}
