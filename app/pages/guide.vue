<script setup lang="ts">
import {
  IconCheck,
  IconCopy,
  IconInfoCircle,
  IconTerminal2
} from '@tabler/icons-vue'

type System = 'unix' | 'windows'

useSeoMeta({
  title: '使用方法 | Zephyr Console',
  description: '配置 Codex CLI，通过 Sub2API 使用模型服务。'
})

const system = ref<System>('unix')
const copied = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const baseUrl = 'https://sub.vhhg.me/v1'
const apiKey = 'YOUR_API_KEY'

const codexPath = computed(() => system.value === 'windows'
  ? '%USERPROFILE%\\.codex'
  : '~/.codex')

const codexConfig = computed(() => `model_provider = "OpenAI"
model = "gpt-5.6-sol"
review_model = "gpt-5.6-sol"
model_reasoning_effort = "high"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true

[features]
goals = true`)

const codexAuth = computed(() => `{
  "OPENAI_API_KEY": "${apiKey}"
}`)

async function copy(text: string, id: string) {
  await navigator.clipboard.writeText(text)
  copied.value = id
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = '' }, 1800)
}

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="guide-page page-width">
    <section class="page-heading page-heading--split guide-heading">
      <div>
        <span class="eyebrow">API SETUP</span>
        <h1>使用方法</h1>
      </div>
      <div class="guide-segment" role="group" aria-label="操作系统">
        <button type="button" :aria-pressed="system === 'unix'" @click="system = 'unix'">macOS / Linux</button>
        <button type="button" :aria-pressed="system === 'windows'" @click="system = 'windows'">Windows</button>
      </div>
    </section>

    <section class="guide-content" aria-labelledby="codex-guide-title">
      <header class="guide-content__header">
        <div class="guide-content__title">
          <IconTerminal2 :size="25" :stroke-width="1.6" />
          <div>
            <h2 id="codex-guide-title">配置 Codex CLI</h2>
            <p>将以下文件添加到 Codex CLI 配置目录。</p>
          </div>
        </div>
        <div class="guide-note">
          <IconInfoCircle :size="18" :stroke-width="1.7" />
          <p>请确保配置目录存在。macOS/Linux 可运行 <code>mkdir -p ~/.codex</code>；Windows 可按 Win+R 后输入 <code>%userprofile%\.codex</code>。将 <code>YOUR_API_KEY</code> 替换为你的 Sub2API 密钥。</p>
        </div>
      </header>

      <div class="guide-code-grid">
        <article class="guide-code guide-code--wide">
          <header>
            <span>{{ codexPath }}/config.toml</span>
            <button type="button" :aria-label="copied === 'codex-config' ? '已复制 config.toml' : '复制 config.toml'" @click="copy(codexConfig, 'codex-config')">
              <IconCheck v-if="copied === 'codex-config'" :size="17" />
              <IconCopy v-else :size="17" />
              <span>{{ copied === 'codex-config' ? '已复制' : '复制' }}</span>
            </button>
          </header>
          <pre><code>{{ codexConfig }}</code></pre>
        </article>

        <article class="guide-code">
          <header>
            <span>{{ codexPath }}/auth.json</span>
            <button type="button" :aria-label="copied === 'codex-auth' ? '已复制 auth.json' : '复制 auth.json'" @click="copy(codexAuth, 'codex-auth')">
              <IconCheck v-if="copied === 'codex-auth'" :size="17" />
              <IconCopy v-else :size="17" />
              <span>{{ copied === 'codex-auth' ? '已复制' : '复制' }}</span>
            </button>
          </header>
          <pre><code>{{ codexAuth }}</code></pre>
        </article>
      </div>
    </section>
  </div>
</template>
