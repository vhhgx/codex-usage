import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const channelTypeEnum = pgEnum('channel_type', ['cpa', 'sub2api'])
export const routingStrategyEnum = pgEnum('routing_strategy', ['priority', 'weighted_round_robin'])
export const keyStatusEnum = pgEnum('hub_key_status', ['active', 'disabled', 'expired'])
export const requestStatusEnum = pgEnum('request_status', ['pending', 'success', 'error', 'stream_aborted'])
export const userRoleEnum = pgEnum('user_role', ['super_admin', 'admin', 'operator', 'auditor', 'user'])
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled', 'locked'])
export const groupStatusEnum = pgEnum('group_status', ['active', 'disabled'])
export const membershipRoleEnum = pgEnum('membership_role', ['member', 'manager'])
export const upstreamOperationStatusEnum = pgEnum('upstream_operation_status', [
  'pending',
  'succeeded',
  'failed',
  'reconciliation_required'
])

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull(),
  displayName: text('display_name'),
  email: text('email'),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull().default('user'),
  status: userStatusEnum('status').notNull().default('active'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  ...timestamps
}, table => [
  uniqueIndex('users_username_idx').on(table.username),
  uniqueIndex('users_email_idx').on(table.email),
  index('users_role_status_idx').on(table.role, table.status)
])

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  status: groupStatusEnum('status').notNull().default('active'),
  allowedEndpoints: jsonb('allowed_endpoints').$type<string[]>().notNull().default([]),
  rpmLimit: integer('rpm_limit'),
  concurrencyLimit: integer('concurrency_limit'),
  dailyRequestLimit: bigint('daily_request_limit', { mode: 'number' }),
  dailyTokenLimit: bigint('daily_token_limit', { mode: 'number' }),
  dailyCostLimit: numeric('daily_cost_limit', { precision: 20, scale: 8 }),
  weeklyRequestLimit: bigint('weekly_request_limit', { mode: 'number' }),
  weeklyTokenLimit: bigint('weekly_token_limit', { mode: 'number' }),
  weeklyCostLimit: numeric('weekly_cost_limit', { precision: 20, scale: 8 }),
  monthlyRequestLimit: bigint('monthly_request_limit', { mode: 'number' }),
  monthlyTokenLimit: bigint('monthly_token_limit', { mode: 'number' }),
  monthlyCostLimit: numeric('monthly_cost_limit', { precision: 20, scale: 8 }),
  priceMultiplier: numeric('price_multiplier', { precision: 12, scale: 6 }).notNull().default('1'),
  ...timestamps
}, table => [uniqueIndex('groups_name_idx').on(table.name), index('groups_status_idx').on(table.status)])

export const groupMemberships = pgTable('group_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: membershipRoleEnum('role').notNull().default('member'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('group_memberships_group_user_idx').on(table.groupId, table.userId),
  index('group_memberships_user_idx').on(table.userId)
])

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  type: channelTypeEnum('type').notNull(),
  baseUrl: text('base_url').notNull(),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  priority: integer('priority').notNull().default(100),
  weight: integer('weight').notNull().default(1),
  maxConcurrency: integer('max_concurrency').notNull().default(20),
  timeoutMs: integer('timeout_ms').notNull().default(120000),
  priceMultiplier: numeric('price_multiplier', { precision: 12, scale: 6 }).notNull().default('1'),
  healthStatus: text('health_status').notNull().default('unknown'),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  lastHealthError: text('last_health_error'),
  ...timestamps
}, table => [index('channels_enabled_priority_idx').on(table.enabled, table.priority)])

export const channelModels = pgTable('channel_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  publicModel: text('public_model').notNull(),
  upstreamModel: text('upstream_model').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  endpoints: jsonb('endpoints').$type<string[]>().notNull().default([]),
  ...timestamps
}, table => [
  uniqueIndex('channel_models_channel_public_idx').on(table.channelId, table.publicModel),
  index('channel_models_public_enabled_idx').on(table.publicModel, table.enabled)
])

