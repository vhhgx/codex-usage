<script setup lang="ts">
import { IconLock } from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'

const session = useState<AdminSessionView | null>('auth-session', () => null)
const toast = useAppToast()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const error = ref('')
const busy = ref(false)
const required = computed(() => session.value?.user?.role === 'user' && session.value.user.mustChangePassword === true)
function ignoreClose() {}

async function save() {
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/change-password', { method: 'POST', body: { currentPassword: currentPassword.value, newPassword: newPassword.value } })
    if (session.value?.user) session.value.user.mustChangePassword = false
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    toast.show('密码已更新', 'success')
    if (useRoute().path === '/console/password') await navigateTo('/console')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '修改密码失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppDrawer v-if="required" :open="true" kicker="ACCOUNT SECURITY" title="请先修改密码" @close="ignoreClose">
    <form class="admin-form console-password-gate" @submit.prevent="save">
      <p class="console-password-gate__notice">当前登录使用的是初始或管理员重置密码。为了保护账号，必须先设置新密码才能继续使用。</p>
      <label><span>当前密码</span><input v-model="currentPassword" type="password" autocomplete="current-password" required></label>
      <label><span>新密码</span><input v-model="newPassword" type="password" minlength="8" autocomplete="new-password" required><small>至少 8 位字符，且不能与当前密码相同。</small></label>
      <label><span>确认新密码</span><input v-model="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label>
      <p v-if="error" class="form-error">{{ error }}</p>
      <footer><button class="button button--primary" type="submit" :disabled="busy"><IconLock :size="16" />{{ busy ? '保存中' : '确认修改' }}</button></footer>
    </form>
  </AppDrawer>
</template>

<style scoped>
.console-password-gate { gap:1rem; }
.console-password-gate__notice { margin:0; padding:.75rem .85rem; border:1px solid var(--line-subtle); color:var(--text-muted); background:var(--surface-soft); font-size:.75rem; line-height:1.6; }
.console-password-gate small { color:var(--text-muted); font-size:.68rem; }
.console-password-gate footer { display:flex; justify-content:flex-end; }
</style>
