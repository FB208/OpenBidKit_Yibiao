import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useState } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { bidAnalysisTasks, getBidAnalysisTasks } from '../services/bidAnalysisWorkflow';
import { MarkdownRenderer, useToast } from '../../../shared/ui';
import type { BackgroundTaskState, BidAnalysisMode, BidAnalysisTasks, BidAnalysisTaskState, TechnicalPlanState } from '../types';

interface BidAnalysisPageProps {
  hasTenderFile: boolean;
  mode: BidAnalysisMode;
  selectedTaskIds: string[];
  tasks: BidAnalysisTasks;
  task?: BackgroundTaskState;
  progress: number;
  onProgressChange: (progress: number) => void;
  onConfigSaved: (state: TechnicalPlanState) => void;
}

const modeOptions: Array<{ id: 'key' | 'full'; title: string; badge: string }> = [
  {
    id: 'key',
    title: '只解析关键项',
    badge: '默认',
  },
  {
    id: 'full',
    title: '完整解析',
    badge: '更多 Token',
  },
];

const allBidAnalysisTaskIds = bidAnalysisTasks.map((task) => task.id);
const requiredBidAnalysisTaskIds = getBidAnalysisTasks('key').map((task) => task.id);
const requiredBidAnalysisTaskIdSet = new Set(requiredBidAnalysisTaskIds);

function normalizeSelectedTaskIds(taskIds: string[]) {
  const requestedIds = new Set(taskIds);
  return allBidAnalysisTaskIds.filter((taskId) => requiredBidAnalysisTaskIdSet.has(taskId) || requestedIds.has(taskId));
}

function getSelectedTaskIdsForMode(mode: BidAnalysisMode, taskIds: string[]) {
  if (mode === 'full') {
    return allBidAnalysisTaskIds;
  }
  if (mode === 'custom') {
    return normalizeSelectedTaskIds(taskIds);
  }
  return requiredBidAnalysisTaskIds;
}

function getModeForSelection(taskIds: string[]): BidAnalysisMode {
  const selectedIds = normalizeSelectedTaskIds(taskIds);
  if (selectedIds.length === allBidAnalysisTaskIds.length) {
    return 'full';
  }
  if (selectedIds.some((taskId) => !requiredBidAnalysisTaskIdSet.has(taskId))) {
    return 'custom';
  }
  return 'key';
}

function getModeLabel(mode: BidAnalysisMode) {
  if (mode === 'full') return '完整解析';
  if (mode === 'custom') return '自定义解析';
  return '只解析关键项';
}

const taskGroups = [
  { title: '关键项', ids: ['projectOverview', 'techRequirements', 'projectInfo', 'partAInfo', 'deliveryAndServiceRequirements'] },
  { title: '采购与响应', ids: ['procurementList', 'responseFileRequirements'] },
  { title: '投标流程', ids: ['keyInfo', 'marginInfo', 'openBid'] },
  { title: '评审要求', ids: ['qualificationReview', 'complianceCheck', 'evaluationBid', 'businessScoring'] },
  { title: '主体与合同', ids: ['agentInfo', 'discardedBids', 'signingProcess', 'terminationCondition'] },
];

const statusLabel: Record<BidAnalysisTaskState['status'], string> = {
  idle: '待解析',
  running: '解析中',
  success: '已完成',
  error: '失败',
};

