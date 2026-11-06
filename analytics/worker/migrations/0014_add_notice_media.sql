-- 为既有公告补充展示类型和媒体配置，不修改版本、时间及送达数。
ALTER TABLE notices ADD COLUMN notice_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE notices ADD COLUMN media_json TEXT;
