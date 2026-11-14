import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuthorityRecord, authorityRecord, sourceOf } from "./record.js";
import { failure, isFailure, type Loader, type LoadFailure, type SourceId } from "./sources.js";

export type Upserted = "added" | "updated" | "unchanged";

/** Where records go. The database writer lives with the API; tests use a map. */
export interface Writer {
  upsert(record: AuthorityRecord): Promise<Upserted>;
  finish(source: SourceId, summary: SyncSummary): Promise<void>;
}

export interface SyncSummary {
  source: SourceId;
  added: number;
  updated: number;
  unchanged: number;
  failed: LoadFailure[];
}

/** Discover, fetch, normalise and write, one record at a time; a bad item never stops the rest. */
export async function sync(
  loader: Loader,
  writer: Writer,
  log: (line: string) => void = () => {},
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    source: loader.source,
    added: 0,
    updated: 0,
    unchanged: 0,
    failed: [],
  };
  for await (const item of loader.records()) {
    if (isFailure(item)) {
      summary.failed.push(item);
      log(`failed ${item.failed}: ${item.reason}`);
      continue;
    }
    const checked = authorityRecord.safeParse(item);
    if (!checked.success || sourceOf(item.ref) !== loader.source) {
      summary.failed.push({ failed: item.ref, reason: "record does not fit this source" });
      log(`failed ${item.ref}: record does not fit this source`);
      continue;
    }
    try {
      const outcome = await writer.upsert(checked.data);
      summary[outcome]++;
      log(`${outcome} ${item.ref}`);
    } catch (err) {
      summary.failed.push(failure(item.ref, err));
      log(`failed ${item.ref}`);
    }
  }
  await writer.finish(loader.source, summary);
  return summary;
}

/**
 * Records already on disk, for air-gapped installs and fixtures: every `.json`
 * file in a folder, each holding one record or a list of them.
 */
export function createFileLoader(source: SourceId, folder: string): Loader {
  return {
    source,
    async *records() {
      const names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort();
      for (const name of names) {
        let items: unknown[];
        try {
          const parsed: unknown = JSON.parse(await readFile(join(folder, name), "utf8"));
          items = Array.isArray(parsed) ? parsed : [parsed];
        } catch (err) {
          yield failure(name, err);
          continue;
        }
        for (const [i, item] of items.entries()) {
          const record = authorityRecord.safeParse(item);
          if (record.success) yield record.data;
          else yield { failed: `${name}#${i}`, reason: "not an authority record" };
        }
      }
    },
  };
}
