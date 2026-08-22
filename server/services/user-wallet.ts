import { and, desc, eq, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { userWallets, walletTransactions } from '../db/schema'

function amount(value: unknown, allowZero = false) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw)) throw createError({ statusCode: 400, message: '金额必须是最多 8 位小数的非负数字' })
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw createError({ statusCode: 400, message: allowZero ? '金额不能为负数' : '金额必须大于 0' })
  return raw
}

export async function ensureUserWallet(event: H3Event, userId: string) {
  const db = useDatabase(event)
  await db.insert(userWallets).values({ userId }).onConflictDoNothing()
  return (await db.select().from(userWallets).where(eq(userWallets.userId, userId)).limit(1))[0]!
}

export async function getUserWallet(event: H3Event, userId: string) {
  const wallet = await ensureUserWallet(event, userId)
  const transactions = await useDatabase(event).select().from(walletTransactions).where(eq(walletTransactions.walletId, wallet.id)).orderBy(desc(walletTransactions.createdAt)).limit(50)
  return { wallet: { id: wallet.id, currency: wallet.currency, availableBalance: Number(wallet.availableBalance), heldBalance: Number(wallet.heldBalance), updatedAt: wallet.updatedAt.getTime() }, transactions: transactions.map(item => ({ ...item, amount: Number(item.amount), balanceBefore: Number(item.balanceBefore), balanceAfter: Number(item.balanceAfter), createdAt: item.createdAt.getTime() })) }
}

async function transactionForIdempotency(tx: any, walletId: string, key: string) {
  return (await tx.select().from(walletTransactions).where(and(eq(walletTransactions.walletId, walletId), eq(walletTransactions.idempotencyKey, key))).limit(1))[0]
}

export async function holdUserWallet(event: H3Event, userId: string, value: unknown, idempotencyKey: string, requestId?: string) {
  const rawAmount = amount(value)
  if (!idempotencyKey || idempotencyKey.length > 200) throw createError({ statusCode: 400, message: '缺少幂等键' })
  const db = useDatabase(event)
  const wallet = await ensureUserWallet(event, userId)
  return db.transaction(async (tx) => {
    const existing = await transactionForIdempotency(tx, wallet.id, idempotencyKey)
    if (existing) return existing
    const [updated] = await tx.update(userWallets).set({ availableBalance: sql`${userWallets.availableBalance} - ${rawAmount}`, heldBalance: sql`${userWallets.heldBalance} + ${rawAmount}`, version: sql`${userWallets.version} + 1`, updatedAt: new Date() }).where(and(eq(userWallets.id, wallet.id), sql`${userWallets.availableBalance} >= ${rawAmount}`)).returning()
    if (!updated) throw createError({ statusCode: 402, message: '钱包余额不足' })
    const before = Number(updated.availableBalance) + Number(rawAmount)
    const [entry] = await tx.insert(walletTransactions).values({ walletId: wallet.id, requestId: requestId || null, type: 'hold', amount: rawAmount, balanceBefore: String(before), balanceAfter: String(updated.availableBalance), idempotencyKey }).returning()
    return entry
  })
}

export async function settleUserWallet(event: H3Event, userId: string, holdIdempotencyKey: string, actualValue: unknown, idempotencyKey: string, requestId?: string) {
  const actual = amount(actualValue, true)
  const wallet = await ensureUserWallet(event, userId)
  return useDatabase(event).transaction(async (tx) => {
    const existing = await transactionForIdempotency(tx, wallet.id, idempotencyKey)
    if (existing) return existing
    const hold = await transactionForIdempotency(tx, wallet.id, holdIdempotencyKey)
    if (!hold || hold.type !== 'hold') throw createError({ statusCode: 409, message: '冻结记录不存在或已结算' })
    const held = Number(hold.amount)
    const [updated] = await tx.update(userWallets).set({ heldBalance: sql`${userWallets.heldBalance} - ${held}`, availableBalance: sql`${userWallets.availableBalance} + ${held} - ${Number(actual)}`, version: sql`${userWallets.version} + 1`, updatedAt: new Date() }).where(and(eq(userWallets.id, wallet.id), sql`${userWallets.heldBalance} >= ${held}`, sql`${userWallets.availableBalance} + ${held} >= ${Number(actual)}`)).returning()
    if (!updated) throw createError({ statusCode: 409, message: '钱包冻结状态不一致' })
    const [entry] = await tx.insert(walletTransactions).values({ walletId: wallet.id, requestId: requestId || null, type: 'settle', amount: String(-Number(actual)), balanceBefore: String(Number(updated.availableBalance) - held + Number(actual)), balanceAfter: String(updated.availableBalance), idempotencyKey, note: `hold=${hold.id}` }).returning()
    return entry
  })
}

export async function releaseUserWallet(event: H3Event, userId: string, holdIdempotencyKey: string, idempotencyKey: string, requestId?: string) {
  const wallet = await ensureUserWallet(event, userId)
  return useDatabase(event).transaction(async (tx) => {
    const existing = await transactionForIdempotency(tx, wallet.id, idempotencyKey)
    if (existing) return existing
    const hold = await transactionForIdempotency(tx, wallet.id, holdIdempotencyKey)
    if (!hold || hold.type !== 'hold') throw createError({ statusCode: 409, message: '冻结记录不存在或已释放' })
    const held = Number(hold.amount)
    const [updated] = await tx.update(userWallets).set({ heldBalance: sql`${userWallets.heldBalance} - ${held}`, availableBalance: sql`${userWallets.availableBalance} + ${held}`, version: sql`${userWallets.version} + 1`, updatedAt: new Date() }).where(and(eq(userWallets.id, wallet.id), sql`${userWallets.heldBalance} >= ${held}`)).returning()
    if (!updated) throw createError({ statusCode: 409, message: '钱包冻结状态不一致' })
    const [entry] = await tx.insert(walletTransactions).values({ walletId: wallet.id, requestId: requestId || null, type: 'release', amount: String(held), balanceBefore: String(Number(updated.availableBalance) - held), balanceAfter: String(updated.availableBalance), idempotencyKey, note: `hold=${hold.id}` }).returning()
    return entry
  })
}
