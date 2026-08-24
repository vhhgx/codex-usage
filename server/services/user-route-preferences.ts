import { and, asc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channels, userPoolGroups, userRoutePreferences } from '../db/schema'

export const PACKAGE_SOURCE_ID = 'package'
export const PRIVATE_POOL_SOURCE_ID = 'private_pool'
export const relaySourceId = (id: string) => `relay:${id}`

export function mergeUserFailoverSourceIds(stored: unknown, relayIds: string[], includePackage = true, includePrivatePool = false) {
  const available = [...(includePackage ? [PACKAGE_SOURCE_ID] : []), ...relayIds.map(relaySourceId), ...(includePrivatePool ? [PRIVATE_POOL_SOURCE_ID] : [])]
  const availableSet = new Set(available)
  const saved = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && availableSet.has(id)) : []
  return [...new Set([...saved, ...available])]
}

export async function getUserFailoverSourceIds(event: H3Event, ownerUserId: string, relayIds?: string[]) {
  const db = useDatabase(event)
  const ids = relayIds || (await db.select({ id: channels.id }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId))).orderBy(asc(channels.priority), asc(channels.name))).map(row => row.id)
  const [[preference], [pool]] = await Promise.all([
    db.select({ orderedSourceIds: userRoutePreferences.orderedSourceIds }).from(userRoutePreferences).where(eq(userRoutePreferences.userId, ownerUserId)).limit(1),
    db.select({ id: userPoolGroups.id }).from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  ])
  return mergeUserFailoverSourceIds(preference?.orderedSourceIds, ids, true, Boolean(pool))
}
