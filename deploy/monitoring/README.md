# Zephyr Hub monitoring

The host-managed Hong Kong Compose stack exposes the authenticated
`/api/metrics` endpoint to the optional `monitoring` profile. Put the same token
used by `NUXT_METRICS_TOKEN` in
`/root/apps/zephry-hub/deploy/hong-kong/.metrics-token`, then start Prometheus:

```sh
printf '%s' '<NUXT_METRICS_TOKEN value>' > /root/apps/zephry-hub/deploy/hong-kong/.metrics-token
chmod 644 /root/apps/zephry-hub/deploy/hong-kong/.metrics-token
HUB_ENV_FILE=/root/apps/zephry-hub/deploy/hong-kong/.env docker compose --env-file /root/apps/zephry-hub/deploy/hong-kong/.env -f /root/apps/zephry-hub/deploy/hong-kong/docker-compose-hongkong.yml --profile monitoring up -d
```

The file is stored below `/root`, and mode `0644` lets the unprivileged
Prometheus container read the bind-mounted token. Do not place it in a
world-traversable directory.

Prometheus remains on the private `hub-internal` network. The included rules are
provider-neutral; connect Prometheus to an existing Alertmanager when a second,
independent notification path is required. Zephyr Hub's signed Webhook alerts
continue to work without Prometheus.
