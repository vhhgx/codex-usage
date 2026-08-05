import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { syncModelPricesFromSub2Api } from '../../../services/model-price-sync'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  return auditedMutation(event, async () => {
    const result = await syncModelPricesFromSub2Api(event)
    await writeAudit(event, admin.userId, 'model.prices.sync', 'model', null, {
      source: result.source,
      total: result.total,
      updated: result.updated,
      unavailable: result.unavailable.length,
      failed: result.failed.length
    })
    return result
  })
})
