import { eq, and, asc } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelProtocolBindings, channels, probeModelCatalog } from '../db/schema'
import { useRedis } from '../utils/redis'
import { decryptChannelSecret } from '../utils/hub-crypto'
import type { ChannelAuthScheme, ChannelProtocol } from '#shared/types/hub'

// 探测任务状态
export interface ProbeTask {
  taskId: string
  channelId: string
  channelName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  progress: {
    current: number
    total: number
    currentProtocol?: string
  }
  results: {
    protocol: string
    status: 'success' | 'failed' | 'pending'
    testedModel?: string
    error?: string
  }[]
}

// 创建探测任务
export async function createProbeTask(
  event: H3Event,
  channelId: string
): Promise<{ taskId: string }> {
  const db = useDatabase(event)

  // 获取渠道信息
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })

  // 生成任务ID
  const taskId = `probe_${channelId}_${Date.now()}`

  // 初始化任务状态
  const task: ProbeTask = {
    taskId,
    channelId,
    channelName: channel.name,
    status: 'pending',
    startedAt: Date.now(),
    progress: { current: 0, total: 3 }, // 3个协议
    results: [
      { protocol: 'anthropic_messages', status: 'pending' },
      { protocol: 'openai_responses', status: 'pending' },
      { protocol: 'openai_chat', status: 'pending' },
    ]
  }

  // 保存到 Redis（TTL 1小时）
  const redis = useRedis(event)
  await redis.set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)

  // 启动异步探测（不等待结果）
  runProbeTask(event, taskId, channel).catch(error => {
    console.error(`[probe-task] ${taskId} failed:`, error)
  })

  return { taskId }
}

// 获取任务状态
export async function getProbeTask(
  event: H3Event,
  taskId: string
): Promise<ProbeTask | null> {
  const redis = useRedis(event)
  const raw = await redis.get(`hub:probe-task:${taskId}`)
  if (!raw) return null
  return JSON.parse(raw) as ProbeTask
}

// 执行探测任务（后台运行）
async function runProbeTask(
  event: H3Event,
  taskId: string,
  channel: typeof channels.$inferSelect
) {
  const redis = useRedis(event)
  const db = useDatabase(event)

  // 更新状态为 running
  const task = await getProbeTask(event, taskId)
  if (!task) return

  task.status = 'running'
  await redis.set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)

  const protocols: Array<{
    protocol: ChannelProtocol
    authScheme: ChannelAuthScheme
  }> = [
    { protocol: 'anthropic_messages', authScheme: 'x_api_key' },
    { protocol: 'openai_responses', authScheme: 'bearer' },
    { protocol: 'openai_chat', authScheme: 'bearer' },
  ]

  const successfulBindings: Array<typeof channelProtocolBindings.$inferInsert> = []

  // 逐个协议探测
  for (const [i, { protocol, authScheme }] of protocols.entries()) {

    // 更新进度
    task.progress.current = i
    task.progress.currentProtocol = protocol
    await redis.set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)

    try {
      // 探测该协议
      const result = await probeProtocolWithFallback(
        event,
        channel.baseUrl,
        channel.encryptedApiKey,
        channel.id,
        channel.ownerKind,
        protocol
      )

      // 更新结果
      task.results[i] = {
        protocol,
        status: result.success ? 'success' : 'failed',
        testedModel: result.testedModel,
        error: result.error
      }

      if (result.success) {
        successfulBindings.push({
          channelId: channel.id,
          protocol,
          authScheme,
          enabled: true,
          verificationStatus: 'verified',
          verifiedAt: new Date(),
          lastError: null
        })
      }

    } catch (error) {
      task.results[i] = {
        protocol,
        status: 'failed',
        error: error instanceof Error ? error.message : '探测失败'
      }
    }

    // 更新任务状态
    await redis.set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)
  }

  // 保存探测结果到数据库
  await db.transaction(async tx => {
    // 删除旧的协议绑定
    await tx.delete(channelProtocolBindings)
      .where(eq(channelProtocolBindings.channelId, channel.id))

    // 插入新的协议绑定
    if (successfulBindings.length > 0) {
      await tx.insert(channelProtocolBindings).values(successfulBindings)
    }
  })

  // 标记任务完成
  task.status = 'completed'
  task.completedAt = Date.now()
  task.progress.current = 3
  await redis.set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)

  console.log(`[probe-task] ${taskId} completed:`, task.results)
}

