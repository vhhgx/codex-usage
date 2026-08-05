<script setup lang="ts">
import { IconActivityHeartbeat, IconBook2, IconKey, IconLock } from '@tabler/icons-vue'

const route = useRoute()
const config = useRuntimeConfig()

const links = [
  { to: '/key-usage', label: '查询用量', icon: IconKey },
  { to: '/guide', label: '使用方法', icon: IconBook2 },
  { to: '/admin', label: '管理后台', icon: IconLock }
]
</script>

<template>
  <header class="site-header">
    <div class="site-header__inner page-width">
      <NuxtLink to="/" class="brand" aria-label="返回首页">
        <span class="brand__mark"><IconActivityHeartbeat :size="22" :stroke-width="1.8" /></span>
        <span>{{ config.public.appName }}</span>
      </NuxtLink>

      <nav class="site-nav" aria-label="主导航">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="site-nav__link"
          :class="{ 'site-nav__link--active': route.path.startsWith(link.to) }"
        >
          <component :is="link.icon" :size="17" :stroke-width="1.8" />
          <span>{{ link.label }}</span>
        </NuxtLink>
      </nav>
    </div>
  </header>
</template>
