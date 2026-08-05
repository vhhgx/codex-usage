<script setup lang="ts">
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconSpeakerphone } from '@tabler/icons-vue'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '公告 | Zephyr Hub' })

interface Announcement {
  id: string
  title: string
  content: string
  tone: 'info' | 'warning' | 'success'
  publishedAt: number | null
  expiresAt: number | null
}

const { data } = await useFetch<{ announcements: Announcement[] }>('/api/console/announcements')
const toneMeta = {
  info: { label: '通知', icon: IconInfoCircle },
  warning: { label: '提醒', icon: IconAlertTriangle },
  success: { label: '完成', icon: IconCircleCheck }
}
const date = (value: number | null) => value
  ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
  : '长期有效'
</script>

<template>
  <div class="admin-page console-announcements">
    <header class="admin-page__header"><div><span class="admin-kicker">ANNOUNCEMENTS</span><h1>公告</h1><p>查看管理员发布的服务通知和重要提醒。</p></div></header>
    <section v-if="data?.announcements.length" class="console-announcement-list">
      <article v-for="item in data.announcements" :key="item.id" class="admin-panel console-announcement" :data-tone="item.tone">
        <header><div><span>{{ toneMeta[item.tone].label }}</span><h2>{{ item.title }}</h2></div><component :is="toneMeta[item.tone].icon" :size="20" /></header>
        <p>{{ item.content }}</p>
        <footer><span>发布于 {{ date(item.publishedAt) }}</span><span>有效期至 {{ date(item.expiresAt) }}</span></footer>
      </article>
    </section>
    <div v-else class="admin-empty admin-empty--large console-announcement-empty"><div><IconSpeakerphone :size="26" /><strong>暂无公告</strong><p>当前没有正在生效的公告。</p></div></div>
  </div>
</template>
