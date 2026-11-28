#!/bin/sh
# Writes .env with freshly generated secrets, readable by you only. Run once:
#   ./init-env.sh <domain> <email for the certificate authority, or "internal">
# Nothing secret is printed, and an existing file is never overwritten: losing
# LEGALLABS_SECRETS_KEY or LEGALLABS_MFA_KEY loses what they sealed.
set -eu

if [ $# -ne 2 ]; then
  echo "usage: ./init-env.sh <domain> <email|internal>" >&2
  exit 2
fi
# Newlines are turned into spaces first, so one argument can't slip a second setting in.
valid() { printf '%s' "$1" | LC_ALL=C tr '\n' ' ' | grep -Eqx "$2"; }
valid "$1" '[a-z0-9.-]+' || {
  echo "the domain is a plain host name, without https:// or a path" >&2
  exit 2
}
valid "$2" 'internal|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' || {
  echo "give an email address, or \"internal\"" >&2
  exit 2
}
command -v openssl >/dev/null || { echo "openssl is needed" >&2; exit 1; }

target=${ENV_FILE:-$(dirname "$0")/.env}
if [ -e "$target" ]; then
  echo "$target already exists; it is left as it is" >&2
  exit 1
fi

hex() { openssl rand -hex "$1"; }
key() { openssl rand -base64 32; }

umask 077
# Generated first, so a failing openssl leaves no half-written file.
postgres=$(hex 24)
api=$(hex 24)
temporal=$(hex 24)
s3_id=ll$(hex 8)
s3_secret=$(hex 32)
secrets_key=$(key)
mfa_key=$(key)
cat >"$target" <<ENV
LEGALLABS_DOMAIN=$1
LEGALLABS_TLS=$2
POSTGRES_PASSWORD=$postgres
LEGALLABS_DB_PASSWORD=$api
TEMPORAL_DB_PASSWORD=$temporal
S3_ACCESS_KEY_ID=$s3_id
S3_SECRET_ACCESS_KEY=$s3_secret
LEGALLABS_SECRETS_KEY=$secrets_key
LEGALLABS_MFA_KEY=$mfa_key
ENV
echo "wrote $target (mode 0600). Keep a copy somewhere safe, apart from your backups."