export const groupModelRules = pgTable('group_model_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  publicModel: text('public_model').notNull(),
  ...timestamps
}, table => [uniqueIndex('group_model_rules_group_model_idx').on(table.groupId, table.publicModel)])

export const groupChannelRules = pgTable('group_channel_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  priorityOverride: integer('priority_override'),
  weightOverride: integer('weight_override'),
  ...timestamps
}, table => [
  uniqueIndex('group_channel_rules_group_channel_idx').on(table.groupId, table.channelId),
  index('group_channel_rules_channel_idx').on(table.channelId)
])

export const modelPools = pgTable('model_pools', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicModel: text('public_model').notNull(),
  strategy: routingStrategyEnum('strategy').notNull().default('priority'),
  enabled: boolean('enabled').notNull().default(true),
  ...timestamps
}, table => [uniqueIndex('model_pools_public_model_idx').on(table.publicModel)])

export const hubKeys = pgTable('hub_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  note: text('note'),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyLastFour: text('key_last_four').notNull(),
  encryptedKey: text('encrypted_key'),
  encryptionKeyVersion: text('encryption_key_version'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'restrict' }),
  secretUpdatedAt: timestamp('secret_updated_at', { withTimezone: true }),
  secretUpdatedBy: uuid('secret_updated_by').references(() => users.id, { onDelete: 'set null' }),
  status: keyStatusEnum('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  allowedEndpoints: jsonb('allowed_endpoints').$type<string[]>().notNull().default([]),
  rpmLimit: integer('rpm_limit'),
  concurrencyLimit: integer('concurrency_limit'),
  totalRequestLimit: bigint('total_request_limit', { mode: 'number' }),
  totalTokenLimit: bigint('total_token_limit', { mode: 'number' }),
  totalCostLimit: numeric('total_cost_limit', { precision: 20, scale: 8 }),
  dailyRequestLimit: bigint('daily_request_limit', { mode: 'number' }),
  dailyTokenLimit: bigint('daily_token_limit', { mode: 'number' }),
  dailyCostLimit: numeric('daily_cost_limit', { precision: 20, scale: 8 }),
  weeklyRequestLimit: bigint('weekly_request_limit', { mode: 'number' }),
  weeklyTokenLimit: bigint('weekly_token_limit', { mode: 'number' }),
  weeklyCostLimit: numeric('weekly_cost_limit', { precision: 20, scale: 8 }),
  monthlyRequestLimit: bigint('monthly_request_limit', { mode: 'number' }),
  monthlyTokenLimit: bigint('monthly_token_limit', { mode: 'number' }),
  monthlyCostLimit: numeric('monthly_cost_limit', { precision: 20, scale: 8 }),
  maxRequestTokens: bigint('max_request_tokens', { mode: 'number' }),
  maxRequestCost: numeric('max_request_cost', { precision: 20, scale: 8 }),
  maxImageCount: integer('max_image_count'),
  allowedImageSizes: jsonb('allowed_image_sizes').$type<string[]>().notNull().default([]),
  allowedImageQualities: jsonb('allowed_image_qualities').$type<string[]>().notNull().default([]),
  priceMultiplier: numeric('price_multiplier', { precision: 12, scale: 6 }).notNull().default('1'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  ...timestamps
}, table => [
  uniqueIndex('hub_keys_hash_idx').on(table.keyHash),
  index('hub_keys_status_idx').on(table.status),
  index('hub_keys_owner_group_idx').on(table.ownerUserId, table.groupId)
])

export const hubKeyCredentials = pgTable('hub_key_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyId: uuid('key_id').notNull().references(() => hubKeys.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyLastFour: text('key_last_four').notNull(),
  encryptedKey: text('encrypted_key'),
  encryptionKeyVersion: text('encryption_key_version'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  ...timestamps
}, table => [
  uniqueIndex('hub_key_credentials_hash_idx').on(table.keyHash),
  index('hub_key_credentials_key_status_idx').on(table.keyId, table.status)
])

