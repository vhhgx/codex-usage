import { desc, eq } from 'drizzle-orm'
import { requireUser } from '../../../services/admin-auth'
import { ensureUserWallet } from '../../../services/user-wallet'
import { useDatabase } from '../../../db'
import { walletTransactions } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const wallet = await ensureUserWallet(event, user.userId)
  const rows = await useDatabase(event).select().from(walletTransactions).where(eq(walletTransactions.walletId, wallet.id)).orderBy(desc(walletTransactions.createdAt)).limit(100)
  return { transactions: rows.map(item => ({ ...item, amount: Number(item.amount), balanceBefore: Number(item.balanceBefore), balanceAfter: Number(item.balanceAfter), createdAt: item.createdAt.getTime() })) }
})
