import { requireUser } from '../../../../services/admin-auth'
import { createProbeTask } from '../../../../services/channel-probe-task'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  const channelId = getRouterParam(event, 'id')
  if (!channelId) throw createError({ statusCode: 400, message: '缺少渠道ID' })

  // 创建探测任务（立即返回）。探测只允许作用于调用者自己的中转。
  const result = await createProbeTask(event, channelId, { ownerUserId: user.userId })

  return {
    success: true,
    taskId: result.taskId,
    message: '探测任务已启动，请稍后查看结果'
  }
})
