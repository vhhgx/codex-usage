#!/usr/bin/env bash
set -Eeuo pipefail

: "${NUXT_DATABASE_URL:?set NUXT_DATABASE_URL}"
: "${NUXT_S3_ENDPOINT:?set NUXT_S3_ENDPOINT}"
: "${NUXT_S3_BUCKET:?set NUXT_S3_BUCKET}"
: "${NUXT_S3_ACCESS_KEY_ID:?set NUXT_S3_ACCESS_KEY_ID}"
: "${NUXT_S3_SECRET_ACCESS_KEY:?set NUXT_S3_SECRET_ACCESS_KEY}"

backup="${1:?usage: restore.sh BACKUP_DIRECTORY}"
database_name="$(psql "${NUXT_DATABASE_URL}" -Atqc 'select current_database()')"
[[ "${RESTORE_CONFIRM:-}" == "${database_name}" ]] || {
  echo "set RESTORE_CONFIRM=${database_name} to authorize destructive restore" >&2
  exit 1
}

/usr/local/bin/verify-backup.sh "${backup}"
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error \
  --dbname="${NUXT_DATABASE_URL}" "${backup}/database.dump"

mc alias set target "${NUXT_S3_ENDPOINT}" "${NUXT_S3_ACCESS_KEY_ID}" "${NUXT_S3_SECRET_ACCESS_KEY}" >/dev/null
mc mirror --overwrite --remove "${backup}/objects" "target/${NUXT_S3_BUCKET}"

if [[ -n "${NUXT_REDIS_URL:-}" ]]; then
  redis-cli -u "${NUXT_REDIS_URL}" FLUSHDB >/dev/null
fi
echo "restored=${backup} database=${database_name}"
