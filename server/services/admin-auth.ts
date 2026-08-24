import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import { eq, inArray } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { auditLogs, groupMemberships, groups, users } from '../db/schema'
import { useDatabase } from '../db'
import { withDatabaseTransaction } from '../db'
import { hashClientIp } from '../utils/hub-crypto'
import { useRedis } from '../utils/redis'
import { trustedClientIp } from '../utils/client-ip'

const COOKIE = 'zephyr_session'
const LEGACY_COOKIE = 'zephyr_admin_session'
const SESSION_TTL_SECONDS = 12 * 60 * 60
const ADMIN_ROLES: StoredSession['role'][] = ['super_admin', 'admin', 'operator', 'auditor']
const ADMIN_WRITE_ROLES: StoredSession['role'][] = ['super_admin', 'admin', 'operator']
const ACCOUNT_ADMIN_ROLES: StoredSession['role'][] = ['super_admin', 'admin']
const DEFAULT_GROUP_ID = '00000000-0000-4000-8000-000000000001'

export interface StoredSession { userId: string; username: string; role: 'super_admin' | 'admin' | 'operator' | 'auditor' | 'user'; mustChangePassword: boolean; authenticatedAt: number; reauthenticatedAt: number }

function sessionKey(token: string, legacy = false) {
  return `hub:${legacy ? 'admin-session' : 'session'}:${createHash('sha256').update(token).digest('hex')}`
}

async function ensureInitialAdmin(event: H3Event) {
  const db = useDatabase(event)
  let administrators = await db.select({ id: users.id }).from(users).where(inArray(users.role, ['super_admin', 'admin']))
  if (!administrators.length) {
    const config = useRuntimeConfig(event)
    const username = String(config.adminUsername || '').trim()
    const password = String(config.adminPassword || '')
    if (!username || password.length < 8) {
      throw createError({
        statusCode: 503,
        message: '首次启动需要配置 NUXT_ADMIN_USERNAME 和至少 8 位的 NUXT_ADMIN_PASSWORD'
      })
    }
    administrators = await db.insert(users).values({
      username,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: 'super_admin',
      passwordChangedAt: new Date()
    }).onConflictDoNothing().returning({ id: users.id })
    if (!administrators.length) {
      administrators = await db.select({ id: users.id }).from(users).where(inArray(users.role, ['super_admin', 'admin']))
    }
  }
  const [defaultGroup] = await db.insert(groups).values({
    id: DEFAULT_GROUP_ID,
    name: '默认分组',
    description: '由系统创建，用于承接未指定分组的 Hub Key'
  }).onConflictDoNothing().returning({ id: groups.id })
  const groupId = defaultGroup?.id || (await db.select({ id: groups.id }).from(groups).where(eq(groups.name, '默认分组')).limit(1))[0]?.id
  if (groupId && administrators.length) {
    await db.insert(groupMemberships).values(administrators.map(admin => ({ groupId, userId: admin.id, role: 'manager' as const, createdBy: admin.id }))).onConflictDoNothing()
  }
}

async function loginAccount(event: H3Event, username: string, password: string, allowedRoles?: StoredSession['role'][]) {
  const db = useDatabase(event)
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1)
  if (!user || allowedRoles && !allowedRoles.includes(user.role) || user.status !== 'active' || !await argon2.verify(user.passwordHash, password)) {
    throw createError({ statusCode: 401, message: '用户名或密码错误' })
  }
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const session: StoredSession = { userId: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword, authenticatedAt: now, reauthenticatedAt: now }
  await useRedis(event).set(sessionKey(token), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS)
  setCookie(event, COOKIE, token, {
    httpOnly: true,
    secure: getRequestProtocol(event, { xForwardedProto: true }) === 'https',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS
  })
  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id))
  await writeAudit(event, user.id, 'session.login', 'user', user.id, { role: user.role })
  return { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword }
}

export async function login(event: H3Event, username: string, password: string) {
  await ensureInitialAdmin(event)
  return loginAccount(event, username, password)
}

