import { useMemo, useState } from 'react';

type TestStepStatus = 'idle' | 'running' | 'success' | 'error';

interface TestStep {
  id: string;
  label: string;
  status: TestStepStatus;
  detail?: string;
}

interface AgentRunResult {
  success: boolean;
  task_id: string;
  title: string;
  workspace_dir: string;
  output_file: string;
  output_content: string;
  assistant_text: string;
  diff: unknown[];
  session_id: string;
}

interface YibiaoBridgeForAgentTest {
  config?: {
    load: () => Promise<{
      api_key?: string;
      base_url?: string;
      model_name?: string;
      text_model_provider?: string;
    }>;
  };
  agent?: {
    run: (payload: unknown) => Promise<AgentRunResult>;
  };
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

function getYibiaoBridge(): YibiaoBridgeForAgentTest | undefined {
  return (window as unknown as { yibiao?: YibiaoBridgeForAgentTest }).yibiao;
}

function createInitialSteps(): TestStep[] {
  return [
    { id: 'config', label: '读取当前文本模型配置', status: 'idle' },
    { id: 'agent', label: '调用正式 agent:run IPC', status: 'idle' },
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

function OpenCodeAgentTestPage() {
  const [task, setTask] = useState(DEFAULT_TASK);
  const [keepRuntime, setKeepRuntime] = useState(true);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<TestStep[]>(() => createInitialSteps());
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState('');

  const yibiao = useMemo(() => getYibiaoBridge(), []);

  const runTest = async () => {
    if (running) return;

    setRunning(true);
    setError('');
    setResult(null);
    setSteps(createInitialSteps());

    try {
      if (!yibiao?.config?.load || !yibiao?.agent?.run) {
        throw new Error('当前 preload 未暴露 yibiao.config.load 或 yibiao.agent.run，请先完成 Main/IPC/preload 改造。');
      }

      setSteps((prev) => updateStep(prev, 'config', { status: 'running', detail: '正在读取 configStore 配置' }));
      const config = await yibiao.config.load();
      if (!config?.api_key || !config?.base_url || !config?.model_name) {
        throw new Error('请先在设置页配置文本模型 API Key、Base URL 和模型名称。');
      }
      setSteps((prev) => updateStep(prev, 'config', {
        status: 'success',
        detail: `${config.text_model_provider || 'unknown'} / ${config.model_name}`,
      }));

      setSteps((prev) => updateStep(prev, 'agent', { status: 'running', detail: '正在启动 OpenCode Server、OpenCode AI proxy 并执行任务' }));
      const agentResult = await yibiao.agent.run({
        title: 'OpenCode Agent 开发者链路测试',
        task,
        output_file: 'agent-result.md',
        files: [
          {
            path: 'tender.md',
            content: SAMPLE_TENDER,
          },
          {
            path: 'current-checklist.md',
            content: SAMPLE_CHECKLIST,
          },
        ],
        timeout_ms: 10 * 60 * 1000,
        keep_runtime: keepRuntime,
      });
      setResult(agentResult);
      setSteps((prev) => updateStep(prev, 'agent', {
        status: 'success',
        detail: `task_id=${agentResult.task_id}，session_id=${agentResult.session_id || '-'}`,
      }));

      setSteps((prev) => updateStep(prev, 'output', { status: 'running', detail: '正在检查输出内容' }));
      const output = String(agentResult.output_content || agentResult.assistant_text || '').trim();
      if (!agentResult.success || !output) {
        throw new Error('agent 调用完成，但未返回 output_content 或 assistant_text。');
      }
      setSteps((prev) => updateStep(prev, 'output', {
        status: 'success',
        detail: `输出 ${output.length} 字，workspace=${agentResult.workspace_dir}`,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OpenCode Agent 测试失败';
      setError(message);
      setSteps((prev) => {
        const runningStep = prev.find((step) => step.status === 'running');
        return runningStep
          ? updateStep(prev, runningStep.id, { status: 'error', detail: message })
          : prev;
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1120, margin: '0 auto' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>OpenCode Agent 开发者测试</h1>
        <p style={{ marginTop: 8, color: '#64748b', lineHeight: 1.7 }}>
          这个页面只用于验证 OpenCode Server + OpenCode AI proxy + agentService 的完整链路。
          它不会写入现有业务数据库，也不会接入技术方案、废标项检查或查重流程。
        </p>
      </header>

      <section style={{ display: 'grid', gap: 16 }}>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>测试任务</h2>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            disabled={running}
            style={{
              width: '100%',
              minHeight: 180,
              resize: 'vertical',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              padding: 12,
              fontFamily: 'monospace',
              lineHeight: 1.6,
            }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#475569' }}>
            <input
              type="checkbox"
              checked={keepRuntime}
              disabled={running}
              onChange={(event) => setKeepRuntime(event.target.checked)}
            />
            保留 runtime 目录，方便检查 workspace、临时 opencode.json 和输出文件
          </label>
          <button
            type="button"
            onClick={() => { void runTest(); }}
            disabled={running}
            style={{
              marginTop: 16,
              padding: '10px 16px',
              border: 0,
              borderRadius: 8,
              background: running ? '#94a3b8' : '#2563eb',
              color: '#fff',
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? '测试中...' : '运行完整链路测试'}
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
          {error && (
            <pre style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fef2f2', color: '#991b1b', whiteSpace: 'pre-wrap' }}>
              {error}
            </pre>
          )}
        </div>

        {result && (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>测试结果</h2>
            <h3>agent-result.md</h3>
            <pre style={{ padding: 12, borderRadius: 8, background: '#0f172a', color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>
              {result.output_content || result.assistant_text || '(无输出)'}
            </pre>
            <h3>原始返回</h3>
            <pre style={{ padding: 12, borderRadius: 8, background: '#f8fafc', color: '#0f172a', whiteSpace: 'pre-wrap' }}>
              {formatJson(result)}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}

export default OpenCodeAgentTestPage;
