FROM minio/minio:latest AS minio-client

FROM postgres:16-alpine

RUN apk add --no-cache bash coreutils redis age flock
COPY --from=minio-client /usr/bin/mc /usr/local/bin/mc

COPY backup.sh restore.sh verify-backup.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/verify-backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
