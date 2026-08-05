// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  devServer: {
    host: '0.0.0.0'
  },
  vite: {
    server: {
      allowedHosts: ['nas.vhhg.pub']
    }
  },
  routeRules: {
    '/': { redirect: '/login' },
    '/admin/login': { redirect: '/login' }
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    databaseUrl: '',
    redisUrl: '',
    encryptionKey: '',
    hubKeyPepper: '',
    hubKeyEncryptionActiveVersion: 'v1',
    hubKeyEncryptionKeys: '',
    adminUsername: '',
    adminPassword: '',
    s3Endpoint: '',
    s3Region: 'us-east-1',
    s3Bucket: 'zephyr-hub-logs',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3ForcePathStyle: true,
    hubRequestTimeoutMs: 120000,
    hubCircuitFailureThreshold: 3,
    hubCircuitCooldownMs: 30000,
    trustedProxyCidrs: '',
    metricsToken: '',
    operationsToken: '',
    alertWebhookUrl: '',
    alertWebhookSecret: '',
    alertFailureRate: 0.2,
    alertMinimumRequests: 20,
    alertStreamAbortRate: 0.1,
    alertFirstByteMs: 5000,
    alertPendingRequests: 100,
    alertMemoryRssBytes: 805306368,
    alertCooldownSeconds: 1800,
    cpaBaseUrl: '',
    cpaManagementKey: '',
    cpampBaseUrl: '',
    cpampAdminKey: '',
    sub2apiBaseUrl: '',
    sub2apiAdminApiKey: '',
    accountIdSecret: '',
    public: {
      appName: 'Zephyr Hub'
    }
  },
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'Zephyr Hub',
      meta: [
        {
          name: 'description',
          content: '统一管理、调度和观测 OpenAI 兼容模型渠道。'
        },
        { name: 'color-scheme', content: 'light dark' }
      ]
    }
  },
  typescript: {
    typeCheck: true
  }
})