export const keyModelRules = pgTable('key_model_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyId: uuid('key_id').notNull().references(() => hubKeys.id, { onDelete: 'cascade' }),
  publicModel: text('public_model').notNull(),
  ...timestamps
}, table => [uniqueIndex('key_model_rules_key_model_idx').on(table.keyId, table.publicModel)])

export const modelPrices = pgTable('model_prices', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicModel: text('public_model').notNull(),
  inputPerMillion: numeric('input_per_million', { precision: 20, scale: 8 }).notNull().default('0'),
  outputPerMillion: numeric('output_per_million', { precision: 20, scale: 8 }).notNull().default('0'),
  cachedPerMillion: numeric('cached_per_million', { precision: 20, scale: 8 }).notNull().default('0'),
  reasoningPerMillion: numeric('reasoning_per_million', { precision: 20, scale: 8 }).notNull().default('0'),
  imagePrices: jsonb('image_prices').$type<Record<string, number>>().notNull().default({}),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
}, table => [index('model_prices_model_effective_idx').on(table.publicModel, table.effectiveAt)])

export const requestLogs = pgTable('request_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: text('request_id').notNull(),
  keyId: uuid('key_id').references(() => hubKeys.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
  endpoint: text('endpoint').notNull(),
  requestedModel: text('requested_model'),
  upstreamModel: text('upstream_model'),
  channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
  status: requestStatusEnum('status').notNull().default('pending'),
  httpStatus: integer('http_status'),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull().default(0),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
  imageCount: integer('image_count').notNull().default(0),
  cost: numeric('cost', { precision: 20, scale: 8 }).notNull().default('0'),
  firstByteMs: integer('first_byte_ms'),
  durationMs: integer('duration_ms'),
  failoverCount: integer('failover_count').notNull().default(0),
  streaming: boolean('streaming').notNull().default(false),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  clientIpHash: text('client_ip_hash'),
  requestBodyObject: text('request_body_object'),
  requestBodyHash: text('request_body_hash'),
  responseBodyObject: text('response_body_object'),
  responseBodyHash: text('response_body_hash'),
  bodyExpiresAt: timestamp('body_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, table => [
  uniqueIndex('request_logs_request_id_idx').on(table.requestId),
  index('request_logs_created_idx').on(table.createdAt),
  index('request_logs_key_created_idx').on(table.keyId, table.createdAt),
  index('request_logs_user_created_idx').on(table.userId, table.createdAt),
  index('request_logs_group_created_idx').on(table.groupId, table.createdAt),
  index('request_logs_model_created_idx').on(table.requestedModel, table.createdAt)
])

export const requestAttempts = pgTable('request_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  requestLogId: uuid('request_log_id').notNull().references(() => requestLogs.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
  attempt: integer('attempt').notNull(),
  status: text('status').notNull(),
  httpStatus: integer('http_status'),
  durationMs: integer('duration_ms'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [index('request_attempts_log_idx').on(table.requestLogId)])

export const idempotencyRecords = pgTable('idempotency_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyId: uuid('key_id').notNull().references(() => hubKeys.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  idempotencyKeyHash: text('idempotency_key_hash').notNull(),
  requestHash: text('request_hash').notNull(),
  status: text('status').notNull().default('processing'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
  responseStatus: integer('response_status'),
  responseContentType: text('response_content_type'),
  responseBodyObject: text('response_body_object'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...timestamps
}, table => [
  uniqueIndex('idempotency_key_endpoint_idx').on(table.keyId, table.endpoint, table.idempotencyKeyHash),
  index('idempotency_updated_idx').on(table.updatedAt)
])

export const usageRollups = pgTable('usage_rollups', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
  granularity: text('granularity').notNull(),
  keyId: uuid('key_id').references(() => hubKeys.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
  model: text('model'),
  endpoint: text('endpoint').notNull(),
  status: text('status').notNull().default('success'),
  channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
  requests: bigint('requests', { mode: 'number' }).notNull().default(0),
  admittedRequests: bigint('admitted_requests', { mode: 'number' }).notNull().default(0),
  successes: bigint('successes', { mode: 'number' }).notNull().default(0),
  failures: bigint('failures', { mode: 'number' }).notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
  cost: numeric('cost', { precision: 20, scale: 8 }).notNull().default('0'),
  durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
  latencyCount: bigint('latency_count', { mode: 'number' }).notNull().default(0),
  latencyLe100: bigint('latency_le_100', { mode: 'number' }).notNull().default(0),
  latencyLe250: bigint('latency_le_250', { mode: 'number' }).notNull().default(0),
  latencyLe500: bigint('latency_le_500', { mode: 'number' }).notNull().default(0),
  latencyLe1000: bigint('latency_le_1000', { mode: 'number' }).notNull().default(0),
  latencyLe2500: bigint('latency_le_2500', { mode: 'number' }).notNull().default(0),
  latencyLe5000: bigint('latency_le_5000', { mode: 'number' }).notNull().default(0),
  latencyLe10000: bigint('latency_le_10000', { mode: 'number' }).notNull().default(0),
  failovers: bigint('failovers', { mode: 'number' }).notNull().default(0),
  ...timestamps
}, table => [unique('usage_rollups_dimensions_unique').on(
  table.bucketStart,
  table.granularity,
  table.keyId,
  table.userId,
  table.groupId,
  table.model,
  table.endpoint,
  table.status,
  table.channelId
).nullsNotDistinct()])

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  adminId: uuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  ipHash: text('ip_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [index('audit_logs_created_idx').on(table.createdAt)])

export const upstreamControlOperations = pgTable('upstream_control_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: text('request_id').notNull(),
  adminId: uuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
  connectionId: text('connection_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetRef: text('target_ref'),
  idempotencyKeyHash: text('idempotency_key_hash'),
  requestFingerprint: text('request_fingerprint').notNull(),
  status: upstreamOperationStatusEnum('status').notNull().default('pending'),
  upstreamStatus: integer('upstream_status'),
  upstreamRequestId: text('upstream_request_id'),
  safeSummary: jsonb('safe_summary').$type<Record<string, unknown>>().notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, table => [
  index('upstream_operations_started_idx').on(table.startedAt),
  index('upstream_operations_status_idx').on(table.status),
  uniqueIndex('upstream_operations_idempotency_idx')
    .on(table.connectionId, table.action, table.idempotencyKeyHash)
])

export const systemSettings = pgTable('system_settings', {
  id: integer('id').primaryKey().default(1),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  bodyRetentionDays: integer('body_retention_days').notNull().default(30),
  metadataRetentionDays: integer('metadata_retention_days').notNull().default(365),
  defaultTimeoutMs: integer('default_timeout_ms').notNull().default(120000),
  circuitFailureThreshold: integer('circuit_failure_threshold').notNull().default(3),
  circuitCooldownMs: integer('circuit_cooldown_ms').notNull().default(30000),
  errorMessageOverrides: jsonb('error_message_overrides').$type<Record<string, string>>().notNull().default({}),
  sub2apiDefaultProxyUpstreamId: integer('sub2api_default_proxy_upstream_id'),
  cpaDefaultProxyUpstreamId: integer('cpa_default_proxy_upstream_id'),
  ...timestamps
})

export const servicePlans = pgTable('service_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  mode: text('mode').notNull().default('unlimited'),
  cycle: text('cycle').notNull().default('none'),
  tokenLimit: bigint('token_limit', { mode: 'number' }),
  costLimit: numeric('cost_limit', { precision: 20, scale: 8 }),
  price: numeric('price', { precision: 20, scale: 2 }).notNull().default('0'),
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
}, table => [
  uniqueIndex('service_plans_name_idx').on(table.name),
  index('service_plans_status_idx').on(table.status)
])

export const userSubscriptions = pgTable('user_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').notNull().references(() => servicePlans.id, { onDelete: 'restrict' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
}, table => [
  uniqueIndex('user_subscriptions_user_idx').on(table.userId),
  index('user_subscriptions_plan_idx').on(table.planId),
  index('user_subscriptions_status_expiry_idx').on(table.status, table.expiresAt)
])

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  tone: text('tone').notNull().default('info'),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
}, table => [
  index('announcements_status_published_idx').on(table.status, table.publishedAt),
  index('announcements_expires_idx').on(table.expiresAt)
])

export const accountVaultEntries = pgTable('account_vault_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  status: text('status').notNull().default('Codex'),
  encryptedPassword: text('encrypted_password').notNull(),
  encryptedAccessToken: text('encrypted_access_token'),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  encryptedEmailCodeUrl: text('encrypted_email_code_url'),
  smsVerifiedAt: timestamp('sms_verified_at', { withTimezone: true }),
  sub2apiAccountId: text('sub2api_account_id'),
  sub2apiPoolStatus: text('sub2api_pool_status').notNull().default('not_added'),
  codexAddedAt: timestamp('codex_added_at', { withTimezone: true }),
  sub2apiRemovedAt: timestamp('sub2api_removed_at', { withTimezone: true }),
  purchaseDate: text('purchase_date'),
  warrantyDate: text('warranty_date'),
  warrantyStatus: text('warranty_status').notNull().default('有质保'),
  smsUrl: text('sms_url'),
  phone: text('phone'),
  remark: text('remark'),
  sourceRef: text('source_ref'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
}, table => [
  index('account_vault_email_idx').on(table.email),
  index('account_vault_status_idx').on(table.status),
  index('account_vault_sub2api_pool_status_idx').on(table.sub2apiPoolStatus),
  index('account_vault_sub2api_account_idx').on(table.sub2apiAccountId),
  uniqueIndex('account_vault_source_ref_idx').on(table.sourceRef)
])

export const smsReceivers = pgTable('sms_receivers', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull(),
  phoneKey: text('phone_key').notNull(),
  providerHost: text('provider_host').notNull(),
  encryptedFetchUrl: text('encrypted_fetch_url').notNull(),
  note: text('note'),
  status: text('status').notNull().default('active'),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  lastFetchStatus: text('last_fetch_status'),
  lastFetchError: text('last_fetch_error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
}, table => [
  uniqueIndex('sms_receivers_phone_key_idx').on(table.phoneKey),
  index('sms_receivers_status_idx').on(table.status)
])

export const smsReceiverBindings = pgTable('sms_receiver_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiverId: uuid('receiver_id').notNull().references(() => smsReceivers.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accountVaultEntries.id, { onDelete: 'set null' }),
  accountEmail: text('account_email').notNull(),
  accountDisplayName: text('account_display_name'),
  slot: integer('slot').notNull(),
  codeReceivedAt: timestamp('code_received_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  check('sms_receiver_bindings_slot_check', sql`${table.slot} between 1 and 3`),
  uniqueIndex('sms_receiver_bindings_account_idx').on(table.accountId),
  uniqueIndex('sms_receiver_bindings_receiver_slot_idx').on(table.receiverId, table.slot),
  index('sms_receiver_bindings_receiver_idx').on(table.receiverId)
])

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredOn: text('occurred_on').notNull(),
  type: text('type').notNull(),
  project: text('project').notNull().default(''),
  unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
  quantity: integer('quantity').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  note: text('note').notNull().default(''),
  sourceRef: text('source_ref'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps
}, table => [
  index('ledger_transactions_occurred_idx').on(table.occurredOn),
  index('ledger_transactions_type_idx').on(table.type),
  uniqueIndex('ledger_transactions_source_ref_idx').on(table.sourceRef)
])

export type Channel = typeof channels.$inferSelect
export type ChannelModel = typeof channelModels.$inferSelect
export type HubKey = typeof hubKeys.$inferSelect
export type HubKeyCredential = typeof hubKeyCredentials.$inferSelect
export type RequestLog = typeof requestLogs.$inferSelect
export type User = typeof users.$inferSelect
export type Group = typeof groups.$inferSelect
export type AccountVaultEntry = typeof accountVaultEntries.$inferSelect
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect
export type SmsReceiver = typeof smsReceivers.$inferSelect
export type ServicePlan = typeof servicePlans.$inferSelect
export type UserSubscription = typeof userSubscriptions.$inferSelect
export type Announcement = typeof announcements.$inferSelect
