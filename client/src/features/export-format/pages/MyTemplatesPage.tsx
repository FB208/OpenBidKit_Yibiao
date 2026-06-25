import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { useToast } from '../../../shared/ui';
import type { ExportTemplateRecord } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { TemplatePreview } from './ExportFormatPage';

interface MyTemplatesPageProps {
  onCreateTemplate: () => void;
  onEditTemplate: (templateId: string) => void;
}

const templateDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function MyTemplatesPage({ onCreateTemplate, onEditTemplate }: MyTemplatesPageProps) {
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<ExportTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ExportTemplateRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const selectedTemplate = templates.find((template) => template.template_id === selectedId) || templates[0] || null;
  const previewConfig = selectedTemplate?.config || DEFAULT_EXPORT_FORMAT;
  const previewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(previewConfig), [previewConfig]);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const items = await window.yibiao?.templates.list();
      const nextTemplates = items || [];
      setTemplates(nextTemplates);
      setSelectedId((prev) => nextTemplates.some((template) => template.template_id === prev) ? prev : nextTemplates[0]?.template_id || '');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取模板列表失败', 'error');
      setTemplates([]);
      setSelectedId('');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    trackPageView('my-templates');
    void loadTemplates();
  }, [loadTemplates]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    try {
      const result = await window.yibiao?.templates.delete(deleteTarget.template_id);
      const nextTemplates = templates.filter((template) => template.template_id !== deleteTarget.template_id);
      setTemplates(nextTemplates);
      setSelectedId((prev) => prev === deleteTarget.template_id ? nextTemplates[0]?.template_id || '' : prev);
      setDeleteTarget(null);
      showToast(result?.message || '模板已删除', result?.success === false ? 'info' : 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除模板失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="template-library-page">
      <section className="template-library-panel" aria-label="我的模板">
        <div className="template-library-head">
          <div>
            <span className="section-kicker">模版设置</span>
            <h2>我的模板</h2>
            <p>查看、编辑和删除已保存的标书导出模板。</p>
          </div>
          <button type="button" className="primary-action" onClick={onCreateTemplate}>新建模板</button>
        </div>

        <div className="template-library-list">
          {loading ? <div className="template-library-empty"><strong>正在读取模板</strong><span>请稍候...</span></div> : null}
          {!loading && templates.length === 0 ? (
            <div className="template-library-empty">
              <strong>还没有保存模板</strong>
              <span>进入新建模板页配置排版样式，保存后会出现在这里。</span>
              <button type="button" className="primary-action" onClick={onCreateTemplate}>新建第一个模板</button>
            </div>
          ) : null}
          {!loading && templates.map((template) => {
            const selected = selectedTemplate?.template_id === template.template_id;
            return (
              <article className={`template-library-card${selected ? ' is-active' : ''}`} key={template.template_id}>
                <button type="button" className="template-library-card-main" onClick={() => setSelectedId(template.template_id)}>
                  <span>{template.template_name}</span>
                  <small>更新于 {formatTemplateDate(template.updated_at)}</small>
                </button>
                <div className="template-library-card-actions">
                  <button type="button" onClick={() => onEditTemplate(template.template_id)}>编辑</button>
                  <button type="button" className="is-danger" onClick={() => setDeleteTarget(template)}>删除</button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="template-library-preview-shell" aria-label="模板预览">
        {selectedTemplate ? (
          <>
            <div className="template-library-preview-head">
              <div>
                <span className="section-kicker">实时预览</span>
                <h3>{selectedTemplate.template_name}</h3>
              </div>
              <button type="button" className="secondary-action" onClick={() => onEditTemplate(selectedTemplate.template_id)}>编辑模板</button>
            </div>
            <TemplatePreview config={previewConfig} previewStyle={previewStyle} />
          </>
        ) : (
          <div className="template-library-preview-empty">
            <strong>暂无模板可预览</strong>
            <span>保存模板后，这里会展示模板效果。</span>
          </div>
        )}
      </section>

      <Dialog.Root open={Boolean(deleteTarget)} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="template-delete-dialog">
            <Dialog.Title>删除模板</Dialog.Title>
            <Dialog.Description>
              确定删除“{deleteTarget?.template_name || '未命名模板'}”吗？删除后无法在我的模板中继续编辑。
            </Dialog.Description>
            <div className="template-delete-actions">
              <Dialog.Close className="secondary-action" type="button" disabled={deleting}>取消</Dialog.Close>
              <button type="button" className="danger-action" onClick={() => void confirmDelete()} disabled={deleting}>{deleting ? '删除中' : '确认删除'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function formatTemplateDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '时间未知';
  }
  return templateDateFormatter.format(date);
}

export default MyTemplatesPage;
