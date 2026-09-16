-- 增强 probe_model_catalog 表，支持智能探测

-- 添加新字段
ALTER TABLE probe_model_catalog
  ADD COLUMN IF NOT EXISTS vendor_family text,
  ADD COLUMN IF NOT EXISTS is_latest boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS release_date date,
  ADD COLUMN IF NOT EXISTS usage_priority integer DEFAULT 100;

-- 创建索引提高查询性能
CREATE INDEX IF NOT EXISTS probe_model_catalog_priority_idx
  ON probe_model_catalog(protocol, enabled, usage_priority, sort_order);

-- 添加注释说明
COMMENT ON COLUMN probe_model_catalog.usage_priority IS '探测优先级：10=最新旗舰, 20=次新, 30=稳定版, 100=兜底';
COMMENT ON COLUMN probe_model_catalog.sort_order IS '管理界面显示顺序';
COMMENT ON COLUMN probe_model_catalog.vendor_family IS '厂商家族：anthropic, openai, zhipu, deepseek等';
COMMENT ON COLUMN probe_model_catalog.is_latest IS '是否是最新模型';
COMMENT ON COLUMN probe_model_catalog.release_date IS '模型发布日期（用于排序）';

-- 更新现有数据（示例）
UPDATE probe_model_catalog SET usage_priority = 10 WHERE sort_order <= 10;
UPDATE probe_model_catalog SET usage_priority = 20 WHERE sort_order > 10 AND sort_order <= 20;
UPDATE probe_model_catalog SET usage_priority = 30 WHERE sort_order > 20;
