#!/usr/bin/env bash
# Runs the commands a guide marks with <!-- ci:name -->, in the order named, in one shell:
#   run-guide.sh docs/deploy/install.md configure start admin
# What CI runs is therefore what the reader is told to run.
set -euo pipefail

guide=$1
shift
script=""
for name in "$@"; do
  block=$(awk -v mark="<!-- ci:$name -->" '
    $0 == mark { armed = 1; next }
    armed && /^```bash$/ { inside = 1; armed = 0; next }
    inside && /^```$/ { exit }
    inside { print }
  ' "$guide")
  if [ -z "$block" ]; then
    echo "no commands marked ci:$name in $guide" >&2
    exit 1
  fi
  script+="$block"$'\n'
done
printf '%s' "$script"
printf '%s' "$script" | bash -euo pipefail
