# Upgrade

Upgrades mean a short outage: one server, stopped while the database changes. Migrations only
go forward. Run these in `infra/compose`.

CI migrates a populated database from an older release point and checks that rows, the audit
chains and row-level security survive. It does not yet upgrade a running install between two
published versions: there are none.

## Before

1. Read the release notes.
2. Back up and check the backup (see [backup and restore](backup.md)):

   ```bash
   ./legallabs backup create
   ./legallabs backup verify backups/<the new file>
   ```

3. Note the version you are on: `git rev-parse HEAD`.

## Upgrade

```bash
git fetch --tags
git checkout <new version>
docker compose --profile tools build
docker compose stop proxy api worker
docker compose up -d --wait --wait-timeout 900
```

`up` runs `bootstrap` first, which applies new migrations. The API refuses to start if the
result leaves a table without row-level security.

An install made before backups existed has no passphrase; add one first:

```bash
echo "LEGALLABS_BACKUP_PASSPHRASE=$(openssl rand -hex 32)" >> .env
```

Then check `docker compose ps`, sign in, and open a document.

## Going back

The old code cannot be relied on with the new database. Check out the old version, build, and
restore the backup taken before the upgrade:

```bash
git checkout <old version>
docker compose --profile tools build
./legallabs backup restore backups/<the backup>
```

On the same server the record of later deletions is read from the database being replaced, so
nothing deleted since comes back. A version older than the record itself cannot replay it.
