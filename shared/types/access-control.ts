export type UserRole = 'super_admin' | 'admin' | 'operator' | 'auditor' | 'user'
export type UserStatus = 'active' | 'disabled' | 'locked'
export type GroupStatus = 'active' | 'disabled'

export interface HubGroupChannelRuleView {
  channelId: string
  enabled: boolean
  priorityOverride: number | null
  weightOverride: number | null
}

export interface HubUserView {
  id: string
  username: string
  displayName: string | null
  email: string | null
  role: UserRole
  status: UserStatus
  mustChangePassword: boolean
  lastLoginAt: number | null
  passwordChangedAt: number | null
  createdAt: number
  updatedAt: number
  groupIds: string[]
  groupNames: string[]
  keyCount: number
}

export interface HubGroupView {
  id: string
  name: string
  description: string | null
  status: GroupStatus
  allowedEndpoints: string[]
  rpmLimit: number | null
  concurrencyLimit: number | null
  dailyRequestLimit: number | null
  dailyTokenLimit: number | null
  dailyCostLimit: number | null
  weeklyRequestLimit: number | null
  weeklyTokenLimit: number | null
  weeklyCostLimit: number | null
  monthlyRequestLimit: number | null
  monthlyTokenLimit: number | null
  monthlyCostLimit: number | null
  priceMultiplier: number
  userIds: string[]
  userNames: string[]
  models: string[]
  channelIds: string[]
  channelRules: HubGroupChannelRuleView[]
  keyCount: number
  usage: { requests: number; tokens: number; cost: number }
  createdAt: number
  updatedAt: number
}
