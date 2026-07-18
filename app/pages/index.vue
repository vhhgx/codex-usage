<script setup lang="ts">
import {
  IconArrowRight,
  IconChartHistogram,
  IconFingerprint,
  IconShieldLock
} from '@tabler/icons-vue'

useSeoMeta({
  title: 'Zephyr Console',
  description: '安全查询 Codex 配额与 API Key 调用用量。'
})
</script>

<template>
  <div class="home-page page-width">
    <section class="home-hero">
      <div class="home-hero__copy reveal-item">
        <span class="eyebrow">CPA OBSERVABILITY</span>
        <h1>额度与用量，<br>从同一处看清。</h1>
        <p>管理 Codex 账号配额，让 API 用户安全查询自己的调用记录。</p>
        <div class="home-hero__actions">
          <NuxtLink to="/usage" class="button button--primary">
            查询我的用量 <IconArrowRight :size="18" :stroke-width="1.8" />
          </NuxtLink>
          <NuxtLink to="/codex" class="button button--secondary">查看 Codex 余量</NuxtLink>
        </div>
      </div>

      <div class="signal-panel reveal-item" style="--delay: 90ms">
        <div class="signal-panel__header">
          <span>服务端安全边界</span>
          <IconShieldLock :size="22" :stroke-width="1.7" />
        </div>
        <div class="signal-route">
          <span>浏览器</span><i /> <span>Nuxt Server</span><i /> <span>CPA</span>
        </div>
        <dl class="signal-panel__facts">
          <div><dt>Management Key</dt><dd>仅服务端</dd></div>
          <div><dt>Codex Token</dt><dd>不会下发</dd></div>
          <div><dt>用户查询</dt><dd>SHA-256 筛选</dd></div>
        </dl>
      </div>
    </section>

    <section class="capability-grid">
      <NuxtLink to="/codex" class="capability capability--wide">
        <IconChartHistogram :size="28" :stroke-width="1.6" />
        <div>
          <h2>Codex 余量看板</h2>
          <p>查看 5 小时、周/月额度，支持单账号刷新和受控并发的全部刷新。</p>
        </div>
        <IconArrowRight class="capability__arrow" :size="20" :stroke-width="1.8" />
      </NuxtLink>
      <NuxtLink to="/usage" class="capability capability--accent">
        <IconFingerprint :size="28" :stroke-width="1.6" />
        <div>
          <h2>API Key 用量查询</h2>
          <p>输入自己的客户端 Key，查看调用次数、Token、模型和估算费用。</p>
        </div>
        <IconArrowRight class="capability__arrow" :size="20" :stroke-width="1.8" />
      </NuxtLink>
    </section>
  </div>
</template>
