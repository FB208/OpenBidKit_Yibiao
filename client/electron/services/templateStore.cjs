const crypto = require('node:crypto');

function now() {
  return new Date().toISOString();
}

function createTemplateId() {
  return `tpl-${crypto.randomUUID()}`;
}

function resolveTemplateName(config) {
  return String(config?.template_name || '').trim() || '未命名模板';
}

function templateFromRow(row) {
  if (!row) return null;
  return {
    template_id: row.template_id,
    template_name: row.template_name,
    config: JSON.parse(row.config_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createTemplateStore({ db }) {
  function listTemplates() {
    return db.prepare(`
      SELECT template_id, template_name, config_json, created_at, updated_at
      FROM export_templates
      ORDER BY updated_at DESC, created_at DESC
    `).all().map(templateFromRow);
  }

  function getTemplate(templateId) {
    const row = db.prepare(`
      SELECT template_id, template_name, config_json, created_at, updated_at
      FROM export_templates
      WHERE template_id = ?
    `).get(templateId);
    return templateFromRow(row);
  }

  function createTemplate(config) {
    const timestamp = now();
    const templateId = createTemplateId();
    const templateName = resolveTemplateName(config);
    const nextConfig = { ...config, template_name: templateName };

    db.prepare(`
      INSERT INTO export_templates (template_id, template_name, config_json, created_at, updated_at)
      VALUES (@template_id, @template_name, @config_json, @created_at, @updated_at)
    `).run({
      template_id: templateId,
      template_name: templateName,
      config_json: JSON.stringify(nextConfig),
      created_at: timestamp,
      updated_at: timestamp,
    });

    return getTemplate(templateId);
  }

  function updateTemplate(templateId, config) {
    const templateName = resolveTemplateName(config);
    const nextConfig = { ...config, template_name: templateName };
    const result = db.prepare(`
      UPDATE export_templates
      SET template_name = @template_name,
          config_json = @config_json,
          updated_at = @updated_at
      WHERE template_id = @template_id
    `).run({
      template_id: templateId,
      template_name: templateName,
      config_json: JSON.stringify(nextConfig),
      updated_at: now(),
    });

    if (!result.changes) {
      throw new Error('模板不存在或已被删除');
    }

    return getTemplate(templateId);
  }

  function deleteTemplate(templateId) {
    const result = db.prepare('DELETE FROM export_templates WHERE template_id = ?').run(templateId);
    return {
      success: result.changes > 0,
      message: result.changes > 0 ? '模板已删除' : '模板不存在或已被删除',
    };
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
  };
}

module.exports = {
  createTemplateStore,
};
