export function queryString(value: unknown) {
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : ''
}

export function activityLogQuery(keyId: string, bucketTimestamp: number, bucketEndTimestamp = bucketTimestamp + 60 * 60_000) {
  return {
    keyId,
    from: new Date(bucketTimestamp).toISOString(),
    to: new Date(bucketEndTimestamp).toISOString()
  }
}
