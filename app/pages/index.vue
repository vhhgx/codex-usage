<script setup lang="ts">
import {
  IconArrowRight,
  IconBook2,
  IconChartHistogram,
  IconFingerprint
} from '@tabler/icons-vue'

useSeoMeta({
  title: 'Zephyr Console',
  description: '安全查询 CPA 与 Sub2API 账号配额和 API Key 调用用量。'
})
</script>

<template>
  <div class="home-page page-width">
    <section class="home-hero">
      <div class="home-hero__copy reveal-item">
        <span class="eyebrow">CPA OBSERVABILITY</span>
        <h1>额度与用量<br>一处看清</h1>
        <p>管理 Codex 账号配额，让 API 用户安全查询自己的调用记录。</p>
        <div class="home-hero__actions">
          <NuxtLink to="/key-usage" class="button button--primary">
            查询我的用量 <IconArrowRight :size="18" :stroke-width="1.8" />
          </NuxtLink>
          <NuxtLink to="/usage" class="button button--secondary">查看账号余量</NuxtLink>
        </div>
      </div>

    </section>

    <section class="capability-grid">
      <NuxtLink to="/usage" class="capability capability--wide">
        <IconChartHistogram :size="28" :stroke-width="1.6" />
        <div>
          <h2>账号余量看板</h2>
          <p>集中查看 CPA 与 Sub2API 账号额度，支持单账号刷新和受控并发的全部刷新。</p>
        </div>
        <IconArrowRight class="capability__arrow" :size="20" :stroke-width="1.8" />
      </NuxtLink>
      <NuxtLink to="/key-usage" class="capability capability--accent">
        <IconFingerprint :size="28" :stroke-width="1.6" />
        <div>
          <h2>API Key 用量查询</h2>
          <p>输入自己的客户端 Key，查看调用次数、Token、模型和估算费用。</p>
        </div>
        <IconArrowRight class="capability__arrow" :size="20" :stroke-width="1.8" />
      </NuxtLink>
      <NuxtLink to="/guide" class="capability">
        <IconBook2 :size="28" :stroke-width="1.6" />
        <div>
          <h2>使用方法</h2>
          <p>配置 Codex CLI，通过 Sub2API 接入模型服务。</p>
        </div>
        <IconArrowRight class="capability__arrow" :size="20" :stroke-width="1.8" />
      </NuxtLink>
    </section>
  </div>
</template>