// 探测单个协议（带模型回退）
async function probeProtocolWithFallback(
  event: H3Event,
  baseUrl: string,
  encryptedApiKey: string,
  channelId: string,
  ownerKind: 'platform' | 'user',
  protocol: 'anthropic_messages' | 'openai_responses' | 'openai_chat'
): Promise<{ success: boolean; testedModel?: string; error?: string }> {

  const db = useDatabase(event)

  // 获取该协议的探测模型列表（按优先级排序：新→旧）
  const probeModels = await db
    .select()
    .from(probeModelCatalog)
    .where(and(
      eq(probeModelCatalog.protocol, protocol),
      eq(probeModelCatalog.enabled, true)
    ))
    .orderBy(
      asc(probeModelCatalog.sortOrder)
    )

  if (probeModels.length === 0) {
    return { success: false, error: '没有配置探测模型' }
  }

  // 解密 API Key
  const apiKey = decryptChannelSecret(encryptedApiKey, channelId, ownerKind, event)

  // 依次尝试每个模型（从新到旧）
  const errors: string[] = []

  for (const probeModel of probeModels) {
    try {
      await testProtocolWithModel(baseUrl, apiKey, protocol, probeModel.model)

      // 成功！
      return {
        success: true,
        testedModel: probeModel.model
      }

    } catch (error) {
      const errorType = classifyProbeError(error)

      // 认证错误：立即失败，不再尝试其他模型
      if (errorType === 'auth') {
        return {
          success: false,
          error: `认证失败: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      }

      // 网络错误：立即失败
      if (errorType === 'network') {
        return {
          success: false,
          error: `网络错误: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      }

      // 模型不存在：记录并继续尝试下一个
      if (errorType === 'model_not_found') {
        errors.push(`${probeModel.model}: 模型不存在`)
        continue
      }

      // 其他错误：记录并继续
      errors.push(`${probeModel.model}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // 所有模型都失败了
  return {
    success: false,
    error: `所有探测模型均失败: ${errors.join('; ')}`
  }
}

// 测试单个协议+模型组合
async function testProtocolWithModel(
  baseUrl: string,
  apiKey: string,
  protocol: 'anthropic_messages' | 'openai_responses' | 'openai_chat',
  model: string
): Promise<void> {

  const configs = {
    anthropic_messages: {
      endpoint: '/v1/messages',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: {
        model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1
      }
    },
    openai_responses: {
      endpoint: '/v1/responses',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: {
        model,
        modalities: ['text'],
        instructions: 'test',
        max_output_tokens: 1
      }
    },
    openai_chat: {
      endpoint: '/v1/chat/completions',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: {
        model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1
      }
    }
  }

  const config = configs[protocol]

  const response = await fetch(`${baseUrl}${config.endpoint}`, {
    method: 'POST',
    headers: config.headers,
    body: JSON.stringify(config.body),
    signal: AbortSignal.timeout(15000) // 15秒超时
  })

  // 分析响应
  if (response.ok) {
    return // 成功
  }

  const errorBody = await response.text()

  // 401/403 = 认证错误
  if (response.status === 401 || response.status === 403) {
    const error = new Error('Authentication failed')
    error.name = 'AuthError'
    throw error
  }

  // 404 或包含 model_not_found = 模型不存在
  if (response.status === 404 ||
      errorBody.includes('model_not_found') ||
      errorBody.includes('model not found') ||
      errorBody.includes('does not exist')) {
    const error = new Error('Model not found')
    error.name = 'ModelNotFoundError'
    throw error
  }

  // 其他 4xx = 可能是参数问题，但协议是支持的
  if (response.status >= 400 && response.status < 500) {
    // 尝试解析错误
    try {
      const json = JSON.parse(errorBody)
      if (json.error?.message) {
        throw new Error(json.error.message)
      }
    } catch {}
    return // 认为协议支持，只是参数问题
  }

  // 5xx = 服务器错误
  throw new Error(`Server error: HTTP ${response.status}`)
}

// 错误分类
function classifyProbeError(error: any): 'auth' | 'network' | 'model_not_found' | 'other' {
  if (error.name === 'AuthError') return 'auth'
  if (error.name === 'ModelNotFoundError') return 'model_not_found'
  if (error.name === 'TypeError' || error.name === 'FetchError') return 'network'
  if (error.message?.includes('timeout')) return 'network'
  if (error.message?.includes('ECONNREFUSED')) return 'network'
  return 'other'
}
