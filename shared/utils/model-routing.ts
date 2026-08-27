import type { ModelMappingKind, RelayModelScope } from '../types/hub'

const FAMILY_RULES: Array<[string, RegExp]> = [
  ['openai', /^(?:openai\/)?(?:gpt-|o[134](?:-|$)|codex)/i],
  ['anthropic', /^(?:anthropic\/)?claude-/i],
  ['zhipu', /^(?:zhipuai\/|zai-org\/|zai\/)?(?:glm-|chatglm)/i],
  ['google', /^(?:google\/)?gemini-/i],
  ['minimax', /^(?:minimax\/)?minimax-/i],
  ['doubao', /^(?:doubao\/)?(?:doubao-|seed-|ep-)/i],
  ['deepseek', /^(?:deepseek\/)?deepseek-/i],
  ['moonshot', /^(?:moonshot\/)?(?:kimi-|moonshot-)/i],
  ['qwen', /^(?:qwen\/|alibaba\/)?qwen/i],
  ['xai', /^(?:xai\/)?grok-/i]
]

export function modelVendorFamily(model: string) {
  const normalized = model.trim()
  return FAMILY_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] || 'other'
}

export function modelScope(model: string): RelayModelScope {
  const family = modelVendorFamily(model)
  return family === 'openai' ? 'gpt' : family === 'anthropic' ? 'claude' : 'other'
}

export function canonicalModelId(model: string) {
  return model.trim().replace(/^(?:openai|anthropic|google|zhipuai|zai-org|zai|deepseek|moonshot|qwen|alibaba|xai|minimax|doubao)\//i, '')
}

export function modelRevision(model: string) {
  const value = canonicalModelId(model)
  const dated = value.match(/(?:^|[-_.])((?:20)?\d{6,8})(?:$|[-_.])/)
  if (dated?.[1]) return dated[1]
  const versions = [...value.matchAll(/(?:^|[-_.])v?(\d+(?:\.\d+){0,3})(?=$|[-_.])/gi)]
  return versions.at(-1)?.[1] || null
}

function versionParts(model: string) {
  const revision = modelRevision(model)
  if (!revision) return []
  return revision.split('.').map(value => Number(value) || 0)
}

export function compareModelVersionsNewest(left: string, right: string) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] || 0) - (a[index] || 0)
    if (difference) return difference
  }
  return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' })
}

export function inferMappingKind(publicModel: string, upstreamModel: string): ModelMappingKind {
  if (publicModel.trim().toLowerCase() === upstreamModel.trim().toLowerCase()) return 'identity'
  return canonicalModelId(publicModel).toLowerCase() === canonicalModelId(upstreamModel).toLowerCase() ? 'alias' : 'substitution'
}

export function latestModelsByFamily(models: string[]) {
  const groups = new Map<string, string[]>()
  for (const model of models) {
    const family = modelVendorFamily(model)
    groups.set(family, [...(groups.get(family) || []), model])
  }
  return [...groups.entries()].map(([family, values]) => ({ family, model: [...values].sort(compareModelVersionsNewest)[0]! }))
}
