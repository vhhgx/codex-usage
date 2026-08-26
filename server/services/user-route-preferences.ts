import { and, asc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { userPoolGroups, userRelayGroups, userRoutePreferences } from '../db/schema'

export const PACKAGE_SOURCE_ID = 'package'
export const PRIVATE_POOL_SOURCE_ID = 'private_pool'
export const relaySourceId = (id: string) => `relay:${id}`
export const relayGroupSourceId = (id: string) => `relay_group:${id}`

export function mergeUserFailoverSourceIds(stored: unknown, relayGroupIds: string[], includePackage = true, includePrivatePool = false) {
  const available = [...(includePackage ? [PACKAGE_SOURCE_ID] : []), ...relayGroupIds.map(relayGroupSourceId), ...(includePrivatePool ? [PRIVATE_POOL_SOURCE_ID] : [])]
  const availableSet = new Set(available)
  const groupSet = new Set(relayGroupIds)
  const saved = Array.isArray(stored) ? stored.flatMap((id) => {
    if (typeof id !== 'string') return []
    if (availableSet.has(id)) return [id]
    if (id.startsWith('relay:') && groupSet.has(id.slice(6))) return [relayGroupSourceId(id.slice(6))]
    return []
  }) : []
  return [...new Set([...saved, ...available])]
}

export async function getUserFailoverSourceIds(event: H3Event, ownerUserId: string, relayGroupIds?: string[]) {
  const db = useDatabase(event)
  const ids = relayGroupIds || (await db.select({ id: userRelayGroups.id }).from(userRelayGroups).where(eq(userRelayGroups.ownerUserId, ownerUserId)).orderBy(asc(userRelayGroups.createdAt), asc(userRelayGroups.name))).map(row => row.id)
  const [[preference], [pool]] = await Promise.all([
    db.select({ orderedSourceIds: userRoutePreferences.orderedSourceIds }).from(userRoutePreferences).where(eq(userRoutePreferences.userId, ownerUserId)).limit(1),
    db.select({ id: userPoolGroups.id }).from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  ])
  return mergeUserFailoverSourceIds(preference?.orderedSourceIds, ids, true, Boolean(pool))
}
