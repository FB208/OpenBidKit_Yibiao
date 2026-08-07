import { useEffect, useRef, useState } from 'react';
import type { AgentMonitorEvent, AgentMonitorSnapshot, AgentRunFile } from '../../../shared/types/ipc';

type MonitorTaskStatus = 'running' | 'success' | 'error';
type MonitorTab = 'timeline' | 'input' | 'output';

interface MonitorTimelineEntry {
  id: string;
  kind: 'assistant' | 'tool' | 'system';
  at: string;
  text?: string;
  tone?: 'normal' | 'warning' | 'error' | 'success';
  complete?: boolean;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface MonitorTaskInput {
  id: string;
  at: string;
  stageIndex?: number;
  workflowStage: string;
  prompt: string;
  files: AgentRunFile[];
}

interface MonitorTask {
  id: string;
  title: string;
  status: MonitorTaskStatus;
  startedAt: string;
  endedAt?: string;
  outputFile: string;
  workspaceDir: string;
  inputs: MonitorTaskInput[];
  entries: MonitorTimelineEntry[];
  turnCount: number;
  retryCount: number;
  outputContent: string;
  error: string;
}

const lifecycleLabels: Partial<Record<AgentMonitorEvent['type'], string>> = {
  agent_start: 'Pi Agent 开始执行',
  agent_end: 'Pi Agent 会话结束',
  agent_settled: 'Pi Agent 已完成本轮处理',
  compaction_start: '上下文压缩开始',
  compaction_end: '上下文压缩完成',
};

function createTask(id: string, title = 'Pi Agent 任务', startedAt = new Date().toISOString()): MonitorTask {
  return {
    id,
    title,
    status: 'running',
    startedAt,
    outputFile: '',
    workspaceDir: '',
    inputs: [],
    entries: [],
    turnCount: 0,
    retryCount: 0,
    outputContent: '',
    error: '',
  };
}

function createMidstreamEntry(taskId: string, at: string): MonitorTimelineEntry {
  return {
    id: `midstream-${taskId}`,
    kind: 'system',
    at,
    text: '监视器在任务执行中途打开，之前的执行过程未采集。',
    tone: 'warning',
    complete: true,
  };
}

function ensureTask(tasks: MonitorTask[], event: AgentMonitorEvent) {
  const index = tasks.findIndex((task) => task.id === event.task_id);
  if (index >= 0) {
    return {
      index,
      existed: true,
      task: { ...tasks[index], inputs: [...tasks[index].inputs], entries: [...tasks[index].entries] },
    };
  }
  const task = createTask(event.task_id || `unknown-${event.sequence}`, event.title, event.at);
  task.entries.push(createMidstreamEntry(task.id, event.at));
  return { index: tasks.length, existed: false, task };
}

function createTaskInput(event: AgentMonitorEvent): MonitorTaskInput {
  return {
    id: `input-${event.sequence}`,
    at: event.at,
    stageIndex: event.stage_index,
    workflowStage: event.workflow_stage || '',
    prompt: event.prompt || '',
    files: event.files || [],
  };
}

function describeTaskInput(input: MonitorTaskInput, round: number) {
  const stage = input.workflowStage ? `：${input.workflowStage}` : '';
  const fileLabel = round === 1 ? '输入文件' : '新增/更新文件';
  return `第 ${round} 轮任务输入已提交${stage}，Prompt ${input.prompt.length.toLocaleString('zh-CN')} 字符，${fileLabel} ${input.files.length} 个。`;
}

// 将 Pi 实时事件归并为适合阅读的任务时间线。
function applyMonitorEvent(tasks: MonitorTask[], event: AgentMonitorEvent) {
  const nextTasks = [...tasks];
  const { index, existed, task } = ensureTask(nextTasks, event);
  if (event.title) task.title = event.title;
  if (event.workspace_dir) task.workspaceDir = event.workspace_dir;

  if (event.type === 'task_start') {
    if (!existed) {
      task.startedAt = event.at;
      task.entries = [];
      task.inputs = [];
      task.turnCount = 0;
      task.retryCount = 0;
    }
    task.status = 'running';
    delete task.endedAt;
    task.outputFile = event.output_file || '';
    task.workspaceDir = event.workspace_dir || '';
    task.outputContent = '';
    task.error = '';
    const input = createTaskInput(event);
    task.inputs.push(input);
    task.entries.push({
      id: `input-notice-${event.sequence}`,
      kind: 'system',
      at: event.at,
      text: describeTaskInput(input, task.inputs.length),
      tone: 'normal',
      complete: true,
    });
  } else if (event.type === 'task_input') {
    const input = createTaskInput(event);
    task.inputs.push(input);
    task.entries.push({
      id: `input-notice-${event.sequence}`,
      kind: 'system',
      at: event.at,
      text: describeTaskInput(input, task.inputs.length),
      tone: 'normal',
      complete: true,
    });
  } else if (event.type === 'assistant_delta') {
    const lastEntry = task.entries[task.entries.length - 1];
    if (lastEntry?.kind === 'assistant' && !lastEntry.complete) {
      task.entries[task.entries.length - 1] = { ...lastEntry, text: `${lastEntry.text || ''}${event.delta || ''}` };
    } else {
      task.entries.push({
        id: `assistant-${event.sequence}`,
        kind: 'assistant',
        at: event.at,
        text: event.delta || '',
        complete: false,
      });
    }
  } else if (event.type === 'assistant_end') {
    let lastAssistantIndex = -1;
    for (let index = task.entries.length - 1; index >= 0; index -= 1) {
      if (task.entries[index].kind === 'assistant' && !task.entries[index].complete) {
        lastAssistantIndex = index;
        break;
      }
    }
    if (lastAssistantIndex >= 0) {
      const previous = task.entries[lastAssistantIndex];
      task.entries[lastAssistantIndex] = { ...previous, text: event.text || previous.text || '', complete: true };
    } else if (event.text) {
      task.entries.push({
        id: `assistant-${event.sequence}`,
        kind: 'assistant',
        at: event.at,
        text: event.text,
        complete: true,
      });
    }
  } else if (event.type === 'tool_start') {
    task.entries.push({
      id: `tool-${event.tool_call_id || event.sequence}`,
      kind: 'tool',
      at: event.at,
      toolCallId: event.tool_call_id,
      toolName: event.tool_name || 'tool',
      args: event.args,
      complete: false,
    });
  } else if (event.type === 'tool_update' || event.type === 'tool_end') {
    const toolIndex = task.entries.findIndex((entry) => entry.kind === 'tool' && entry.toolCallId === event.tool_call_id);
    const previous = toolIndex >= 0 ? task.entries[toolIndex] : {
      id: `tool-${event.tool_call_id || event.sequence}`,
      kind: 'tool' as const,
      at: event.at,
      toolCallId: event.tool_call_id,
      toolName: event.tool_name || 'tool',
    };
    const updated: MonitorTimelineEntry = {
      ...previous,
      toolName: event.tool_name || previous.toolName,
      partialResult: event.type === 'tool_update' ? event.partial_result : previous.partialResult,
      result: event.type === 'tool_end' ? event.result : previous.result,
      isError: event.type === 'tool_end' ? event.is_error : previous.isError,
      complete: event.type === 'tool_end',
    };
    if (toolIndex >= 0) task.entries[toolIndex] = updated;
    else task.entries.push(updated);
  } else if (event.type === 'turn_start') {
    task.turnCount += 1;
  } else if (event.type === 'retry') {
    task.retryCount = Math.max(task.retryCount, event.attempt || 0);
    task.entries.push({
      id: `retry-${event.sequence}`,
      kind: 'system',
      at: event.at,
      text: `自动修复 ${event.attempt || 0}/${event.maximum || 0}：${event.message || '上一轮结果未通过'}`,
      tone: 'warning',
      complete: true,
    });
  } else if (event.type === 'task_end') {
    task.status = 'success';
    task.endedAt = event.at;
    task.outputFile = event.output_file || task.outputFile;
    task.outputContent = event.output_content || '';
    task.retryCount = Math.max(task.retryCount, event.retry_count || 0);
    task.entries.push({
      id: `success-${event.sequence}`,
      kind: 'system',
      at: event.at,
      text: '本轮 Pi Agent 执行完成，输出已写回。',
      tone: 'success',
      complete: true,
    });
  } else if (event.type === 'task_error') {
    task.status = 'error';
    task.endedAt = event.at;
    task.outputFile = event.output_file || task.outputFile;
    task.outputContent = event.output_content || '';
    task.error = event.message || 'Pi Agent 执行失败';
    task.entries.push({
      id: `error-${event.sequence}`,
      kind: 'system',
      at: event.at,
      text: task.error,
      tone: 'error',
      complete: true,
    });
  } else if (lifecycleLabels[event.type]) {
    task.entries.push({
      id: `lifecycle-${event.sequence}`,
      kind: 'system',
      at: event.at,
      text: lifecycleLabels[event.type],
      tone: 'normal',
      complete: true,
    });
  }

  nextTasks[index] = task;
  return nextTasks;
}

function applySnapshot(tasks: MonitorTask[], snapshot: AgentMonitorSnapshot) {
  const activeTask = snapshot.active_task;
  if (!activeTask || tasks.some((task) => task.id === activeTask.task_id)) return tasks;
  const task = createTask(activeTask.task_id, activeTask.title, activeTask.started_at || snapshot.attached_at);
  task.workspaceDir = snapshot.workspace_dir || '';
  task.entries.push(createMidstreamEntry(task.id, snapshot.attached_at));
  return [...tasks, task];
}

function formatClock(value?: string) {
  if (!value) return '--:--:--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatElapsed(startedAt: string, endedAt: string | undefined, now: number) {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '0s';
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

function formatValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolTimelineEntry({ entry }: { entry: MonitorTimelineEntry }) {
  const [open, setOpen] = useState(false);
  const argsText = open ? formatValue(entry.args) : '';
  const resultText = open ? formatValue(entry.complete ? entry.result : entry.partialResult) : '';
  return (
    <details
      className={`agent-monitor-entry is-tool${entry.isError ? ' is-error' : ''}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="agent-monitor-tool-glyph">$</span>
        <strong>{entry.toolName || 'tool'}</strong>
        <span>{entry.complete ? (entry.isError ? '执行失败' : '执行完成') : '执行中'}</span>
        <time>{formatClock(entry.at)}</time>
      </summary>
      {open && (
        <div className="agent-monitor-tool-body">
          {argsText && <section><label>参数</label><pre>{argsText}</pre></section>}
          {resultText && <section><label>{entry.complete ? '结果' : '实时输出'}</label><pre>{resultText}</pre></section>}
        </div>
      )}
    </details>
  );
}

function MonitorInputFile({ file }: { file: AgentRunFile }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><strong>{file.path}</strong><span>{file.content.length.toLocaleString('zh-CN')} 字符</span></summary>
      {open && <pre>{file.content}</pre>}
    </details>
  );
}

function statusLabel(status: MonitorTaskStatus) {
  if (status === 'success') return '已完成';
  if (status === 'error') return '失败';
  return '执行中';
}

function PiAgentMonitorWindow() {
  const [tasks, setTasks] = useState<MonitorTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [activeTab, setActiveTab] = useState<MonitorTab>('timeline');
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState('');
  const [autoFollow, setAutoFollow] = useState(true);
  const [workspaceOpening, setWorkspaceOpening] = useState(false);
  const [workspaceOpenError, setWorkspaceOpenError] = useState('');
  const [now, setNow] = useState(Date.now());
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('agent-monitor-root');
    document.body.classList.add('agent-monitor-root');
    const bridge = window.yibiao?.developerAgentMonitor;
    if (!bridge) {
      setError('Pi Agent 执行监视器接口不可用');
      return () => {
        document.documentElement.classList.remove('agent-monitor-root');
        document.body.classList.remove('agent-monitor-root');
      };
    }

    let mounted = true;
    const unsubscribe = bridge.onEvent((event) => {
      setTasks((previous) => applyMonitorEvent(previous, event));
      if (event.type === 'task_start') {
        setSelectedTaskId(event.task_id);
        setActiveTab('timeline');
      } else {
        setSelectedTaskId((current) => current || event.task_id);
      }
    });
    void bridge.attach()
      .then((snapshot) => {
        if (!mounted) return;
        setAttached(true);
        setTasks((previous) => applySnapshot(previous, snapshot));
        if (snapshot.active_task) setSelectedTaskId((current) => current || snapshot.active_task?.task_id || '');
      })
      .catch((caught) => {
        if (mounted) setError(caught instanceof Error ? caught.message : '连接 Pi Agent 监视流失败');
      });

    return () => {
      mounted = false;
      unsubscribe();
      void bridge.detach().catch(() => undefined);
      document.documentElement.classList.remove('agent-monitor-root');
      document.body.classList.remove('agent-monitor-root');
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || tasks[tasks.length - 1] || null;
  const lastTimelineEntry = selectedTask?.entries[selectedTask.entries.length - 1];
  const timelineSignal = selectedTask ? `${selectedTask.id}:${selectedTask.entries.length}:${lastTimelineEntry?.text?.length || 0}:${lastTimelineEntry?.complete}` : '';

  useEffect(() => {
    setWorkspaceOpenError('');
  }, [selectedTaskId]);

  useEffect(() => {
    if (!autoFollow || activeTab !== 'timeline') return;
    const container = timelineRef.current;
    if (!container) return;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timelineSignal, autoFollow, activeTab]);

  // 打开当前选中任务对应的实时或归档工作空间。
  const openSelectedWorkspace = async () => {
    if (!selectedTask?.workspaceDir || workspaceOpening) return;
    try {
      setWorkspaceOpening(true);
      setWorkspaceOpenError('');
      await window.yibiao?.developerAgentMonitor.openWorkspace(selectedTask.workspaceDir);
    } catch (caught) {
      setWorkspaceOpenError(caught instanceof Error ? caught.message : '打开当前工作空间失败');
    } finally {
      setWorkspaceOpening(false);
    }
  };

  const renderTimeline = () => {
    if (!selectedTask?.entries.length) {
      return (
        <div className="markdown-empty-state agent-monitor-empty">
          <strong>等待执行事件</strong>
          <p>监视器只采集打开后发生的 Pi Agent 输入、助手输出和工具调用。</p>
        </div>
      );
    }
    return (
      <div className="agent-monitor-timeline" ref={timelineRef}>
        {selectedTask.entries.map((entry) => {
          if (entry.kind === 'assistant') {
            return (
              <article className={`agent-monitor-entry is-assistant${entry.complete ? '' : ' is-streaming'}`} key={entry.id}>
                <header><strong>Pi Agent</strong><time>{formatClock(entry.at)}</time></header>
                <pre>{entry.text || '...'}</pre>
              </article>
            );
          }
          if (entry.kind === 'tool') {
            return <ToolTimelineEntry entry={entry} key={entry.id} />;
          }
          return (
            <div className={`agent-monitor-entry is-system is-${entry.tone || 'normal'}`} key={entry.id}>
              <time>{formatClock(entry.at)}</time>
              <span>{entry.text}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderInput = () => {
    if (!selectedTask?.inputs.length) {
      return <div className="markdown-empty-state agent-monitor-empty"><strong>未采集任务输入</strong><p>任务可能在监视器打开前已经开始。</p></div>;
    }
    return (
      <div className="agent-monitor-document-view">
        {selectedTask.inputs.map((input, index) => (
          <section className="agent-monitor-input-round" key={input.id}>
            <header>
              <div>
                <strong>第 {index + 1} 轮任务输入</strong>
                <small>{input.workflowStage || '未命名阶段'}{input.stageIndex === undefined ? '' : ` · stage ${input.stageIndex}`}</small>
              </div>
              <span>{formatClock(input.at)}</span>
            </header>
            <div className="agent-monitor-input-block">
              <header><strong>任务 Prompt</strong><span>{input.prompt.length.toLocaleString('zh-CN')} 字符</span></header>
              <pre>{input.prompt || '(空)'}</pre>
            </div>
            <div className="agent-monitor-input-block">
              <header><strong>{index === 0 ? '工作区输入文件' : '本轮新增或更新文件'}</strong><span>{input.files.length} 个</span></header>
              {input.files.length ? (
                <div className="agent-monitor-file-list">
                  {input.files.map((file) => (
                    <MonitorInputFile file={file} key={`${input.id}:${file.path}`} />
                  ))}
                </div>
              ) : <p className="agent-monitor-input-empty">本轮没有新增或更新工作区文件。</p>}
            </div>
          </section>
        ))}
      </div>
    );
  };

  const renderOutput = () => {
    if (!selectedTask) return null;
    return (
      <div className="agent-monitor-document-view">
        <section>
          <header>
            <strong>{selectedTask.outputFile || '最终输出文件'}</strong>
            <span>{selectedTask.outputContent.length.toLocaleString('zh-CN')} 字符</span>
          </header>
          {selectedTask.error && <div className="agent-monitor-output-error">{selectedTask.error}</div>}
          <pre>{selectedTask.outputContent || (selectedTask.status === 'running' ? '任务执行中，等待最终输出文件写回。' : '(无输出)')}</pre>
        </section>
      </div>
    );
  };

  return (
    <main className="agent-monitor-window">
      <header className="agent-monitor-header">
        <div className="agent-monitor-brand">
          <span className={`agent-monitor-live-dot${attached ? ' is-attached' : ''}`} />
          <div><strong>Pi Agent 执行监视器</strong><span>{attached ? '实时监视 · 仅采集本窗口打开后的事件' : '正在连接实时事件流'}</span></div>
        </div>
        <div className="agent-monitor-header-meta">
          <span>{tasks.length} 个任务</span>
          <span>{tasks.filter((task) => task.status === 'running').length ? 'Agent 忙碌' : 'Agent 空闲'}</span>
        </div>
      </header>

      {error ? (
        <div className="agent-monitor-fatal"><strong>监视器连接失败</strong><span>{error}</span></div>
      ) : (
        <div className="agent-monitor-layout">
          <aside className="agent-monitor-sidebar">
            <div className="agent-monitor-sidebar-title"><strong>本次监视任务</strong><span>关闭窗口后清空</span></div>
            <div className="agent-monitor-task-list">
              {tasks.map((task) => (
                <button
                  type="button"
                  className={task.id === selectedTask?.id ? 'is-active' : ''}
                  onClick={() => setSelectedTaskId(task.id)}
                  key={task.id}
                >
                  <span className={`agent-monitor-task-dot is-${task.status}`} />
                  <span className="agent-monitor-task-copy">
                    <strong>{task.title}</strong>
                    <small>{formatClock(task.startedAt)} · {formatElapsed(task.startedAt, task.endedAt, now)}</small>
                  </span>
                  <em>{statusLabel(task.status)}</em>
                </button>
              ))}
              {!tasks.length && <div className="agent-monitor-sidebar-empty">等待下一次 Agent 任务</div>}
            </div>
          </aside>

          <section className="agent-monitor-workbench">
            <header className="agent-monitor-task-header">
              <div>
                <span>{selectedTask ? selectedTask.id : 'NO ACTIVE TASK'}</span>
                <h1>{selectedTask?.title || '等待 Pi Agent 任务'}</h1>
              </div>
              {selectedTask && (
                <div className="agent-monitor-task-stats">
                  <span><small>状态</small><strong className={`is-${selectedTask.status}`}>{statusLabel(selectedTask.status)}</strong></span>
                  <span><small>轮次</small><strong>{selectedTask.turnCount}</strong></span>
                  <span><small>重试</small><strong>{selectedTask.retryCount}</strong></span>
                  <span><small>耗时</small><strong>{formatElapsed(selectedTask.startedAt, selectedTask.endedAt, now)}</strong></span>
                </div>
              )}
            </header>

            <nav className="agent-monitor-tabs" aria-label="监视器内容">
              <div className="document-switch-tabs">
                {([
                  { id: 'timeline', label: '执行过程' },
                  { id: 'input', label: selectedTask?.inputs.length ? `任务输入（${selectedTask.inputs.length} 轮）` : '任务输入' },
                  { id: 'output', label: '最终输出' },
                ] as Array<{ id: MonitorTab; label: string }>).map((tab) => (
                  <button type="button" className={`document-switch-tab ${activeTab === tab.id ? 'is-active' : ''}`} onClick={() => setActiveTab(tab.id)} key={tab.id}>{tab.label}</button>
                ))}
              </div>
              <div className="agent-monitor-tab-actions">
                {workspaceOpenError && <span className="agent-monitor-workspace-error" role="alert" title={workspaceOpenError}>{workspaceOpenError}</span>}
                <button
                  type="button"
                  className="inline-action agent-monitor-open-workspace"
                  onClick={() => void openSelectedWorkspace()}
                  disabled={!selectedTask?.workspaceDir || workspaceOpening}
                  title={selectedTask?.workspaceDir || '当前任务尚无可打开的工作空间'}
                >
                  {workspaceOpening ? '正在打开' : '打开当前工作空间'}
                </button>
                {activeTab === 'timeline' && (
                  <button type="button" className={`inline-action agent-monitor-follow${autoFollow ? ' is-active' : ''}`} onClick={() => setAutoFollow((value) => !value)}>
                    {autoFollow ? '自动跟随' : '已暂停跟随'}
                  </button>
                )}
              </div>
            </nav>

            <div className="agent-monitor-content">
              {activeTab === 'timeline' ? renderTimeline() : activeTab === 'input' ? renderInput() : renderOutput()}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default PiAgentMonitorWindow;
