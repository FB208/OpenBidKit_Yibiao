import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { useToast } from '../../../shared/ui';
import type { ExportTemplateRecord } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { ExportTemplateEditorDialog, TemplatePreview } from './ExportFormatPage';

const templateDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function MyTemplatesPage() {
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<ExportTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit' | 'view'; templateId?: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExportTemplateRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState('');

  const selectedTemplate = templates.find((template) => template.template_id === selectedId) || templates[0] || null;
  const previewConfig = selectedTemplate?.config || DEFAULT_EXPORT_FORMAT;
  const systemTemplates = templates.filter((template) => template.is_system);
  const userTemplates = templates.filter((template) => !template.is_system);

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

  const handleTemplateSaved = useCallback(async (template: ExportTemplateRecord) => {
    await loadTemplates();
    setSelectedId(template.template_id);
  }, [loadTemplates]);

  const handleDuplicate = async (template: ExportTemplateRecord) => {
    if (duplicatingId) return;

    setDuplicatingId(template.template_id);
    try {
      const copy = await window.yibiao?.templates.duplicate(template.template_id);
      if (!copy) {
        throw new Error('复制模板失败');
      }
      await loadTemplates();
      setSelectedId(copy.template_id);
      showToast(`已复制为“${copy.template_name}”`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '复制模板失败', 'error');
    } finally {
      setDuplicatingId('');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    try {
      const result = await window.yibiao?.templates.delete(deleteTarget.template_id);
      if (result?.success === false) {
        showToast(result.message || '模板未删除', 'info');
        setDeleteTarget(null);
        return;
      }
      const nextTemplates = templates.filter((template) => template.template_id !== deleteTarget.template_id);
      setTemplates(nextTemplates);
      setSelectedId((prev) => prev === deleteTarget.template_id ? nextTemplates[0]?.template_id || '' : prev);
      setDeleteTarget(null);
      showToast(result?.message || '模板已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除模板失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const renderTemplateCard = (template: ExportTemplateRecord) => {
    const selected = selectedTemplate?.template_id === template.template_id;
    return (
      <article className={`template-library-card${selected ? ' is-active' : ''}`} key={template.template_id}>
        <button type="button" className="template-library-card-main" onClick={() => setSelectedId(template.template_id)}>
          <span>
            {template.template_name}
            {template.is_system ? <em className="template-library-system-badge">系统预设</em> : null}
          </span>
          <small>更新于 {formatTemplateDate(template.updated_at)}</small>
        </button>
        <div className="template-library-card-actions">
          {template.is_system ? (
            <>
              <button type="button" onClick={() => setEditor({ mode: 'view', templateId: template.template_id })}>查看</button>
              <button
                type="button"
                disabled={duplicatingId === template.template_id}
                onClick={() => { void handleDuplicate(template); }}
              >
                {duplicatingId === template.template_id ? '复制中' : '复制'}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditor({ mode: 'edit', templateId: template.template_id })}>编辑</button>
              <button type="button" className="is-danger" onClick={() => setDeleteTarget(template)}>删除</button>
            </>
          )}
        </div>
      </article>
    );
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
          <button type="button" className="primary-action" onClick={() => setEditor({ mode: 'create' })}>新建模板</button>
        </div>

        <div className="template-library-list">
          {loading ? <div className="template-library-empty"><strong>正在读取模板</strong><span>请稍候...</span></div> : null}
          {!loading && systemTemplates.length > 0 ? (
            <>
              <h3 className="template-library-group-title">系统预设模板</h3>
              <p className="template-library-group-hint">不可编辑和删除，复制一份后即可自由调整。</p>
              {systemTemplates.map(renderTemplateCard)}
            </>
          ) : null}
          {!loading ? (
            <>
              <h3 className="template-library-group-title">我的模板</h3>
              {userTemplates.length > 0 ? userTemplates.map(renderTemplateCard) : (
                <div className="template-library-empty">
                  <strong>还没有保存模板</strong>
                  <span>可以从系统预设复制一份改，也可以新建一个从头配置。</span>
                  <button type="button" className="primary-action" onClick={() => setEditor({ mode: 'create' })}>新建第一个模板</button>
                </div>
              )}
            </>
          ) : null}
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
              <button
                type="button"
                className="secondary-action"
                onClick={() => setEditor({
                  mode: selectedTemplate.is_system ? 'view' : 'edit',
                  templateId: selectedTemplate.template_id,
                })}
              >
                {selectedTemplate.is_system ? '查看模板' : '编辑模板'}
              </button>
            </div>
            {/* 编辑弹窗自带预览，两份样张同时挂载会各跑一次生成与排版 */}
            {!editor && <TemplatePreview config={previewConfig} />}
          </>
        ) : (
          <div className="template-library-preview-empty">
            <strong>暂无模板可预览</strong>
            <span>保存模板后，这里会展示模板效果。</span>
          </div>
        )}
      </section>

      <ExportTemplateEditorDialog
        open={Boolean(editor)}
        mode={editor?.mode || 'create'}
        templateId={editor?.templateId || null}
        returnLabel="返回我的模板"
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onSaved={handleTemplateSaved}
      />

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
