import { useEffect, useState } from 'react';
import type { AgentRunResult, AgentRuntimeDescriptor, AgentRuntimeStatus, AgentSelfCheckResult } from '../../../shared/types';

type TestStepStatus = 'idle' | 'running' | 'success' | 'error';

interface TestStep {
  id: string;
  label: string;
  status: TestStepStatus;
  detail?: string;
}

const DEFAULT_TASK = `请基于 tender.md 和 current-checklist.md 做一次自主审计。
重点不是重复 checklist，而是发现 checklist 没覆盖但可能导致废标、响应失败或后续人工返工的异常。

请把完整结果写入 agent-result.md，格式包含：
1. 测试是否成功
2. 自主发现的问题
3. 建议补充到固定工作流的检查项
4. 可直接展示给用户的结论`;

const SAMPLE_TENDER = `# 招标文件摘要

项目名称：智慧园区运维服务采购项目。

关键要求：

1. 投标人需要提供 7x24 小时运维响应方案。
2. 项目经理需要具有类似项目经验。
3. 需要提交服务团队人员清单。
4. 投标文件应包含数据安全、备份恢复、应急响应方案。
5. 未按要求提供承诺函或响应表，可能被视为未实质性响应。
`;

const SAMPLE_CHECKLIST = `# 当前固定检查清单

- 是否提供项目经理信息
- 是否提供服务周期
- 是否提供报价表
- 是否提供售后服务承诺
`;

function createInitialSteps(): TestStep[] {
  return [
    { id: 'config', label: '读取当前文本模型配置', status: 'idle' },
    { id: 'agent', label: '调用目标智能体运行时', status: 'idle' },
    { id: 'output', label: '校验 agent-result.md 输出', status: 'idle' },
  ];
}

