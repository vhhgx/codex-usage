import type { UpstreamOperationView } from '../types/upstream-management'

const ACTION_LABELS: Record<string, string> = {
  'cpa.auth-file.delete': '删除 CPA 认证文件',
  'cpa.auth-file.status': '修改 CPA 认证文件状态',
  'cpa.auth-file.upload': '上传 CPA 认证文件',
  'cpa.auth-file.verify': '验证 CPA 认证文件',
  'cpa.proxy.default.update': '更新 CPA 默认代理',
  'sub.account.delete': '删除 Sub2API 账号',
  'sub.account.import': '导入 Sub2API 账号',
  'sub.account.import-data': '导入 Sub2API 账号包',
  'sub.account.oauth-complete': '完成 Sub2API 授权',
  'sub.account.update': '更新 Sub2API 账号',
  'sub.account.verify': '验证 Sub2API 账号',
  'sub.account.verify-activate': '验证并启用 Sub2API 账号',
  'sub.group.create': '创建 Sub2API 分组',
  'sub.group.delete': '删除 Sub2API 分组',
  'sub.group.update': '更新 Sub2API 分组',
  'sub.proxy.create': '创建代理',
  'sub.proxy.default.update': '更新 Sub2API 默认代理',
  'sub.proxy.delete': '删除代理',
  'sub.proxy.quality-check': '检测代理质量',
  'sub.proxy.test': '测试代理连通性',
  'sub.proxy.update': '更新代理'
}

const TARGET_TYPE_LABELS: Record<string, string> = {
  cpa_auth_file: 'CPA 认证文件',
  proxy_pool: '代理池',
  sub2api_account: 'Sub2API 账号',
  sub2api_account_bundle: 'Sub2API 账号包',
  sub2api_group: 'Sub2API 分组',
  sub2api_proxy: '代理',
  system_settings: '系统设置'
}

const CONNECTION_LABELS: Record<string, string> = {
  cpa: 'CPA',
  sub2api: 'Sub2API'
}

export function upstreamOperationActionLabel(action: string) {
  return ACTION_LABELS[action] || '其他号池操作'
}

export function upstreamOperationTargetTypeLabel(targetType: string) {
  return TARGET_TYPE_LABELS[targetType] || '其他目标'
}

export function upstreamOperationConnectionLabel(connectionId: string) {
  return CONNECTION_LABELS[connectionId] || '未知上游'
}

export function upstreamOperationTargetLabel(operation: Pick<UpstreamOperationView, 'safeSummary' | 'targetRef'>) {
  const name = operation.safeSummary.name
  return typeof name === 'string' && name.trim() ? name.trim() : operation.targetRef || '未指定目标'
}
