import { useState } from 'react';
import { getBidAnalysisTasks, requestBidAnalysisTask } from '../../technical-plan/services/bidAnalysisWorkflow';
import { requestOutlineGeneration } from '../../technical-plan/services/outlineWorkflow';

type RunningMode = 'text' | 'json' | null;

const sampleTenderContent = `# 易标测试项目招标文件

项目名称：易标测试项目。
项目编号：YB-TEST-001。
项目类型：软件服务。
项目预算：100 万元。
项目地址：北京市海淀区。

技术评分要求：
1. 技术方案完整性，满分 30 分，要求章节完整、实施路径清晰。
2. 项目实施计划，满分 20 分，要求进度安排合理、风险控制明确。
3. 运维服务能力，满分 15 分，要求说明响应时效和服务保障。`;

const sampleOutlineInput = {
  overview: '易标测试项目，软件服务类采购，预算 100 万元，实施地点北京市海淀区。',
  requirements: '技术方案完整性 30 分；项目实施计划 20 分；运维服务能力 15 分。',
  mode: 'free' as const,
};

const textTask = getBidAnalysisTasks('full').find((task) => task.id === 'projectInfo');

function DeveloperTestPage() {
  const [runningMode, setRunningMode] = useState<RunningMode>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [result, setResult] = useState('');

  const appendEvent = (message: string) => {
    setEvents((prev) => [...prev, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`]);
  };

  const resetOutput = () => {
    setEvents([]);
    setContent('');
    setResult('');
  };

  const runTextTest = async () => {
    if (!textTask) {
      appendEvent('未找到项目中的 JSON 招标文件解析任务。');
      return;
    }

    resetOutput();
    setRunningMode('text');
    appendEvent(`调用项目真实文本请求：requestBidAnalysisTask(${textTask.label})。`);

    try {
      const nextContent = await requestBidAnalysisTask(sampleTenderContent, textTask);
      setContent(nextContent);
      appendEvent('文本请求完成。');
    } catch (error) {
      appendEvent(`文本请求错误：${error instanceof Error ? error.message : 'AI 文本请求失败'}`);
    } finally {
      setRunningMode(null);
    }
  };

  const runJsonTest = async () => {
    resetOutput();
    setRunningMode('json');
    appendEvent('调用项目真实 JSON 请求：requestOutlineGeneration。');

    try {
      const outline = await requestOutlineGeneration({
        ...sampleOutlineInput,
        onProgress: appendEvent,
      });
      setResult(JSON.stringify(outline, null, 2));
      appendEvent('JSON 请求完成。');
    } catch (error) {
      appendEvent(`JSON 请求错误：${error instanceof Error ? error.message : 'AI JSON 请求失败'}`);
    } finally {
      setRunningMode(null);
    }
  };

  const running = runningMode !== null;

  return (
    <div className="page-stack developer-test-page">
      <section className="panel developer-test-hero">
        <div className="hero-copy">
          <span className="eyebrow">Developer Reproduction</span>
          <h2>测试页</h2>
          <p>
            这里复用项目真实业务请求来复现 response_format 兼容问题：文本按钮使用招标文件解析任务，JSON 按钮使用目录生成任务。
          </p>
          <div className="developer-test-actions">
            <button type="button" className="primary-action" onClick={runTextTest} disabled={running || !textTask}>
              {runningMode === 'text' ? '文本请求中...' : '测试文本请求'}
            </button>
            <button type="button" className="primary-action" onClick={runJsonTest} disabled={running}>
              {runningMode === 'json' ? 'JSON 请求中...' : '测试 JSON 请求'}
            </button>
          </div>
        </div>
      </section>

      <div className="developer-test-grid">
        <section className="panel developer-test-panel">
          <div className="settings-section-title">
            <span />
            <strong>文本复用入口</strong>
          </div>
          <pre>{JSON.stringify({ service: 'requestBidAnalysisTask', task: textTask?.id, fileContent: sampleTenderContent }, null, 2)}</pre>
        </section>

        <section className="panel developer-test-panel">
          <div className="settings-section-title">
            <span />
            <strong>JSON 复用入口</strong>
          </div>
          <pre>{JSON.stringify({ service: 'requestOutlineGeneration', input: sampleOutlineInput }, null, 2)}</pre>
        </section>

        <section className="panel developer-test-panel is-wide">
          <div className="settings-section-title">
            <span />
            <strong>事件日志</strong>
          </div>
          <pre>{events.length ? events.join('\n') : '尚未开始请求。'}</pre>
        </section>

        <section className="panel developer-test-panel is-wide">
          <div className="settings-section-title">
            <span />
            <strong>返回内容</strong>
          </div>
          <pre>{content || result || '暂无内容。'}</pre>
        </section>
      </div>
    </div>
  );
}

export default DeveloperTestPage;
