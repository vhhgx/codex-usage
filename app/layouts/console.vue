<script setup lang="ts">
import { IconActivityHeartbeat, IconChartHistogram, IconDatabase, IconGauge, IconKey, IconLogout, IconRoute, IconSpeakerphone, IconUsersGroup } from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'
const route = useRoute()
const session = useState<AdminSessionView | null>('auth-session', () => null)
const loggingOut = ref(false)
const navigation = [
  { to: '/console', label: '个人首页', icon: IconGauge, exact: true },
  { to: '/console/keys', label: '我的 Keys', icon: IconKey },
  { to: '/console/usage', label: '我的用量', icon: IconChartHistogram },
  { to: '/console/groups', label: '权限与额度', icon: IconUsersGroup },
  { to: '/console/models', label: '可用模型', icon: IconRoute },
  { to: '/console/announcements', label: '公告', icon: IconSpeakerphone },
  { to: '/console/logs', label: '请求记录', icon: IconDatabase }
]
function active(item: typeof navigation[number]) { return item.exact ? route.path === item.to : route.path.startsWith(item.to) }
async function logout() { loggingOut.value = true; try { await $fetch('/api/auth/logout', { method: 'POST' }); session.value = { authenticated: false, user: null }; await navigateTo('/login') } finally { loggingOut.value = false } }
</script>
<template><div class="admin-shell console-shell"><aside class="admin-sidebar"><NuxtLink class="admin-brand" to="/console"><span><IconActivityHeartbeat :size="21" /></span><div><strong>Zephyr Hub</strong><small>USER CONSOLE</small></div></NuxtLink><nav class="admin-nav" aria-label="用户导航"><NuxtLink v-for="item in navigation" :key="item.to" :to="item.to" :class="{ active: active(item) }"><component :is="item.icon" :size="18" /><span>{{ item.label }}</span></NuxtLink></nav><div class="admin-sidebar__footer"><div class="admin-identity"><span>{{ session?.user?.username?.slice(0, 1).toUpperCase() || 'U' }}</span><div><strong>{{ session?.user?.username || 'User' }}</strong><small>user</small></div></div><button class="icon-button" title="退出登录" :disabled="loggingOut" @click="logout"><IconLogout :size="17" /></button></div></aside><main class="admin-main"><slot /></main></div></template>
