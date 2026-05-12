import { useRef, useState } from 'react';
import type { AiStreamEvent } from '../../../shared/types';
import { getBidAnalysisTasks, streamBidAnalysisTask } from '../../technical-plan/services/bidAnalysisWorkflow';
import { requestOutlineGeneration } from '../../technical-plan/services/outlineWorkflow';

type RunningMode = 'stream' | 'non-stream' | null;

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

const streamTask = getBidAnalysisTasks('full').find((task) => task.id === 'projectInfo');

function DeveloperTestPage() {
  const [runningMode, setRunningMode] = useState<RunningMode>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [result, setResult] = useState('');
  const cleanupRef = useRef<(() => void) | null>(null);

  const appendEvent = (message: string) => {
    setEvents((prev) => [...prev, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`]);
  };

  const stopStream = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setRunningMode(null);
    appendEvent('已停止监听流式事件。');
  };

  const resetOutput = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setEvents([]);
    setContent('');
    setResult('');
  };

  const runStreamTest = () => {
    if (!streamTask) {
      appendEvent('未找到项目中的 JSON 招标文件解析任务。');
      return;
    }

    resetOutput();
    setRunningMode('stream');
    appendEvent(`调用项目真实流式请求：streamBidAnalysisTask(${streamTask.label})。`);

    cleanupRef.current = streamBidAnalysisTask(sampleTenderContent, streamTask, (event: AiStreamEvent) => {
      if (event.type === 'chunk') {
        setContent((prev) => `${prev}${event.chunk || ''}`);
        return;
      }

      if (event.type === 'error') {
        appendEvent(`错误事件：${event.message || 'AI 流式请求失败'}`);
        setRunningMode(null);
        cleanupRef.current?.();
        cleanupRef.current = null;
        return;
      }

      if (event.type === 'done') {
        appendEvent('流式请求完成。');
        setRunningMode(null);
        cleanupRef.current?.();
        cleanupRef.current = null;
        return;
      }

      appendEvent(event.message || `收到事件：${event.type}`);
    });
  };

  const runNonStreamTest = async () => {
    resetOutput();
    setRunningMode('non-stream');
    appendEvent('调用项目真实非流式请求：requestOutlineGeneration。');

    try {
      const outline = await requestOutlineGeneration({
        ...sampleOutlineInput,
        onProgress: appendEvent,
      });
      setResult(JSON.stringify(outline, null, 2));
      appendEvent('非流式请求完成。');
    } catch (error) {
      appendEvent(`非流式错误：${error instanceof Error ? error.message : 'AI 非流式请求失败'}`);
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
            这里复用项目真实业务请求来复现 response_format 兼容问题：流式按钮使用招标文件解析任务，非流式按钮使用目录生成任务。
          </p>
          <div className="developer-test-actions">
            <button type="button" className="primary-action" onClick={runStreamTest} disabled={running || !streamTask}>
              {runningMode === 'stream' ? '流式请求中...' : '测试流式'}
            </button>
            <button type="button" className="primary-action" onClick={runNonStreamTest} disabled={running}>
              {runningMode === 'non-stream' ? '非流式请求中...' : '测试非流式'}
            </button>
            <button type="button" className="secondary-action" onClick={stopStream} disabled={runningMode !== 'stream'}>
              停止流式监听
            </button>
          </div>
        </div>
      </section>

      <div className="developer-test-grid">
        <section className="panel developer-test-panel">
          <div className="settings-section-title">
            <span />
            <strong>流式复用入口</strong>
          </div>
          <pre>{JSON.stringify({ service: 'streamBidAnalysisTask', task: streamTask?.id, fileContent: sampleTenderContent }, null, 2)}</pre>
        </section>

        <section className="panel developer-test-panel">
          <div className="settings-section-title">
            <span />
            <strong>非流式复用入口</strong>
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
