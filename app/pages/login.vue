<script setup lang="ts">
import {
  IconActivityHeartbeat,
  IconArrowRight,
  IconKey,
  IconLoader2,
  IconLock,
  IconUser
} from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'

type LoginPhase = 'idle' | 'authenticating' | 'redirecting'

definePageMeta({ layout: false })
useSeoMeta({ title: '登录 | Zephyr Hub' })

const route = useRoute()
const loginForm = useTemplateRef<HTMLFormElement>('loginForm')
const phase = ref<LoginPhase>('idle')
const error = ref('')
const session = useState<AdminSessionView | null>('auth-session', () => null)
const busy = computed(() => phase.value !== 'idle')
const buttonLabel = computed(() => {
  if (phase.value === 'authenticating') return '正在验证'
  if (phase.value === 'redirecting') return '正在进入'
  return '登录'
})
const feedback = computed(() => {
  if (phase.value === 'authenticating') return '正在验证账号信息，请稍候'
  if (phase.value === 'redirecting') return '登录成功，正在进入工作区'
  return ''
})

// Queue an early submit instead of letting the enabled SSR form navigate natively.
onPrehydrate(() => {
  const form = document.querySelector('[data-login-form]')
  form?.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!Reflect.get(form, '__loginHydrated')) {
      Reflect.set(form, '__loginSubmitPending', true)
    }
  })
})

onMounted(() => {
  if (!loginForm.value) return
  Reflect.set(loginForm.value, '__loginHydrated', true)
  if (Reflect.get(loginForm.value, '__loginSubmitPending')) {
    Reflect.deleteProperty(loginForm.value, '__loginSubmitPending')
    void login()
  }
})

async function paintPendingState() {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function login() {
  if (busy.value || !loginForm.value) return

  const formData = new FormData(loginForm.value)
  const username = String(formData.get('username') || '')
  const password = String(formData.get('password') || '')

  phase.value = 'authenticating'
  error.value = ''
  await paintPendingState()

  try {
    const result = await $fetch<{
      user: NonNullable<AdminSessionView['user']>
      home: string
    }>('/api/auth/login', {
      method: 'POST',
      body: { username, password }
    })

    session.value = { authenticated: true, user: result.user }
    phase.value = 'redirecting'
    await paintPendingState()

    const requested = result.user.mustChangePassword
      ? '/console/password?required=1'
      : typeof route.query.redirect === 'string' ? route.query.redirect : ''
    const allowedPrefix = result.user.role === 'user' ? '/console' : '/admin'
    const redirect = requested.startsWith(allowedPrefix) ? requested : result.home
    await navigateTo(redirect, { replace: true })
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '登录失败'
    phase.value = 'idle'
  }
}
</script>

<template>
  <main class="admin-login">
    <AppThemeButton class="admin-login__theme" />
    <section class="admin-login__intro">
      <NuxtLink to="/" class="admin-login__brand">
        <IconActivityHeartbeat :size="24" />
        Zephyr Hub
      </NuxtLink>
      <div>
        <span>ACCESS PORTAL</span>
        <h1>模型与用量，<br>一处管理。</h1>
        <p>统一访问工作区、凭据、服务状态与请求记录。</p>
      </div>
      <small>OpenAI-compatible gateway</small>
    </section>

    <section class="admin-login__form-wrap">
      <form
        ref="loginForm"
        class="admin-login__form"
        data-login-form
        :aria-busy="busy"
        @submit.prevent="login"
      >
        <header>
          <IconKey :size="22" />
          <div>
            <h2>账号登录</h2>
            <p>进入 Zephyr Hub</p>
          </div>
        </header>

        <label>
          <span>用户名</span>
          <div>
            <IconUser :size="18" />
            <input name="username" autocomplete="username" required :disabled="busy">
          </div>
        </label>

        <label>
          <span>密码</span>
          <div>
            <IconLock :size="18" />
            <input
              name="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            >
          </div>
        </label>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>

        <button class="button button--primary button--full" type="submit" :disabled="busy">
          <IconLoader2 v-if="busy" class="is-spinning" :size="18" />
          <IconArrowRight v-else :size="18" />
          {{ buttonLabel }}
        </button>

        <p
          class="admin-login__feedback"
          :data-phase="phase"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {{ feedback }}
        </p>
      </form>
    </section>
  </main>
</template>