export async function getSession(event: H3Event): Promise<StoredSession | null> {
  const token = getCookie(event, COOKIE) || getCookie(event, LEGACY_COOKIE)
  if (!token) return null
  const redis = useRedis(event)
  const currentKey = sessionKey(token)
  const legacyKey = sessionKey(token, true)
  const raw = await redis.get(currentKey) || await redis.get(legacyKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (!parsed.userId || !parsed.username) return null
    const [user] = await useDatabase(event).select({ role: users.role, status: users.status, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, parsed.userId)).limit(1)
    if (!user || user.status !== 'active') return null
    const role = user.role
    const now = Date.now()
    const session: StoredSession = {
      userId: parsed.userId,
      username: parsed.username,
      role,
      mustChangePassword: user.mustChangePassword,
      authenticatedAt: parsed.authenticatedAt || now,
      reauthenticatedAt: parsed.reauthenticatedAt || parsed.authenticatedAt || now
    }
    if (!await redis.get(currentKey)) await redis.set(currentKey, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS)
    else await redis.expire(currentKey, SESSION_TTL_SECONDS)
    return session
  } catch {
    return null
  }
}

export async function requireAuthenticated(event: H3Event) {
  const session = await getSession(event)
  if (!session) throw createError({ statusCode: 401, message: '请先登录' })
  return session
}

export async function requireAdmin(event: H3Event) {
  const session = await requireAuthenticated(event)
  if (!ADMIN_ROLES.includes(session.role)) throw createError({ statusCode: 403, message: '没有管理权限' })
  return session
}

export async function requireAdminWrite(event: H3Event) {
  const session = await requireAdmin(event)
  if (!ADMIN_WRITE_ROLES.includes(session.role)) throw createError({ statusCode: 403, message: '当前角色只有只读权限' })
  return session
}

export async function requireAccountAdmin(event: H3Event) {
  const session = await requireAdmin(event)
  if (!ACCOUNT_ADMIN_ROLES.includes(session.role)) throw createError({ statusCode: 403, message: '只有管理员可以执行该操作' })
  return session
}

export function canOwnPersonalResources(role: StoredSession['role']) {
  return role === 'user' || role === 'admin' || role === 'super_admin'
}

export async function requireUser(event: H3Event) {
  const session = await requireAuthenticated(event)
  if (!canOwnPersonalResources(session.role)) throw createError({ statusCode: 403, message: '当前角色不能维护个人资源' })
  return session
}

export async function logout(event: H3Event) {
  const token = getCookie(event, COOKIE) || getCookie(event, LEGACY_COOKIE)
  if (token) await useRedis(event).del(sessionKey(token), sessionKey(token, true))
  deleteCookie(event, COOKIE, { path: '/' })
  deleteCookie(event, LEGACY_COOKIE, { path: '/' })
}

export async function reauthenticate(event: H3Event, password: string) {
  const session = await requireAuthenticated(event)
  const [user] = await useDatabase(event).select().from(users).where(eq(users.id, session.userId)).limit(1)
  if (!user || !await argon2.verify(user.passwordHash, password)) throw createError({ statusCode: 401, message: '密码不正确' })
  const token = getCookie(event, COOKIE) || getCookie(event, LEGACY_COOKIE)
  if (!token) throw createError({ statusCode: 401, message: '会话已失效' })
  const next = { ...session, reauthenticatedAt: Date.now() }
  await useRedis(event).set(sessionKey(token), JSON.stringify(next), 'EX', SESSION_TTL_SECONDS)
  await writeAudit(event, session.userId, 'session.reauthenticate', 'user', session.userId)
  return next
}

export async function changeOwnPassword(event: H3Event, currentPassword: string, newPassword: string) {
  if (newPassword.length < 8) throw createError({ statusCode: 400, message: '新密码至少 8 位' })
  const session = await reauthenticate(event, currentPassword)
  if (await argon2.verify((await useDatabase(event).select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, session.userId)).limit(1))[0]!.passwordHash, newPassword)) {
    throw createError({ statusCode: 400, message: '新密码不能与当前密码相同' })
  }
  await useDatabase(event).update(users).set({ passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }), mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, session.userId))
  const token = getCookie(event, COOKIE) || getCookie(event, LEGACY_COOKIE)
  const next: StoredSession = { ...session, mustChangePassword: false, reauthenticatedAt: Date.now() }
  if (token) await useRedis(event).set(sessionKey(token), JSON.stringify(next), 'EX', SESSION_TTL_SECONDS)
  await writeAudit(event, session.userId, 'user.password_change', 'user', session.userId)
  return next
}

export async function writeAudit(
  event: H3Event,
  adminId: string | null,
  action: string,
  targetType: string,
  targetId: string | null = null,
  detail: Record<string, unknown> = {}
) {
  await useDatabase(event).insert(auditLogs).values({
    adminId,
    action,
    targetType,
    targetId,
    detail,
    ipHash: hashClientIp(trustedClientIp(event), event)
  })
}

export async function auditedMutation<T>(event: H3Event, callback: () => Promise<T>) {
  return withDatabaseTransaction(event, callback)
}
