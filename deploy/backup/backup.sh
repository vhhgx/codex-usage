#!/usr/bin/env bash
set -Eeuo pipefail

: "${NUXT_DATABASE_URL:?set NUXT_DATABASE_URL}"
: "${NUXT_S3_ENDPOINT:?set NUXT_S3_ENDPOINT}"
: "${NUXT_S3_BUCKET:?set NUXT_S3_BUCKET}"
: "${NUXT_S3_ACCESS_KEY_ID:?set NUXT_S3_ACCESS_KEY_ID}"
: "${NUXT_S3_SECRET_ACCESS_KEY:?set NUXT_S3_SECRET_ACCESS_KEY}"

backup_root="${BACKUP_DIR:-/backups}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging="${backup_root}/.${timestamp}.partial"
target="${backup_root}/${timestamp}"

mkdir -p "${backup_root}"
exec 9>"${backup_root}/.backup.lock"
flock -n 9 || { echo "another backup is running" >&2; exit 1; }
trap 'rm -rf "${staging}"' EXIT
mkdir -p "${staging}/objects"

pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  --file="${staging}/database.dump" "${NUXT_DATABASE_URL}"

mc alias set source "${NUXT_S3_ENDPOINT}" "${NUXT_S3_ACCESS_KEY_ID}" "${NUXT_S3_SECRET_ACCESS_KEY}" >/dev/null
mc mirror --overwrite "source/${NUXT_S3_BUCKET}" "${staging}/objects"

object_count="$(find "${staging}/objects" -type f | wc -l | tr -d ' ')"
database_bytes="$(wc -c < "${staging}/database.dump" | tr -d ' ')"
cat > "${staging}/manifest.json" <<EOF
{"createdAt":"$(date -u +%FT%TZ)","format":1,"databaseBytes":${database_bytes},"objectCount":${object_count},"bucket":"${NUXT_S3_BUCKET}"}
EOF

(
  cd "${staging}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
mv "${staging}" "${target}"
trap - EXIT

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  tar -C "${backup_root}" -czf - "${timestamp}" | age -r "${BACKUP_AGE_RECIPIENT}" -o "${target}.tar.gz.age"
  rm -rf "${target}"
  target="${target}.tar.gz.age"
fi

find "${backup_root}" -mindepth 1 -maxdepth 1 \( -type d -o -name '*.tar.gz.age' \) -mtime "+${retention_days}" -exec rm -rf {} +
echo "backup=${target}"
