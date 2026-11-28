#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createS3Store, listKeys, s3ConfigFromEnv } from "@legallabs/storage";
import {
  type Bucket,
  createBackup,
  exportLedger,
  type Ledger,
  openArchive,
  restoreBackup,
  sealArchive,
  verifyBackup,
} from "./backup.js";

const USAGE = `usage:
  legallabs backup create
  legallabs backup verify <backup>
  legallabs backup ledger                 the record of deletions, to keep beside backups
  legallabs backup restore <backup> [--ledger <record>] [--accept-unreplayed-deletions]
  legallabs backup keys <backup>          the settings and keys it holds`;

export interface BackupIo {
  env: Record<string, string | undefined>;
  print(line: string): void;
  /** Left out, the bucket the S3_* settings name. */
  bucket?: Bucket;
}

function s3Bucket(env: BackupIo["env"]): Bucket {
  const config = s3ConfigFromEnv(env);
  const store = createS3Store(config);
  return {
    list: () => listKeys(config),
    get: (key) => store.get(key),
    put: async (key, bytes) => void (await store.putIfAbsent(key, bytes)),
    delete: (key) => store.delete(key),
  };
}

const stamp = () => new Date().toISOString().replace(/[-:]|\.\d+/g, "");

// Staging holds the data in the clear, so it lives only as long as the work.
async function staged<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "legallabs-stage-"));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NAMED = /^(legallabs|deletions)-(\d{4})(\d{2})(\d{2})T\d{6}Z\.tar\.gpg$/;

function prune(dir: string, days: number, print: BackupIo["print"]) {
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  for (const name of readdirSync(dir)) {
    const [, , year, month, day] = NAMED.exec(name) ?? [];
    if (!year || Date.parse(`${year}-${month}-${day}T23:59:59Z`) >= cutoff) continue;
    rmSync(join(dir, name));
    print(`ok: removed ${name}, older than ${days} days`);
  }
}

export async function run(args: string[], io: BackupIo): Promise<number> {
  const [command, file, ...flags] = args;
  const needsFile = command === "verify" || command === "restore" || command === "keys";
  if (!["create", "verify", "ledger", "restore", "keys"].includes(command ?? "")) {
    io.print(USAGE);
    return 2;
  }
  if (needsFile && !file) {
    io.print(USAGE);
    return 2;
  }
  process.umask(0o077);
  try {
    const need = (name: string) => {
      const value = io.env[name];
      if (!value) throw new Error(`${name} is not set`);
      return value;
    };
    const passphrase = need("LEGALLABS_BACKUP_PASSPHRASE");
    const databaseUrl = need("DATABASE_URL");
    const out = io.env.BACKUP_DIR || "/backups";
    const config = io.env.CONFIG_DIR || "/config";
    // Never under a week, however it is set (06-security 5.9).
    const days = Math.max(7, Number(io.env.LEGALLABS_BACKUP_KEEP_DAYS) || 35);
    mkdirSync(out, { recursive: true });
    const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

    const record = async () => {
      const ledger = await exportLedger(databaseUrl);
      if (!ledger) throw new Error("this database has no record of deletions to export");
      const target = join(out, `deletions-${stamp()}.tar.gpg`);
      await staged(async (dir) => {
        writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger));
        await sealArchive(dir, target, passphrase);
      });
      chmodSync(target, 0o600);
      io.print(`ok: ${ledger.entries.length} deletions recorded in ${target}`);
    };

    if (command === "ledger") {
      await record();
      return 0;
    }

    if (command === "create") {
      const target = join(out, `legallabs-${stamp()}.tar.gpg`);
      await staged(async (dir) => {
        await createBackup({
          databaseUrl,
          databases: [database, "temporal", "temporal_visibility"],
          bucket: io.bucket ?? s3Bucket(io.env),
          dir,
          print: io.print,
        });
        // The settings and keys, without which sealed secrets in the dump can't be read.
        for (const name of [".env", "app.env"]) {
          if (!existsSync(join(config, name))) continue;
          mkdirSync(join(dir, "config"), { recursive: true });
          cpSync(join(config, name), join(dir, "config", name));
        }
        await sealArchive(dir, target, passphrase);
      });
      chmodSync(target, 0o600);
      io.print(`ok: backup written to ${target}`);
      prune(out, days, io.print);
      return 0;
    }

    return await staged(async (dir) => {
      await openArchive(file as string, dir, passphrase);
      if (command === "keys") {
        const target = join(out, `keys-${stamp()}`);
        mkdirSync(target);
        for (const name of readdirSync(join(dir, "config"))) {
          cpSync(join(dir, "config", name), join(target, name));
          chmodSync(join(target, name), 0o600);
        }
        io.print(`ok: settings and keys written to ${target}. Move them and delete the folder.`);
        return 0;
      }
      if (command === "verify") {
        const report = await verifyBackup({ databaseUrl, dir, print: io.print });
        for (const problem of report.problems) io.print(`problem: ${problem}`);
        if (report.problems.length) return 1;
        io.print(
          `ok: the backup restores: ${report.rows} rows, ${report.files} files, ` +
            `${report.audit_events} audit events in unbroken chains`,
        );
        return 0;
      }
      const at = flags.indexOf("--ledger");
      let ledger: Ledger | null = null;
      if (at > -1) {
        const source = flags[at + 1];
        if (!source) throw new Error("--ledger needs the record's file name");
        ledger = await staged(async (opened) => {
          await openArchive(source, opened, passphrase);
          return JSON.parse(readFileSync(join(opened, "ledger.json"), "utf8")) as Ledger;
        });
      }
      const report = await restoreBackup({
        databaseUrl,
        bucket: io.bucket ?? s3Bucket(io.env),
        dir,
        ledger,
        acceptUnreplayed: flags.includes("--accept-unreplayed-deletions"),
        print: io.print,
      });
      for (const r of report.replayed) {
        io.print(`replayed: ${r.action} ${r.object_type} ${r.object_id}`);
      }
      io.print(
        report.deletions_known_to
          ? `ok: restored to ${report.backup_point}; deletions known up to ${report.deletions_known_to} were applied again`
          : `warning: restored to ${report.backup_point} WITHOUT replaying any later deletion`,
      );
      return 0;
    });
  } catch (err) {
    io.print(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    print: (line) => console.log(line),
  });
}
