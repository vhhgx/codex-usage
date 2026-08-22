<script setup lang="ts">
import { IconActivityHeartbeat, IconLogout, IconMenu2, IconX } from '@tabler/icons-vue'
import type { Component } from 'vue'

export interface WorkspaceNavigationItem {
  to: string
  label: string
  icon: Component
  exact?: boolean
}

export interface WorkspaceNavigationGroup {
  label: string
  items: WorkspaceNavigationItem[]
}

const props = defineProps<{
  home: string
  environmentLabel: string
  groups: WorkspaceNavigationGroup[]
  username: string
  role: string
  loggingOut: boolean
}>()

const emit = defineEmits<{ logout: [] }>()
const route = useRoute()
const drawerOpen = ref(false)
const openButton = ref<HTMLButtonElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)
const mobileNavigation = ref(false)
let mobileQuery: MediaQueryList | null = null
let previouslyFocused: HTMLElement | null = null

const drawerHidden = computed(() => mobileNavigation.value && !drawerOpen.value)

const activeItem = computed(() => props.groups
  .flatMap(group => group.items)
  .find(item => item.exact ? route.path === item.to : route.path.startsWith(item.to)))

function active(item: WorkspaceNavigationItem) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to)
}

async function openDrawer() {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  drawerOpen.value = true
  await nextTick()
  closeButton.value?.focus()
}

function closeDrawer(restoreFocus = true) {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  if (restoreFocus) nextTick(() => (previouslyFocused || openButton.value)?.focus())
}

function handleKeydown(event: KeyboardEvent) {
  if (!drawerOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDrawer()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [...sidebar.value?.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ) || []].filter(element => {
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
  if (!focusable.length) return
  const first = focusable.at(0)
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => route.fullPath, () => closeDrawer(false))
watch(drawerOpen, (open) => {
  if (!import.meta.client) return
  document.body.classList.toggle('workspace-drawer-open', open)
})

function handleMobileNavigation(event: MediaQueryListEvent | MediaQueryList) {
  mobileNavigation.value = event.matches
  if (!event.matches) closeDrawer(false)
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  mobileQuery = window.matchMedia('(max-width: 960px)')
  handleMobileNavigation(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileNavigation)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
  mobileQuery?.removeEventListener('change', handleMobileNavigation)
  document.body.classList.remove('workspace-drawer-open')
})
</script>

<template>
  <div class="workspace-shell">
    <a class="skip-link" href="#workspace-main">跳到主要内容</a>
    <button
      v-if="drawerOpen"
      class="workspace-overlay"
      type="button"
      aria-label="关闭导航"
      @click="closeDrawer()"
    />
    <aside
      id="workspace-sidebar"
      ref="sidebar"
      class="workspace-sidebar"
      :class="{ 'is-open': drawerOpen }"
      aria-label="主导航"
      :aria-hidden="drawerHidden ? 'true' : undefined"
      :inert="drawerHidden ? true : undefined"
    >
      <header class="workspace-brand-row">
        <NuxtLink class="workspace-brand" :to="home" @click="closeDrawer(false)">
          <span class="workspace-brand__mark"><IconActivityHeartbeat :size="19" :stroke-width="1.8" /></span>
          <span><strong>Zephyr Hub</strong><small>{{ environmentLabel }}</small></span>
        </NuxtLink>
        <button ref="closeButton" class="icon-button workspace-close" type="button" title="关闭导航" aria-label="关闭导航" @click="closeDrawer()">
          <IconX :size="18" :stroke-width="1.8" />
        </button>
      </header>

      <nav class="workspace-nav">
        <section v-for="group in groups" :key="group.label">
          <h2>{{ group.label }}</h2>
          <NuxtLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            :title="item.label"
            :aria-current="active(item) ? 'page' : undefined"
          >
            <component :is="item.icon" :size="16" :stroke-width="1.7" />
            <span>{{ item.label }}</span>
          </NuxtLink>
        </section>
      </nav>

      <footer class="workspace-identity">
        <span class="workspace-identity__avatar">{{ username.slice(0, 1).toUpperCase() }}</span>
        <span><strong>{{ username }}</strong><small>{{ role }}</small></span>
        <button class="icon-button" type="button" title="退出登录" aria-label="退出登录" :disabled="loggingOut" @click="emit('logout')">
          <IconLogout :size="16" :stroke-width="1.8" />
        </button>
      </footer>
    </aside>

    <div class="workspace-stage">
      <header class="workspace-topbar">
        <div class="workspace-topbar__inner">
          <button
            ref="openButton"
            class="icon-button workspace-menu"
            type="button"
            title="打开导航"
            aria-label="打开导航"
            aria-controls="workspace-sidebar"
            :aria-expanded="drawerOpen"
            @click="openDrawer"
          >
            <IconMenu2 :size="18" :stroke-width="1.8" />
          </button>
          <nav aria-label="面包屑" class="workspace-breadcrumb">
            <NuxtLink :to="home">Zephyr Hub</NuxtLink>
            <span aria-hidden="true">/</span>
            <strong>{{ activeItem?.label || '控制台' }}</strong>
          </nav>
          <AppThemeButton />
        </div>
      </header>
      <main id="workspace-main" class="workspace-main admin-main" tabindex="-1"><slot /></main>
    </div>
  </div>
</template>
