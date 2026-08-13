-- 记录上一版插件安装包，确保版本切换期间的在途下载仍可完成
ALTER TABLE plugins ADD COLUMN previous_version TEXT;
ALTER TABLE plugins ADD COLUMN previous_release_url TEXT;
