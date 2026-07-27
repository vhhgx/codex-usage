export interface CodexRadarModel {
  id: string
  model: string
  reasoningEffort: string
  intelligenceScore: number
  passed: number
  tasks: number
  costUsd: number
  wallSeconds: number
}

export interface CodexRadarResponse {
  models: CodexRadarModel[]
  updatedAt: number | null
  fetchedAt: number
  sourceUrl: string
}
