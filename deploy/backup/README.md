# Backup and recovery

The backup container creates a PostgreSQL custom-format dump and a point-in-time
copy of the encrypted MinIO objects. Every snapshot includes a SHA-256 manifest
and is published only after all steps succeed. The default retention is 14 days.

The commands below target the host-managed Hong Kong stack at
`/root/apps/zephry-hub`. The explicit environment and Compose paths are
required because `docker-compose-hongkong.yml` is not a default Compose file.

Run a backup:

```sh
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml --profile backup run --rm backup
```

Verify a snapshot without modifying production:

```sh
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml --profile backup run --rm --entrypoint verify-backup.sh backup /backups/20260730T032000Z
```

Before restore, enable traffic drain and wait for `activeRequests` to reach zero.
The restore command is deliberately destructive and requires the target database
name in `RESTORE_CONFIRM`:

```sh
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml --profile backup run --rm \
  -e RESTORE_CONFIRM=zephyr_hub \
  --entrypoint restore.sh backup /backups/20260730T032000Z
```

After restore, start the app so runtime migrations run, disable traffic drain,
then execute usage reconciliation. Test a restore quarterly in an isolated stack.
The operational target is RPO <= 24 hours and RTO <= 60 minutes; shorten the
timer interval when those targets are insufficient.

```sh
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml up -d app
```

Set `BACKUP_AGE_RECIPIENT` to publish an encrypted `.tar.gz.age` artifact instead
of a directory. Decrypt and extract it into the backup volume before verification
or restore; keep the matching age identity outside the Hub server.

Install the nightly systemd timer from the same checkout:

```sh
sudo install -m 0644 /root/apps/zephry-hub/deploy/backup/zephyr-hub-backup.service /etc/systemd/system/zephyr-hub-backup.service
sudo install -m 0644 /root/apps/zephry-hub/deploy/backup/zephyr-hub-backup.timer /etc/systemd/system/zephyr-hub-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now zephyr-hub-backup.timer
sudo systemctl list-timers zephyr-hub-backup.timer --no-pager
```
