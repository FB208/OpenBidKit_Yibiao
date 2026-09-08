const { cloneDefaultExportFormat } = require('./exportFormatDefaults.cjs');

/**
 * 系统预设导出模板的真源。
 *
 * 这里的定义每次启动都会幂等同步进 export_templates 表（见 templateStore.syncSystemTemplates），
 * 所以改预设样式只要改这个文件，不需要写数据库迁移。
 *
 * template_id 一经发布不可再改：technical_plan_generation_config.export_template_id 会引用它，
 * 改 id 等于让老用户已选的模板失效。数组顺序即"我的模板"里系统分组的展示顺序。
 */

/** 以默认导出格式为基线叠加骨架字段；page 需要单独浅合并，否则会整块覆盖。 */
function buildConfig(overrides) {
  const base = cloneDefaultExportFormat();
  return {
    ...base,
    ...overrides,
    page: { ...base.page, ...(overrides.page || {}) },
  };
}

const SYSTEM_EXPORT_TEMPLATES = [
  {
    template_id: 'tpl-system-standard-bid',
    config: buildConfig({
      template_name: '标准投标简版',
      page: {
        paper_size: 'a4',
        orientation: 'portrait',
        two_column: false,
        header_enabled: false,
        footer_enabled: false,
        page_number_enabled: true,
        header_footer_style: 'plain',
      },
    }),
  },
  {
    template_id: 'tpl-system-a4-visual',
    config: buildConfig({
      template_name: 'A4 图文版',
      page: {
        paper_size: 'a4',
        orientation: 'portrait',
        two_column: false,
        header_enabled: true,
        footer_enabled: true,
        page_number_enabled: true,
        header_footer_style: 'band',
        // 色带页脚整条铺强调色，页脚文字用的是 footer_color（渲染侧不会替我们改，
        // 见 client/开发说明.md 的页脚配色约定）。两者必须成对维护，否则用户填了
        // 页脚文字会得到同色不可见的字。#ffffff = contrastText('#536176')。
        chrome_accent_color: '#536176',
        footer_color: '#ffffff',
      },
    }),
    // TODO(样式细化): 标题边框、主题配色、表格与图片样式待补，当前只有版面骨架。
  },
  {
    template_id: 'tpl-system-a3-landscape-visual',
    config: buildConfig({
      template_name: 'A3 横版图文',
      page: {
        paper_size: 'a3',
        orientation: 'landscape',
        two_column: true,
        header_enabled: true,
        footer_enabled: true,
        page_number_enabled: true,
        header_footer_style: 'frame',
      },
    }),
    // TODO(样式细化): 整体表格布局（外框即表格边框）要走 exportService 的
    // getChapterFrameConfig / buildChapterFrameTable，本次只搭架子没有接。
  },
];

module.exports = {
  SYSTEM_EXPORT_TEMPLATES,
};
