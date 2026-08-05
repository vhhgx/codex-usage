<script setup lang="ts">
import {
  IconActivityHeartbeat,
  IconAddressBook,
  IconAdjustments,
  IconDatabase,
  IconGauge,
  IconKey,
  IconLogout,
  IconRoute,
  IconReceipt2,
  IconSpeakerphone,
  IconShieldCheck,
  IconSettings,
  IconServerCog,
  IconUsers
} from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'

const route = useRoute()
const session = useState<AdminSessionView | null>('auth-session', () => null)
const loggingOut = ref(false)
const navigation = [
  { to: '/admin', label: '运行总览', icon: IconGauge, exact: true },
  { to: '/admin/users', label: '用户管理', icon: IconUsers },
  { to: '/admin/announcements', label: '公告管理', icon: IconSpeakerphone },
  { to: '/admin/keys', label: 'Hub Keys', icon: IconKey },
  { to: '/admin/channels', label: '资源管理', icon: IconRoute },
  { to: '/admin/account-vault', label: '账号管理', icon: IconAddressBook, roles: ['super_admin', 'admin'] },
  { to: '/admin/upstreams', label: '号池配置', icon: IconServerCog },
  { to: '/admin/ledger', label: '收支台账', icon: IconReceipt2, roles: ['super_admin', 'admin'] },
  { to: '/admin/models', label: '模型与价格', icon: IconAdjustments },
  { to: '/admin/logs', label: '请求日志', icon: IconDatabase },
  { to: '/admin/audits', label: '审计日志', icon: IconShieldCheck },
  { to: '/admin/settings', label: '系统设置', icon: IconSettings }
]

const visibleNavigation = computed(() => navigation.filter(item =>
  !('roles' in item) || item.roles?.includes(session.value?.user?.role as 'super_admin' | 'admin')
))

function active(item: typeof navigation[number]) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to)
}

async function logout() {
  loggingOut.value = true
  try {
    await $fetch('/api/auth/logout', { method: 'POST' })
    session.value = { authenticated: false, user: null }
    await navigateTo('/login')
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <NuxtLink class="admin-brand" to="/admin">
        <span><IconActivityHeartbeat :size="21" :stroke-width="1.8" /></span>
        <div><strong>Zephyr Hub</strong><small>CONTROL PLANE</small></div>
      </NuxtLink>
      <nav class="admin-nav" aria-label="管理导航">
        <NuxtLink v-for="item in visibleNavigation" :key="item.to" :to="item.to" :title="item.label" :class="{ active: active(item) }">
          <component :is="item.icon" :size="18" :stroke-width="1.7" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>
      <div class="admin-sidebar__footer">
        <div class="admin-identity"><span>{{ session?.user?.username?.slice(0, 1).toUpperCase() || 'A' }}</span><div><strong>{{ session?.user?.username || 'Administrator' }}</strong><small>{{ session?.user?.role || 'admin' }}</small></div></div>
        <button class="icon-button" type="button" title="退出登录" :disabled="loggingOut" @click="logout">
          <IconLogout :size="17" :stroke-width="1.8" />
        </button>
      </div>
    </aside>
    <main class="admin-main"><slot /></main>
  </div>
</template>
