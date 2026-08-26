import { useState, type KeyboardEvent } from 'react';
import { AppDialog, isLibreOfficeRequiredMessage, UploadEmpty, UploadFilePill, UploadRow, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { TechnicalPlanOriginalPlanFile, TechnicalPlanState } from '../types';

type GenerationSettingsTab = 'content' | 'existing-plan' | 'length' | 'illustration' | 'writing' | 'appearance';

interface GenerationSettingsPageProps {
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  onOriginalPlanChanged: (state: TechnicalPlanState) => void;
}

const tabs: Array<{ id: GenerationSettingsTab; label: string }> = [
  { id: 'content', label: '写嘛' },
  { id: 'existing-plan', label: '我有方案' },
  { id: 'length', label: '写多少' },
  { id: 'illustration', label: '插图吗' },
  { id: 'writing', label: '怎么写' },
  { id: 'appearance', label: '长嘛样' },
];

const documentOptions = [
  '完整投标文件',
  '商务标独立成册',
  '技术方案独立成册',
];

// 汇总生成前配置，并在“我有方案”中管理扩写底稿。
function GenerationSettingsPage({ originalPlanFile, onOriginalPlanChanged }: GenerationSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<GenerationSettingsTab>('content');
  const [originalPlanBusy, setOriginalPlanBusy] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label || '';

  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);

  // 支持标准页签键盘导航，并把焦点同步到新页签。
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`generation-settings-tab-${nextTab.id}`)?.focus();
  };

  // 导入或替换已有方案，并刷新技术方案状态。
  const importOriginalPlan = async (filePaths?: string[]) => {
    try {
      setOriginalPlanBusy(true);
      const result = await window.yibiao?.technicalPlan.importOriginalPlanDocument(filePaths);
      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      if (!result.markdown) {
        showToast('已有方案解析结果为空', 'error');
        return;
      }
      onOriginalPlanChanged(await window.yibiao!.technicalPlan.loadState());
      showToast(result.message || '已有方案已导入', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '已有方案解析失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setOriginalPlanBusy(false);
    }
  };

  // 删除已有方案并切回普通生成流程。
  const removeOriginalPlan = async () => {
    try {
      setOriginalPlanBusy(true);
      const result = await window.yibiao!.technicalPlan.removeOriginalPlanDocument();
      if (!result.success) {
        showToast(result.message || '移除已有方案失败', 'error');
        return;
      }
      onOriginalPlanChanged(await window.yibiao!.technicalPlan.loadState());
      setRemoveDialogOpen(false);
      showToast(result.message || '已移除已有方案', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '移除已有方案失败', 'error');
    } finally {
      setOriginalPlanBusy(false);
    }
  };

  return (
    <div className="plan-step-body generation-settings-page">
      <section className="generation-settings-shell">
        <header className="bid-analysis-command-bar generation-settings-command-bar">
          <div>
            <span className="section-kicker">STEP 02</span>
            <strong>生成设置</strong>
            <p>在生成前集中设置投标文件的内容范围、篇幅、插图、写法和最终样式。</p>
          </div>
        </header>

        <div className="document-switch-tabs generation-settings-tabs" role="tablist" aria-label="生成设置分类">
          {tabs.map((tab, index) => {
            const active = tab.id === activeTab;
            return (
              <button
                type="button"
                className={`document-switch-tab generation-settings-tab${active ? ' is-active' : ''}`}
                id={`generation-settings-tab-${tab.id}`}
                aria-selected={active}
                aria-controls="generation-settings-panel"
                role="tab"
                tabIndex={active ? 0 : -1}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          className="bid-analysis-workspace generation-settings-panel"
          id="generation-settings-panel"
          aria-labelledby={`generation-settings-tab-${activeTab}`}
          role="tabpanel"
        >
          {activeTab === 'content' ? (
            <div className="generation-settings-option-grid">
              {documentOptions.map((option, index) => (
                <article className="generation-settings-option" key={option}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{option}</strong>
                  <small>具体设置稍后补充</small>
                </article>
              ))}
            </div>
          ) : activeTab === 'existing-plan' ? (
            <UploadRow
              index="01"
              title="已有技术方案"
              note="可选，仅保留一份"
              actions={(
                <button type="button" className="primary-action" onClick={() => void importOriginalPlan()} disabled={originalPlanBusy}>
                  {originalPlanBusy ? '处理中...' : originalPlanFile ? '替换' : '上传'}
                </button>
              )}
              onDropFiles={(files) => {
                const paths = resolveDroppedFilePaths(files);
                if (paths.length) void importOriginalPlan(paths);
              }}
              dropDisabled={originalPlanBusy}
            >
              {originalPlanFile ? (
                <UploadFilePill
                  badge="MD"
                  name={originalPlanFile.fileName}
                  meta={[originalPlanFile.parserLabel, `${originalPlanFile.markdownChars} 字`].filter(Boolean).join(' · ')}
                  onRemove={() => setRemoveDialogOpen(true)}
                  removeLabel="移除"
                  removeDisabled={originalPlanBusy}
                />
              ) : (
                <UploadEmpty title="等待已有技术方案" hint="上传后将在目录和正文阶段保留、优化并扩充原方案内容。">
                  <button type="button" className="text-button" onClick={() => void importOriginalPlan()} disabled={originalPlanBusy}>选择已有方案</button>
                </UploadEmpty>
              )}
            </UploadRow>
          ) : (
            <div className="generation-settings-placeholder" role="status">
              <strong>{activeTabLabel}设置待补充</strong>
              <p>当前先保留页面结构，后续按实际规则逐项接入。</p>
            </div>
          )}
        </div>
      </section>

      <AppDialog
        open={removeDialogOpen}
        onOpenChange={(open) => !originalPlanBusy && setRemoveDialogOpen(open)}
        kicker="移除已有方案"
        title="确认切回普通生成模式"
        description="移除后会保留招标文件和解析结果，并清空依赖原方案的目录、全局事实、正文和生成进度。"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setRemoveDialogOpen(false)} disabled={originalPlanBusy}>取消</button>
            <button type="button" className="danger-action" onClick={() => void removeOriginalPlan()} disabled={originalPlanBusy}>
              {originalPlanBusy ? '正在移除...' : '确认移除'}
            </button>
          </>
        )}
      />
    </div>
  );
}

export default GenerationSettingsPage;
