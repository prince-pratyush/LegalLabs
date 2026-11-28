# Backup and restore

A backup is one encrypted file holding the database (the app's and Temporal's), every stored
file, and your `.env` and `app.env`. It is encrypted with `LEGALLABS_BACKUP_PASSPHRASE`.
Run these in `infra/compose`.

CI rehearses the commands below: back up, delete a file, restore into a clean stack and check
that the file stayed deleted. It has not been rehearsed on a rented server or at real size.

## Back up

<!-- ci:backup -->
```bash
./legallabs backup create
```

Backups land in `infra/compose/backups`, and those older than `LEGALLABS_BACKUP_KEEP_DAYS`
(35) are removed. **Copy them off the server**: a backup on the same disk is lost with it.
Keep them at least as long as your longest retention period.

To run it every night, add to your crontab:

```text
15 2 * * * /path/to/LegalLabs/infra/compose/legallabs backup create >> /var/log/legallabs-backup.log 2>&1
```

## Keep the record of deletions

A restored backup must not bring back what was deleted after it was taken. The record of what
was deleted (ids and times, no names or content) lives in the database, so a lost server takes
it along. Export it often, and copy it off the server too:

<!-- ci:ledger -->
```bash
./legallabs backup ledger
```

An hourly cron job is reasonable. Deletions made after your last copy of the record cannot be
replayed if the server is lost.

## Check a backup

<!-- ci:verify -->
```bash
./legallabs backup verify "$BACKUP"
```

It restores into a scratch database, checks row counts, the checksum of every file, that each
document's file is there and that the audit trail's hash chains are unbroken, then drops the
scratch database. `BACKUP` is a file such as `backups/legallabs-20261128T021500Z.tar.gpg`.
Run it after setting up, after each upgrade and at least monthly.

## Restore

On a new server, first install as in the [install guide](install.md) steps 1 and 3, **using
your saved copy of `.env`** instead of running `init-env.sh`, and the same version of the code
as the backup or newer. Then copy the backup and the newest record into `infra/compose/backups`.

On the same server, nothing needs preparing: the record is read from the database being
replaced.

<!-- ci:restore -->
```bash
./legallabs backup restore "$BACKUP" --ledger "$RECORD"
```

The restore stops the app, replaces the database and files, brings the schema up to the code's
version, **deletes again what the record says was deleted after the backup** (SEC-030), signs
everyone out, writes `restore.completed` to the audit trail, lists what it deleted and only
then starts the app. If anything fails the app stays stopped.

Without a record it refuses. `--accept-unreplayed-deletions` restores anyway; deleted items
will come back, so tell whoever is responsible for retention.

If you have lost `.env` but kept the passphrase:

```bash
LEGALLABS_BACKUP_PASSPHRASE=... ./legallabs backup keys backups/<backup>
```

## What a restore does not replay

Only deletion of vaults, folders, documents, threads and review tables is replayed. Check by
hand, from your records, anything else changed after the backup point:

- people removed or whose roles changed, and ethical walls added: **review these before
  letting anyone back in**;
- API tokens revoked since the backup (they work again);
- deleted memories, library items, drafts' earlier versions, agents, playbooks and Spaces;
- retention holds set or released.

Scheduled work held by Temporal returns to the backup point and may run again. Audit anchors
written after the backup point will not match the restored chain; that is expected.

## Limits

- The database is dumped, not streamed: you lose what was written since the last backup.
  Continuous WAL archiving (06-security 5.9) is not set up.
- Backups are staged inside a container before encryption, so the Docker disk needs room for
  about twice the data.
