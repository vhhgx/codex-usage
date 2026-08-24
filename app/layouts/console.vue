<script setup lang="ts">
import { IconDatabase, IconGauge, IconKey, IconLock, IconSpeakerphone, IconUserShield } from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'
const session = useState<AdminSessionView | null>('auth-session', () => null)
const loggingOut = ref(false)
const navigation = [
  { to: '/console', label: '个人首页', icon: IconGauge, exact: true },
  { to: '/console/keys', label: 'Keys 与用量', icon: IconKey },
  { to: '/console/resources', label: '套餐与资源', icon: IconUserShield },
  { to: '/console/password', label: '修改密码', icon: IconLock },
  { to: '/console/announcements', label: '公告', icon: IconSpeakerphone },
  { to: '/console/logs', label: '请求记录', icon: IconDatabase }
]
const navigationGroups = [{ label: '个人空间', items: navigation }]
async function logout() { loggingOut.value = true; try { await $fetch('/api/auth/logout', { method: 'POST' }); session.value = { authenticated: false, user: null }; await navigateTo('/login') } finally { loggingOut.value = false } }
</script>
<template>
  <AppWorkspaceShell
    home="/console"
    environment-label="USER CONSOLE"
    :groups="navigationGroups"
    :username="session?.user?.username || 'User'"
    role="user"
    :logging-out="loggingOut"
    @logout="logout"
  ><slot /><ConsolePasswordGate /></AppWorkspaceShell>
</template>
