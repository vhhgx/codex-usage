// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    cpaBaseUrl: '',
    cpaManagementKey: '',
    cpampBaseUrl: '',
    cpampAdminKey: '',
    accountIdSecret: '',
    public: {
      appName: 'Zephyr Console'
    }
  },
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'Zephyr Console',
      meta: [
        {
          name: 'description',
          content: '安全查询 Codex 配额与 API Key 调用用量。'
        },
        { name: 'color-scheme', content: 'light dark' }
      ]
    }
  },
  typescript: {
    typeCheck: true
  }
})