const jsonFieldLabels: Record<string, string> = {
  project_name: '项目名称',
  project_number: '项目编号',
  project_type: '项目类型',
  project_budget: '项目预算',
  project_address: '项目地址',
  company_name: '公司名称',
  address: '地址',
  contact_person: '联系人',
  contact_phone: '联系电话',
  email: '联系邮箱',
  bank_account_name: '银行账户名称',
  bank_account_number: '银行账户账号',
  bank_account_address: '银行账户开户行',
  bank_account_address_detail: '银行账户开户行地址',
  bid_announcement_time: '招标公告发布日期',
  bid_file_get_way: '招标文件获取方式',
  bid_file_price: '招标文件售价',
  get_bid_file_time: '获取招标文件时间',
  bid_document_submission_location: '投标文件提交地点',
  bid_submission_deadline: '投标截止时间',
  bid_opening_time: '开标时间',
  bid_opening_address: '开标地点',
  other_notes: '其他注意事项',
  bidding_deposit: '投标保证金',
  payment_method: '缴纳方式',
  due_date: '截止日期',
  refund_conditions: '退还条件',
  non_refundable_conditions: '不予退还的情形',
  time_place: '时间地点',
  part_req: '参与要求',
  invalid_bid: '无效标认定',
  objection: '异议处理',
  bid_process: '开标流程',
  committee: '评标委员会组成',
  duties: '评标委员会职责',
  scoring: '评分构成',
  method: '评标方法类型',
  principles: '评标原则和方法细节',
  others: '其他信息',
  bid_notice: '中标公示',
  contract_sign: '合同签订',
  performance_bond: '履约保证金',
  contract_text: '合同文本',
  breach_termination: '违约解除',
  force_majeure: '不可抗力',
  contract_termination: '合同终止',
  dispute_resolution: '争议解决',
  implementation_period: '实施周期/工期/交付期限',
  delivery_scope: '交付范围',
  delivery_location: '交付/实施地点',
  acceptance_requirements: '验收要求',
  warranty_period: '质保期',
  after_sales_service: '售后服务要求',
  response_time: '响应时限',
  training_requirements: '培训要求',
  documentation_requirements: '资料/文档交付要求',
};

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '没有提及';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

