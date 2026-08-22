import { and, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelGroupGrants, channels, channelUserGrants, groupMemberships, groups, hubKeys, keyChannelRules } from '../db/schema'
import { useRedis } from '../utils/redis'

export async function visibleChannels(event: H3Event, userId: string, keyId?: string) {
  const db = useDatabase(event)
  const [rows, directGrants, groupGrantRows, memberships, keyRules, key] = await Promise.all([
    db.select().from(channels).where(eq(channels.enabled, true)),
    db.select().from(channelUserGrants).where(eq(channelUserGrants.userId, userId)),
    db.select().from(channelGroupGrants),
    db.select({ groupId: groupMemberships.groupId }).from(groupMemberships)
      .innerJoin(groups, and(eq(groupMemberships.groupId, groups.id), eq(groups.status, 'active')))
      .where(eq(groupMemberships.userId, userId)),
    keyId ? db.select().from(keyChannelRules).where(eq(keyChannelRules.keyId, keyId)) : [],
    keyId ? db.select({ routeMode: hubKeys.routeMode }).from(hubKeys).where(eq(hubKeys.id, keyId)).limit(1) : []
  ])
  const directlyGranted = new Set(directGrants.map(grant => grant.channelId))
  const groupIds = new Set(memberships.map(membership => membership.groupId))
  const groupGranted = new Set(groupGrantRows.filter(grant => groupIds.has(grant.groupId)).map(grant => grant.channelId))
  const keyRestricted = keyRules.length > 0
  const allowedByKey = new Set(keyRules.map(rule => rule.channelId))
  const routeMode = keyId ? key[0]?.routeMode || 'platform_only' : null
  return rows.filter((channel) => {
    const visible = channel.ownerKind === 'user'
      ? channel.ownerUserId === userId && channel.accessScope === 'private'
      : channel.accessScope === 'all' || directlyGranted.has(channel.id) || groupGranted.has(channel.id)
    if (!visible || keyRestricted && !allowedByKey.has(channel.id)) return false
    if (routeMode === 'platform_only' && channel.ownerKind !== 'platform') return false
    if (routeMode === 'private_only' && channel.ownerKind !== 'user') return false
    return true
  })
}

export async function assertUserChannelAccess(event: H3Event, userId: string, channelIds: string[]) {
  if (!channelIds.length) return []
  const visible = await visibleChannels(event, userId)
  const allowed = new Set(visible.map(channel => channel.id))
  const invalid = channelIds.filter(id => !allowed.has(id))
  if (invalid.length) throw createError({ statusCode: 403, message: '所选中转不存在或当前用户无权使用' })
  return visible.filter(channel => channelIds.includes(channel.id))
}

export async function invalidateChannelAccess(event: H3Event, channelIds: string[]) {
  if (!channelIds.length) return
  const redis = useRedis(event)
  const keys = await redis.keys('hub:affinity:*')
  if (keys.length) await redis.del(...keys)
}
