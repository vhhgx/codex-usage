import { and, count, desc, eq, gte, ilike, lte, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { auditLogs, users } from '../db/schema'

function date(value: string | undefined, label: string) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw createError({ statusCode: 400, message: `${label}格式不正确` })
  return parsed
}

export async function listAuditLogs(event: H3Event, query: Record<string, string | undefined>) {
  const db = useDatabase(event)
  const page = Math.max(1, Number.parseInt(query.page || '1') || 1)
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(query.pageSize || '50') || 50))
  const from = date(query.from, '开始时间')
  const to = date(query.to, '结束时间')
  if (from && to && from >= to) throw createError({ statusCode: 400, message: '审计时间范围不正确' })
  const conditions = [
    query.action ? ilike(auditLogs.action, `%${query.action.slice(0, 100)}%`) : undefined,
    query.targetType ? eq(auditLogs.targetType, query.targetType.slice(0, 100)) : undefined,
    query.search ? or(
      ilike(auditLogs.action, `%${query.search.slice(0, 200)}%`),
      ilike(auditLogs.targetId, `%${query.search.slice(0, 200)}%`),
      ilike(users.username, `%${query.search.slice(0, 200)}%`)
    ) : undefined,
    from ? gte(auditLogs.createdAt, from) : undefined,
    to ? lte(auditLogs.createdAt, to) : undefined
  ]
  const where = and(...conditions)
  const [rows, [total]] = await Promise.all([
    db.select({ audit: auditLogs, username: users.username }).from(auditLogs)
      .leftJoin(users, eq(auditLogs.adminId, users.id))
      .where(where).orderBy(desc(auditLogs.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ value: count() }).from(auditLogs).leftJoin(users, eq(auditLogs.adminId, users.id)).where(where)
  ])
  return {
    items: rows.map(({ audit, username }) => ({
      id: audit.id,
      adminId: audit.adminId,
      username: username || 'system',
      action: audit.action,
      targetType: audit.targetType,
      targetId: audit.targetId,
      detail: audit.detail,
      ipHash: audit.ipHash,
      createdAt: audit.createdAt.getTime()
    })),
    page,
    pageSize,
    total: Number(total?.value || 0)
  }
}
