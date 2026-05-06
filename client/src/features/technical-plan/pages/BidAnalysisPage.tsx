import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { getBidAnalysisTasks } from '../services/bidAnalysisWorkflow';
import { useToast } from '../../../shared/ui';
import type { BackgroundTaskState, BidAnalysisMode, BidAnalysisTasks, BidAnalysisTaskState } from '../types';

interface BidAnalysisPageProps {
  fileContent: string;
  mode: BidAnalysisMode;
  tasks: BidAnalysisTasks;
  task?: BackgroundTaskState;
  progress: number;
  onModeChange: (mode: BidAnalysisMode) => void;
  onTasksChange: (updater: (prev: BidAnalysisTasks) => BidAnalysisTasks) => void;
  onProgressChange: (progress: number) => void;
  onRequiredResultChange: (projectOverview: string, techRequirements: string) => void;
}

const modeOptions: Array<{ id: BidAnalysisMode; title: string; desc: string; badge: string }> = [
  {
    id: 'key',
    title: '只解析关键项',
    desc: '项目概述、技术评分要求。适合快速进入目录生成。',
    badge: '默认',
  },
  {
    id: 'full',
    title: '完整解析',
    desc: '并发提取项目、甲方、代理、评标、合同等完整信息。',
    badge: '更多 Token',
  },
];

const taskGroups = [
  { title: '核心信息', ids: ['projectOverview', 'techRequirements', 'projectInfo'] },
  { title: '投标流程', ids: ['keyInfo', 'marginInfo', 'openBid'] },
  { title: '评审要求', ids: ['qualificationReview', 'complianceCheck', 'evaluationBid', 'businessScoring'] },
  { title: '主体与合同', ids: ['partAInfo', 'agentInfo', 'discardedBids', 'signingProcess', 'terminationCondition'] },
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
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
          {`\`\`\`json\n${content}\n\`\`\``}
        </ReactMarkdown>
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
  fileContent,
  mode,
  tasks,
  task,
  progress,
  onModeChange,
  onTasksChange,
  onProgressChange,
  onRequiredResultChange,
}: BidAnalysisPageProps) {
  const [running, setRunning] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('projectOverview');
  const { showToast } = useToast();
  const selectedTasks = useMemo(() => getBidAnalysisTasks(mode), [mode]);
  const visibleSelectedTaskId = selectedTasks.some((task) => task.id === selectedTaskId)
    ? selectedTaskId
    : selectedTasks[0]?.id || 'projectOverview';
  const activeTask = selectedTasks.find((task) => task.id === visibleSelectedTaskId) || selectedTasks[0];
  const activeTaskState = activeTask ? tasks[activeTask.id] : undefined;
  const activeTaskStatus = activeTaskState?.status || 'idle';
  const activeTaskContent = activeTaskState?.content || '';
  const doneCount = selectedTasks.filter((task) => {
    const status = tasks[task.id]?.status;
    return status === 'success' || status === 'error';
  }).length;
  const taskRunning = running || task?.status === 'running';
  const requiredDone = Boolean(
    tasks.projectOverview?.status === 'success'
    && tasks.projectOverview.content
    && tasks.techRequirements?.status === 'success'
    && tasks.techRequirements.content
  );

  const syncProgressForMode = (nextMode: BidAnalysisMode) => {
    const nextTasks = getBidAnalysisTasks(nextMode);
    const nextDoneCount = nextTasks.filter((task) => {
      const status = tasks[task.id]?.status;
      return status === 'success' || status === 'error';
    }).length;
    onProgressChange(Math.round((nextDoneCount / nextTasks.length) * 100));
  };

  const startAnalysis = async () => {
    if (!fileContent) {
      showToast('请先上传招标文件', 'info');
      return;
    }

    try {
      setRunning(true);
      await window.yibiao?.tasks.startBidAnalysis({ mode, fileContent });
      showToast('招标文件解析任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动解析任务失败', 'error');
    } finally {
      setRunning(false);
    }
  };

  const copyActiveResult = async () => {
    if (!activeTaskContent) {
      showToast('当前没有可复制的解析结果', 'info');
      return;
    }

    await navigator.clipboard.writeText(activeTaskContent);
    showToast('解析结果已复制', 'success');
  };

  return (
    <div className="plan-step-body bid-analysis-page">
      <section className="bid-analysis-command-bar">
        <div>
          <span className="section-kicker">STEP 02</span>
          <strong>招标文件解析</strong>
          <p>并发解析招标文件，关键项成功后进入目录生成。</p>
        </div>
        <div className="bid-analysis-mode-switch" role="radiogroup" aria-label="解析模式">
          {modeOptions.map((option) => (
            <button
              type="button"
              className={`bid-analysis-mode-pill${mode === option.id ? ' is-active' : ''}`}
              key={option.id}
              onClick={() => {
                onModeChange(option.id);
                syncProgressForMode(option.id);
                setSelectedTaskId(getBidAnalysisTasks(option.id)[0]?.id || 'projectOverview');
              }}
              disabled={taskRunning}
            >
              <span>{option.title}</span>
              <small>{option.badge}</small>
            </button>
          ))}
        </div>
        <button type="button" className="primary-action" onClick={startAnalysis} disabled={taskRunning || !fileContent}>
          {taskRunning ? '解析中...' : progress > 0 ? '重新解析' : '开始解析'}
        </button>
      </section>

      <section className="bid-analysis-config">
        <div className="bid-analysis-progress-card">
          <div className="analysis-result-head">
            <strong>解析进度</strong>
            <span>{doneCount}/{selectedTasks.length} 项</span>
          </div>
          <div className="bid-analysis-progress-track" aria-label="解析进度">
            <span style={{ width: `${progress}%` }} />
          </div>
          <p>{requiredDone && progress === 100 ? '关键项已解析完成，可以进入下一步。' : '等待项目概述和技术评分要求解析成功。'}</p>
        </div>
        <div className="bid-analysis-key-status">
          {['projectOverview', 'techRequirements'].map((id) => {
            const task = selectedTasks.find((item) => item.id === id);
            const state = tasks[id];
            const status = state?.status || 'idle';

            return (
              <button
                type="button"
                className={`bid-analysis-key-card is-${status}`}
                key={id}
                onClick={() => setSelectedTaskId(id)}
              >
                <span>{task?.label || id}</span>
                <strong>{statusLabel[status]}</strong>
              </button>
            );
          })}
        </div>
      </section>

      <section className="bid-analysis-workspace">
        <aside className="bid-analysis-task-pane" aria-label="解析任务列表">
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
              <button type="button" className="secondary-action" onClick={copyActiveResult} disabled={!activeTaskContent}>复制</button>
            </div>
          </div>

          {activeTaskContent ? (
            activeTask?.output === 'json' ? (
              <JsonResultTable content={activeTaskContent} />
            ) : (
              <div className="markdown-viewer bid-analysis-output">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                  {activeTaskContent}
                </ReactMarkdown>
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
    </div>
  );
}

export default BidAnalysisPage;
