<script setup lang="ts">
import {
  IconAddressBook,
  IconAdjustments,
  IconDatabase,
  IconGauge,
  IconKey,
  IconRoute,
  IconReceipt2,
  IconSpeakerphone,
  IconShieldCheck,
  IconSettings,
  IconServerCog,
  IconUsers
} from '@tabler/icons-vue'
import type { AdminSessionView } from '#shared/types/hub'

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

const navigationGroups = computed(() => {
  const items = visibleNavigation.value
  return [
    { label: '工作区', items: items.slice(0, 4) },
    { label: '资源', items: items.slice(4, 7) },
    { label: '运维', items: items.slice(7) }
  ].filter(group => group.items.length)
})

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
  <AppWorkspaceShell
    home="/admin"
    environment-label="CONTROL PLANE"
    :groups="navigationGroups"
    :username="session?.user?.username || 'Administrator'"
    :role="session?.user?.role || 'admin'"
    :logging-out="loggingOut"
    @logout="logout"
  ><slot /></AppWorkspaceShell>
</template>
