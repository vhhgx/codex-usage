import { requireUser } from '../../../services/admin-auth'
import { unassignUserPlan } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  // 用户只能关闭自己的套餐（自限），不能把管理员停用的套餐重新打开——恢复必须由管理员操作。
  const subscription = await unassignUserPlan(event, user.userId, user.userId)
  return { subscription }
})
