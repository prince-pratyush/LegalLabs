#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { type AuditAnchor, type AuditRow, readAuditChain, verifyAuditChain } from "./audit.js";

export interface Io {
  readFile(path: string): string;
  print(line: string): void;
  databaseUrl: string | undefined;
}

const USAGE = `usage:
  legallabs audit verify <events.jsonl> [anchors.jsonl]
  legallabs audit export <workspace-id>`;

const parseLines = <T>(text: string): T[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

function verify(io: Io, eventsPath: string, anchorsPath: string | undefined): number {
  const rows = parseLines<AuditRow>(io.readFile(eventsPath));
  if (rows.length === 0) {
    io.print("failed: no events to verify");
    return 1;
  }
  const anchors = anchorsPath ? parseLines<AuditAnchor>(io.readFile(anchorsPath)) : [];
  const result = verifyAuditChain(rows, anchors);
  if (result.ok) {
    io.print(`ok: ${result.events} events verified`);
    return 0;
  }
  io.print(`failed at event ${result.seq}: ${result.reason}`);
  return 1;
}

async function exportChain(io: Io, workspaceId: string): Promise<number> {
  if (!io.databaseUrl) {
    io.print("failed: DATABASE_URL is not set");
    return 2;
  }
  const client = new pg.Client({ connectionString: io.databaseUrl });
  await client.connect();
  try {
    for (const row of await readAuditChain(client, workspaceId)) io.print(JSON.stringify(row));
  } finally {
    await client.end();
  }
  return 0;
}

export async function run(args: string[], io: Io): Promise<number> {
  const [group, command, first, second] = args;
  if (group === "audit" && command === "verify" && first) return verify(io, first, second);
  if (group === "audit" && command === "export" && first) return exportChain(io, first);
  io.print(USAGE);
  return 2;
}

// Resolved so the check still holds when run through a package manager's symlink.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, "utf8"),
    print: (line) => console.log(line),
    databaseUrl: process.env.DATABASE_URL,
  });
}
