<script setup lang="ts">
import { IconChartHistogram, IconDatabase, IconGauge, IconKey, IconRoute, IconServerBolt, IconSpeakerphone, IconUsersGroup, IconUserShield } from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'
const session = useState<AdminSessionView | null>('auth-session', () => null)
const loggingOut = ref(false)
const navigation = [
  { to: '/console', label: '个人首页', icon: IconGauge, exact: true },
  { to: '/console/keys', label: '我的 Keys', icon: IconKey },
  { to: '/console/usage', label: '我的用量', icon: IconChartHistogram },
  { to: '/console/groups', label: '权限与额度', icon: IconUsersGroup },
  { to: '/console/pool', label: '专属号池', icon: IconUserShield },
  { to: '/console/relays', label: '我的中转', icon: IconServerBolt },
  { to: '/console/models', label: '可用模型', icon: IconRoute },
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
  ><slot /></AppWorkspaceShell>
</template>
