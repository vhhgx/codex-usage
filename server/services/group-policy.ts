export interface GroupChannelPolicyRule {
  channelId: string
  enabled: boolean
  priorityOverride: number | null
  weightOverride: number | null
}

export function policyAllows(allowed: string[], requested: string) {
  return allowed.length === 0 || allowed.includes(requested)
}

export function intersectPolicyValues(systemValues: string[], groupValues: string[], keyValues: string[]) {
  return [...new Set(systemValues)].filter(value => policyAllows(groupValues, value) && policyAllows(keyValues, value))
}

export function applyGroupChannelPolicy<T extends { channel: { id: string; name: string; priority: number; weight: number } }>(rows: T[], rules: GroupChannelPolicyRule[]) {
  const byChannel = new Map(rules.map(rule => [rule.channelId, rule]))
  return rows
    .filter(row => rules.length === 0 || byChannel.get(row.channel.id)?.enabled === true)
    .map(row => {
      const rule = byChannel.get(row.channel.id)
      return { ...row, channel: { ...row.channel, priority: rule?.priorityOverride ?? row.channel.priority, weight: rule?.weightOverride ?? row.channel.weight } }
    })
    .sort((left, right) => left.channel.priority - right.channel.priority || left.channel.name.localeCompare(right.channel.name))
}

export function effectivePriceMultiplier(group: number, key: number, channel: number) {
  return Math.max(0, group) * Math.max(0, key) * Math.max(0, channel)
}