function JsonResultTable({ content }: { content: string }) {
  const data = tryParseJsonObject(content);

  if (!data) {
    return (
      <div className="markdown-viewer bid-analysis-output">
        <MarkdownRenderer>
          {`\`\`\`json\n${content}\n\`\`\``}
        </MarkdownRenderer>
      </div>
    );
  }

  return (
    <div className="bid-analysis-json-table-wrap">
      <table className="bid-analysis-json-table">
        <tbody>
          {Object.entries(data).map(([key, value]) => (
            <tr key={key}>
              <th>{jsonFieldLabels[key] || key}</th>
              <td>{formatJsonValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BidAnalysisPage({
  hasTenderFile,
  mode,
  selectedTaskIds,
  tasks,
  task,
  progress,
  onProgressChange,
  onConfigSaved,
}: BidAnalysisPageProps) {
  const [running, setRunning] = useState(false);
  const [fullRerunLocked, setFullRerunLocked] = useState(false);
  const [fullRerunSeenRunning, setFullRerunSeenRunning] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('projectOverview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSelectedTaskIds, setDraftSelectedTaskIds] = useState<string[]>(() => getSelectedTaskIdsForMode(mode, selectedTaskIds));
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const { showToast } = useToast();
  const effectiveSelectedTaskIds = useMemo(() => getSelectedTaskIdsForMode(mode, selectedTaskIds), [mode, selectedTaskIds]);
  const selectedTasks = useMemo(() => {
    const selectedIdSet = new Set(effectiveSelectedTaskIds);
    return bidAnalysisTasks.filter((task) => selectedIdSet.has(task.id));
  }, [effectiveSelectedTaskIds]);
  const requiredTasks = useMemo(() => getBidAnalysisTasks('key'), []);
  const visibleSelectedTaskId = selectedTasks.some((task) => task.id === selectedTaskId)
    ? selectedTaskId
    : selectedTasks[0]?.id || 'projectOverview';
  const activeTask = selectedTasks.find((task) => task.id === visibleSelectedTaskId) || selectedTasks[0];
  const activeTaskState = activeTask ? tasks[activeTask.id] : undefined;
  const activeTaskStatus = activeTaskState?.status || 'idle';
  const activeTaskContent = activeTaskState?.content || '';
  const failedTaskCount = selectedTasks.filter((task) => tasks[task.id]?.status === 'error').length;
  const doneCount = selectedTasks.filter((task) => {
    const status = tasks[task.id]?.status;
    return status === 'success' || status === 'error';
  }).length;
  const taskRunning = running || fullRerunLocked || task?.status === 'running';
  const requiredDone = requiredTasks.every((task) => tasks[task.id]?.status === 'success' && tasks[task.id]?.content);
  const configLabel = getModeLabel(mode);

  const syncProgressForSelection = (nextTaskIds: string[]) => {
    const selectedIdSet = new Set(normalizeSelectedTaskIds(nextTaskIds));
    const nextTasks = bidAnalysisTasks.filter((task) => selectedIdSet.has(task.id));
    const nextDoneCount = nextTasks.filter((task) => {
      const status = tasks[task.id]?.status;
      return status === 'success' || status === 'error';
    }).length;
    onProgressChange(Math.round((nextDoneCount / nextTasks.length) * 100));
  };

  useEffect(() => {
    if (!fullRerunLocked) {
      return;
    }

    if (task?.status === 'running') {
      setFullRerunSeenRunning(true);
      return;
    }

    if (fullRerunSeenRunning && task?.status) {
      setFullRerunLocked(false);
      setFullRerunSeenRunning(false);
    }
  }, [fullRerunLocked, fullRerunSeenRunning, task?.status]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    setDraftSelectedTaskIds(effectiveSelectedTaskIds);
  }, [effectiveSelectedTaskIds, settingsOpen]);

  const openSettingsDialog = () => {
    if (taskRunning) {
      showToast('招标文件解析任务正在运行，请等待任务结束后再调整配置', 'info');
      return;
    }
    setDraftSelectedTaskIds(effectiveSelectedTaskIds);
    setSettingsOpen(true);
  };

  const saveConfig = async (nextTaskIds = draftSelectedTaskIds, closeDialog = true) => {
    const normalizedTaskIds = normalizeSelectedTaskIds(nextTaskIds);
    const nextMode = getModeForSelection(normalizedTaskIds);
    const saved = await window.yibiao?.technicalPlan.saveBidAnalysisConfig({ mode: nextMode, selectedTaskIds: normalizedTaskIds });
    if (saved) {
      onConfigSaved(saved);
    }
    syncProgressForSelection(normalizedTaskIds);
    if (closeDialog) {
      setSettingsOpen(false);
      showToast('招标文件解析配置已保存', 'success');
    }
    return { mode: nextMode, selectedTaskIds: normalizedTaskIds };
  };

  const startAnalysis = async (taskIds?: string[], nextTaskIds = draftSelectedTaskIds) => {
    if (!hasTenderFile) {
      showToast('请先上传招标文件', 'info');
      return;
    }

    const normalizedTaskIds = normalizeSelectedTaskIds(nextTaskIds);
    const nextSelectedIdSet = new Set(normalizedTaskIds);
    const nextSelectedTasks = bidAnalysisTasks.filter((task) => nextSelectedIdSet.has(task.id));
    const retryTask = taskIds?.length === 1 ? nextSelectedTasks.find((task) => task.id === taskIds[0]) : undefined;
    const forceRerun = !taskIds?.length && nextSelectedTasks.length > 0 && nextSelectedTasks.every((task) => tasks[task.id]?.status === 'success');

    try {
      setRunning(true);
      if (forceRerun) {
        setFullRerunSeenRunning(false);
        setFullRerunLocked(true);
      }
      const configState = await saveConfig(normalizedTaskIds, false);
      const config = await window.yibiao?.config.load();
      await window.yibiao?.tasks.startBidAnalysis({
        mode: configState.mode,
        selected_task_ids: configState.selectedTaskIds,
        task_ids: taskIds,
        force_rerun: forceRerun,
      });
      trackConfigUsage({ bid_analysis_mode: configState.mode }, config);
      setSettingsOpen(false);
      showToast(retryTask ? `${retryTask.label}重新解析任务已在后台启动` : '招标文件解析任务已在后台启动', 'success');
    } catch (error) {
      if (forceRerun) {
        setFullRerunLocked(false);
        setFullRerunSeenRunning(false);
      }
      showToast(error instanceof Error ? error.message : '启动解析任务失败', 'error');
    } finally {
      setRunning(false);
    }
  };

  const retryActiveTask = () => {
    if (!activeTask || activeTaskStatus !== 'error') {
      showToast('当前解析项没有失败，无需单独重试', 'info');
      return;
    }

    startAnalysis([activeTask.id], effectiveSelectedTaskIds);
  };

  const toggleDraftTask = (taskId: string) => {
    if (requiredBidAnalysisTaskIdSet.has(taskId) || taskRunning) {
      return;
    }

    setDraftSelectedTaskIds((prev) => {
      const selectedSet = new Set(normalizeSelectedTaskIds(prev));
      if (selectedSet.has(taskId)) {
        selectedSet.delete(taskId);
      } else {
        selectedSet.add(taskId);
      }
      return allBidAnalysisTaskIds.filter((id) => selectedSet.has(id));
    });
  };

  const selectPreset = (preset: 'key' | 'full') => {
    setDraftSelectedTaskIds(preset === 'full' ? allBidAnalysisTaskIds : requiredBidAnalysisTaskIds);
  };

  const copyActiveResult = async () => {
    if (!activeTaskContent) {
      showToast('当前没有可复制的解析结果', 'info');
      return;
    }

    await navigator.clipboard.writeText(activeTaskContent);
    showToast('解析结果已复制', 'success');
  };

  const renderConfigTask = (definition: typeof bidAnalysisTasks[number]) => {
    const selected = normalizeSelectedTaskIds(draftSelectedTaskIds).includes(definition.id);
    const required = definition.required;

    return (
      <label className={`bid-analysis-config-item${selected ? ' is-selected' : ''}${required ? ' is-required' : ''}`} key={definition.id}>
        <input
          type="checkbox"
          checked={selected}
          disabled={required || taskRunning}
          onChange={() => toggleDraftTask(definition.id)}
        />
        <span>
          <strong>{definition.label}</strong>
        </span>
        {required && <em>必选</em>}
      </label>
    );
  };

  const draftMode = getModeForSelection(draftSelectedTaskIds);
  const draftSelectedCount = normalizeSelectedTaskIds(draftSelectedTaskIds).length;

  return (
    <div className="plan-step-body bid-analysis-page">
      <section className="bid-analysis-command-bar">
        <div>
          <span className="section-kicker">STEP 02</span>
          <strong>招标文件解析</strong>
          <p>并发解析招标文件，关键项成功后进入目录生成。</p>
        </div>
        <div className="bid-analysis-config-chip" title="当前解析配置">
          <span>{configLabel}</span>
          <small>{selectedTasks.length} 项</small>
        </div>
        <div className="bid-analysis-command-actions">
          <button
            type="button"
            className="outline-config-action"
            onClick={openSettingsDialog}
            disabled={taskRunning}
            aria-label="打开招标文件解析配置"
            title="招标文件解析配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          <button type="button" className="primary-action" onClick={openSettingsDialog} disabled={taskRunning}>
            {taskRunning ? '解析中...' : failedTaskCount > 0 ? `重试失败项(${failedTaskCount})` : progress > 0 ? '重新解析' : '开始解析'}
          </button>
        </div>
      </section>

      <section className="bid-analysis-workspace">
        <aside className="bid-analysis-task-pane" aria-label="解析任务列表">
          <div className="analysis-result-head bid-analysis-task-head">
            <strong>核心信息</strong>
            <span>{doneCount}/{selectedTasks.length} 项</span>
          </div>
          <div className={`content-outline-stats bid-analysis-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>解析进度</span>
              <strong>{doneCount}/{selectedTasks.length}</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className="content-generation-progress-track" aria-label={`解析进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{requiredDone ? '关键项已解析完成，可以进入下一步。' : '等待项目概述、技术评分、项目信息、甲方信息和交货服务要求解析成功。'}</p>
              </div>
            )}
          </div>
          <div className="bid-analysis-task-list">
            {taskGroups.map((group) => {
              const groupTasks = selectedTasks.filter((task) => group.ids.includes(task.id));
              if (!groupTasks.length) {
                return null;
              }

              return (
                <div className="bid-analysis-task-group" key={group.title}>
                  <span>{group.title}</span>
                  {groupTasks.map((task) => {
                    const status = tasks[task.id]?.status || 'idle';
                    const content = tasks[task.id]?.content || '';

                    return (
                      <button
                        type="button"
                        className={`bid-analysis-task-item is-${status}${visibleSelectedTaskId === task.id ? ' is-active' : ''}`}
                        key={task.id}
                        onClick={() => setSelectedTaskId(task.id)}
                        disabled={fullRerunLocked}
                      >
                        <strong>{task.label}</strong>
                        <small>{content ? `${content.length} 字` : task.description}</small>
                        <em>{statusLabel[status]}</em>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

        <article className="bid-analysis-reader">
          <div className="bid-analysis-reader-head">
            <div>
              <span className="section-kicker">解析结果</span>
              <strong>{activeTask?.label || '解析结果'}</strong>
              <p>{activeTask?.description || '选择左侧任务查看解析结果。'}</p>
            </div>
            <div className="bid-analysis-reader-actions">
              <span className={`bid-analysis-status is-${activeTaskStatus}`}>{statusLabel[activeTaskStatus]}</span>
              {activeTaskStatus === 'error' && (
                <button type="button" className="secondary-action" onClick={retryActiveTask} disabled={taskRunning || !hasTenderFile}>重新解析此项</button>
              )}
              <button type="button" className="secondary-action" onClick={copyActiveResult} disabled={!activeTaskContent}>复制</button>
            </div>
          </div>

          {activeTaskContent ? (
            activeTask?.output === 'json' ? (
              <JsonResultTable content={activeTaskContent} />
            ) : (
              <div className="markdown-viewer bid-analysis-output">
                <MarkdownRenderer>
                  {activeTaskContent}
                </MarkdownRenderer>
              </div>
            )
          ) : (
            <div className="markdown-empty-state bid-analysis-empty">
              <strong>{activeTaskStatus === 'error' ? activeTaskState?.error || '解析失败' : '等待解析结果'}</strong>
              <p>{activeTaskStatus === 'idle' ? '点击开始解析后，左侧任务会并发运行；选择任一任务查看实时输出。' : '正在等待模型返回内容。'}</p>
            </div>
          )}
        </article>
      </section>

      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="bid-analysis-config-card">
            <Dialog.Title className="sr-only">招标文件解析配置</Dialog.Title>
            <Dialog.Description className="sr-only">选择本次招标文件需要解析的项目。</Dialog.Description>

            <header className="bid-analysis-config-head">
              <div>
                <span className="section-kicker">解析项选择</span>
                <strong>{getModeLabel(draftMode)}</strong>
              </div>
              <div className="bid-analysis-config-presets" role="group" aria-label="快速选择解析项">
                {modeOptions.map((option) => (
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftMode === option.id ? ' is-active' : ''}`}
                    key={option.id}
                    onClick={() => selectPreset(option.id)}
                    disabled={taskRunning}
                  >
                    <span>{option.title}</span>
                    <small>{option.badge}</small>
                  </button>
                ))}
              </div>
            </header>

            <section className="bid-analysis-config-section">
              <div className="bid-analysis-config-section-head">
                <strong>关键项</strong>
                <span>{requiredBidAnalysisTaskIds.length} 项必选</span>
              </div>
              <div className="bid-analysis-config-grid">
                {bidAnalysisTasks.filter((definition) => definition.required).map(renderConfigTask)}
              </div>
            </section>

            <section className="bid-analysis-config-section">
              <div className="bid-analysis-config-section-head">
                <strong>其他项</strong>
                <span>当前共选择 {draftSelectedCount} 项</span>
              </div>
              <div className="bid-analysis-config-grid">
                {bidAnalysisTasks.filter((definition) => !definition.required).map(renderConfigTask)}
              </div>
            </section>

            <div className="content-regenerate-actions bid-analysis-config-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  void saveConfig().catch((error) => showToast(error instanceof Error ? error.message : '保存解析配置失败', 'error'));
                }}
                disabled={taskRunning}
              >
                保存配置
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => { void startAnalysis(undefined, draftSelectedTaskIds); }}
                disabled={taskRunning || !hasTenderFile}
              >
                开始解析
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default BidAnalysisPage;
