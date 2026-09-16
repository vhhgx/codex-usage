import { requireUser } from '../../../../services/admin-auth'
import { getProbeTask } from '../../../../services/channel-probe-task'

export default defineEventHandler(async (event) => {
  await requireUser(event)

  const taskId = getRouterParam(event, 'taskId')
  if (!taskId) throw createError({ statusCode: 400, message: '缺少任务ID' })

  const task = await getProbeTask(event, taskId)
  if (!task) throw createError({ statusCode: 404, message: '任务不存在或已过期' })

  return task
})
