#!/usr/bin/env bash
set -Eeuo pipefail

backup="${1:?usage: verify-backup.sh BACKUP_DIRECTORY}"
[[ -d "${backup}" ]] || { echo "backup directory does not exist: ${backup}" >&2; exit 1; }
[[ -f "${backup}/database.dump" && -f "${backup}/manifest.json" && -f "${backup}/SHA256SUMS" ]] || {
  echo "backup is incomplete" >&2
  exit 1
}
(
  cd "${backup}"
  sha256sum -c SHA256SUMS
)
pg_restore --list "${backup}/database.dump" >/dev/null
echo "verified=${backup}"
