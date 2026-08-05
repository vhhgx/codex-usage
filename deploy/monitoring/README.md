# Zephyr Hub monitoring

The Hong Kong Compose stack exposes the authenticated `/api/metrics` endpoint to
the optional `monitoring` profile. Put the same token used by
`NUXT_METRICS_TOKEN` in `deploy/hong-kong/.metrics-token`, then start Prometheus:

```sh
docker compose --profile monitoring up -d
```

Prometheus remains on the private `hub-internal` network. The included rules are
provider-neutral; connect Prometheus to an existing Alertmanager when a second,
independent notification path is required. Zephyr Hub's signed Webhook alerts
continue to work without Prometheus.