function updateStep(steps: TestStep[], id: string, patch: Partial<TestStep>): TestStep[] {
  return steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getBridge() {
  if (!window.yibiao) throw new Error('当前 preload 未暴露易标客户端 API');
  return window.yibiao;
}

function AgentTestPage() {
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [runtimeId, setRuntimeId] = useState('');
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [selfCheckResult, setSelfCheckResult] = useState<AgentSelfCheckResult | null>(null);
  const [task, setTask] = useState(DEFAULT_TASK);
  const [runningAction, setRunningAction] = useState<'test' | 'self-check' | 'restart' | ''>('');
  const [steps, setSteps] = useState<TestStep[]>(() => createInitialSteps());
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let bridge: ReturnType<typeof getBridge>;
    try {
      bridge = getBridge();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取智能体运行时失败');
      return () => { disposed = true; };
    }
    void bridge.agent.listRuntimes()
      .then((items) => {
        if (disposed) return;
        setRuntimes(items);
        setRuntimeId((current) => current || items.find((item) => item.is_default)?.id || items[0]?.id || '');
      })
      .catch((caught) => {
        if (!disposed) setError(caught instanceof Error ? caught.message : '读取智能体运行时失败');
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!runtimeId) return undefined;
    let disposed = false;
    let bridge: ReturnType<typeof getBridge>;
    try {
      bridge = getBridge();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取智能体状态失败');
      return () => { disposed = true; };
    }
    const refreshStatus = () => {
      void bridge.agent.getStatus(runtimeId)
        .then((status) => {
          if (!disposed) setRuntimeStatus(status);
        })
        .catch(() => undefined);
    };
    refreshStatus();
    const unsubscribe = bridge.agent.onStatus((status) => {
      if (status.runtime_id === runtimeId) setRuntimeStatus(status);
      else refreshStatus();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [runtimeId]);

  const selectRuntime = (nextRuntimeId: string) => {
    setRuntimeId(nextRuntimeId);
    setRuntimeStatus(null);
    setSelfCheckResult(null);
    setResult(null);
    setError('');
    setSteps(createInitialSteps());
  };

  const runTest = async () => {
    if (runningAction || !runtimeId) return;
    setRunningAction('test');
    setError('');
    setResult(null);
    setSteps(createInitialSteps());

    try {
      const bridge = getBridge();
      setSteps((previous) => updateStep(previous, 'config', { status: 'running', detail: '正在读取 configStore 配置' }));
      const config = await bridge.config.load();
      if (!config.api_key || !config.base_url || !config.model_name) {
        throw new Error('请先在设置页配置文本模型 API Key、Base URL 和模型名称。');
      }
      setSteps((previous) => updateStep(previous, 'config', {
        status: 'success',
        detail: `${config.text_model_provider} / ${config.model_name}`,
      }));

      const runtimeName = runtimes.find((runtime) => runtime.id === runtimeId)?.display_name || runtimeId;
      setSteps((previous) => updateStep(previous, 'agent', { status: 'running', detail: `正在使用 ${runtimeName} 执行任务` }));
      const agentResult = await bridge.agent.run({
        title: `${runtimeName} 开发者链路测试`,
        task,
        output_file: 'agent-result.md',
        files: [
          { path: 'tender.md', content: SAMPLE_TENDER },
          { path: 'current-checklist.md', content: SAMPLE_CHECKLIST },
        ],
        timeout_ms: 10 * 60 * 1000,
      }, runtimeId);
      setResult(agentResult);
      setSteps((previous) => updateStep(previous, 'agent', {
        status: 'success',
        detail: `task_id=${agentResult.task_id || '-'}，session_id=${agentResult.session_id || '-'}`,
      }));

      setSteps((previous) => updateStep(previous, 'output', { status: 'running', detail: '正在检查输出内容' }));
      const output = String(agentResult.output_content || '').trim();
      if (!agentResult.success || !output) {
        throw new Error('智能体调用完成，但未返回 agent-result.md 内容。');
      }
      setSteps((previous) => updateStep(previous, 'output', {
        status: 'success',
        detail: `输出 ${output.length} 字，workspace=${agentResult.workspace_dir || '-'}`,
      }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '智能体链路测试失败';
      setError(message);
      setSteps((previous) => {
        const runningStep = previous.find((step) => step.status === 'running');
        return runningStep ? updateStep(previous, runningStep.id, { status: 'error', detail: message }) : previous;
      });
    } finally {
      setRunningAction('');
    }
  };

  const runSelfCheck = async () => {
    if (runningAction || !runtimeId) return;
    setRunningAction('self-check');
    setError('');
    setSelfCheckResult(null);
    try {
      setSelfCheckResult(await getBridge().agent.selfCheck(runtimeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '智能体自检失败');
    } finally {
      setRunningAction('');
    }
  };

  const restartRuntime = async () => {
    if (runningAction || !runtimeId) return;
    setRunningAction('restart');
    setError('');
    try {
      setRuntimeStatus(await getBridge().agent.restart('developer-page', runtimeId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '智能体运行时重启失败');
    } finally {
      setRunningAction('');
    }
  };

  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId);
  const busy = Boolean(runningAction);

  return (
    <div style={{ height: '100%', minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: 24, maxWidth: 1120, margin: '0 auto' }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ margin: 0, fontSize: 26 }}>智能体链路测试</h1>
          <p style={{ marginTop: 8, color: '#64748b', lineHeight: 1.7 }}>
            使用相同输入检查不同智能体运行时的状态、自检、任务输出和诊断，不写入业务数据库。
          </p>
        </header>

        <section style={{ display: 'grid', gap: 16 }}>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>目标运行时</h2>
            <select value={runtimeId} onChange={(event) => selectRuntime(event.target.value)} disabled={busy} style={{ minWidth: 260, padding: '9px 12px', border: '1px solid #cbd5e1', borderRadius: 8 }}>
              {runtimes.map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.display_name}</option>)}
            </select>
            <p style={{ margin: '10px 0 0', color: '#64748b' }}>{selectedRuntime?.description || '正在读取运行时信息'}</p>
          </div>

          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>运行状态</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <span>运行时：<strong>{runtimeStatus?.runtime_name || selectedRuntime?.display_name || '-'}</strong></span>
              <span>阶段：<strong>{runtimeStatus?.phase || '-'}</strong></span>
              <span>健康：<strong>{runtimeStatus ? String(runtimeStatus.healthy) : '-'}</strong></span>
              <span>模型队列：<strong>{runtimeStatus?.proxy ? `${runtimeStatus.proxy.active}/${runtimeStatus.proxy.queued}/${runtimeStatus.proxy.limit}` : '-'}</strong></span>
              <span>等待重启：<strong>{String(Boolean(runtimeStatus?.restart_pending))}</strong></span>
            </div>
            <p style={{ margin: '10px 0 0', color: '#475569' }}>{runtimeStatus?.message || '尚未收到状态'}</p>
            {runtimeStatus?.active_task && (
              <p style={{ margin: '8px 0 0', color: '#475569' }}>
                当前任务：{runtimeStatus.active_task.title}，{runtimeStatus.active_task.progress_text}，已运行 {runtimeStatus.active_task.elapsed_seconds}s
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => { void runSelfCheck(); }} disabled={busy || !runtimeId} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}>
                {runningAction === 'self-check' ? '自检中...' : '运行自检'}
              </button>
              <button type="button" onClick={() => { void restartRuntime(); }} disabled={busy || !runtimeId} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}>
                {runningAction === 'restart' ? '重启中...' : '手动重启'}
              </button>
            </div>
          </div>

          {selfCheckResult && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>{selfCheckResult.runtime_name} 自检</h2>
              <p style={{ color: selfCheckResult.success ? '#16834a' : '#c83220' }}>{selfCheckResult.message}</p>
              <pre style={{ padding: 12, borderRadius: 8, background: '#f8fafc', color: '#0f172a', whiteSpace: 'pre-wrap' }}>{formatJson(selfCheckResult)}</pre>
            </div>
          )}

          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>测试任务</h2>
            <textarea value={task} onChange={(event) => setTask(event.target.value)} disabled={busy} style={{ width: '100%', minHeight: 180, resize: 'vertical', border: '1px solid #cbd5e1', borderRadius: 8, padding: 12, fontFamily: 'monospace', lineHeight: 1.6 }} />
            <button type="button" onClick={() => { void runTest(); }} disabled={busy || !runtimeId} style={{ marginTop: 16, padding: '10px 16px', border: 0, borderRadius: 8, background: busy ? '#94a3b8' : '#2563eb', color: '#fff' }}>
              {runningAction === 'test' ? '测试中...' : '运行完整链路测试'}
            </button>
          </div>

          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>测试步骤</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {steps.map((step) => (
                <div key={step.id} style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 8, background: '#f8fafc' }}>
                  <strong>{step.label}：{step.status}</strong>
                  {step.detail && <span style={{ color: '#64748b', wordBreak: 'break-all' }}>{step.detail}</span>}
                </div>
              ))}
            </div>
            {error && <pre style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fef2f2', color: '#991b1b', whiteSpace: 'pre-wrap' }}>{error}</pre>}
          </div>

          {result && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>测试结果</h2>
              <h3>agent-result.md</h3>
              <pre style={{ padding: 12, borderRadius: 8, background: '#0f172a', color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>{result.output_content || '(无输出)'}</pre>
              <h3>原始返回</h3>
              <pre style={{ padding: 12, borderRadius: 8, background: '#f8fafc', color: '#0f172a', whiteSpace: 'pre-wrap' }}>{formatJson(result)}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default AgentTestPage;
