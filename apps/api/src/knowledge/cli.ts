#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Embedder, embedderFromEnv } from "@legallabs/embed";
import {
  createFileLoader,
  DEFAULT_SUBSET,
  isSourceId,
  type Loader,
  type LoaderEnv,
  loaderFor,
  type Subset,
  subsetSchema,
  sync,
} from "@legallabs/knowledge";
import pg from "pg";
import { createKnowledge } from "./knowledge.js";

const USAGE = `usage:
  legallabs-knowledge sync <us_caselaw|eurlex|edgar> [subset.json]
  legallabs-knowledge load <us_caselaw|eurlex|edgar> <folder of record .json files>

env: DATABASE_URL (required); TEI_URL or OLLAMA_EMBED_URL (optional, adds embeddings);
     COURTLISTENER_TOKEN (optional); SEC_USER_AGENT (required for an edgar sync)`;

export interface KnowledgeIo {
  env: LoaderEnv & { DATABASE_URL?: string | undefined };
  embedder: Embedder | null;
  readFile(path: string): Promise<string>;
  print(line: string): void;
}

async function readSubset(io: KnowledgeIo, path: string): Promise<Subset | null> {
  try {
    const parsed = subsetSchema.safeParse(JSON.parse(await io.readFile(path)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function run(args: string[], io: KnowledgeIo): Promise<number> {
  const [command, source, path] = args;
  if ((command !== "sync" && command !== "load") || !source || !isSourceId(source)) {
    io.print(USAGE);
    return 2;
  }
  if (command === "load" && !path) {
    io.print(USAGE);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.print("failed: DATABASE_URL is not set");
    return 2;
  }
  let loader: Loader | null;
  if (command === "load") {
    loader = createFileLoader(source, path as string);
  } else {
    const subset = path ? await readSubset(io, path) : DEFAULT_SUBSET;
    if (subset === null) {
      io.print("failed: the subset file is not a list of identifiers in the expected shape");
      return 1;
    }
    loader = loaderFor(source, subset, io.env);
    if (loader === null) {
      io.print("failed: an edgar sync needs SEC_USER_AGENT naming you and a contact email");
      return 2;
    }
  }

  const pool = new pg.Pool({ connectionString: io.env.DATABASE_URL, max: 2 });
  try {
    const writer = createKnowledge(pool, { embedder: io.embedder }).writer();
    const summary = await sync(loader, writer, io.print);
    io.print(
      `${summary.source}: ${summary.added} added, ${summary.updated} updated, ` +
        `${summary.unchanged} unchanged, ${summary.failed.length} failed`,
    );
    return summary.failed.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

// Resolved so the check still holds when run through a package manager's symlink.
const entry = process.argv[1];
if (entry && (await realpath(entry)) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    embedder: embedderFromEnv(process.env),
    readFile: (file) => readFile(file, "utf8"),
    print: (line) => console.log(line),
  });
}
