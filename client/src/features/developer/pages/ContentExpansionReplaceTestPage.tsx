import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { DeveloperExpansionReplaceTestResult, DeveloperExpansionReplaceTestStatus } from '../../../shared/types/ipc';
import type { OutlineItem } from '../../../shared/types/outline';

interface DeveloperReplaceTestSection {
  id: string;
  title: string;
  description: string;
  path: string;
  content: string;
}

interface DeveloperReplaceTestParagraphOption {
  id: string;
  label: string;
  text: string;
}

const developerReplaceTestStatusLabels: Record<DeveloperExpansionReplaceTestStatus, string> = {
  'replace-success': '替换成功，target_text 唯一命中',
  blocked: '应用失败，未写入模拟结果',
};

function developerReplaceTestFlattenOutline(items: OutlineItem[] = [], parentTitles: string[] = []): DeveloperReplaceTestSection[] {
  return items.flatMap((item) => {
    const title = String(item.title || '').trim() || item.id;
    const path = [...parentTitles, title].join(' / ');
    const content = String(item.content || '').trim();
    const current = content
      ? [{
        id: item.id,
        title,
        description: String(item.description || '').trim(),
        path,
        content,
      }]
      : [];
    return [...current, ...developerReplaceTestFlattenOutline(item.children || [], [...parentTitles, title])];
  });
}

function developerReplaceTestBuildParagraphOptions(content: string): DeveloperReplaceTestParagraphOption[] {
  return String(content || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(0, 80)
    .map((paragraph, index) => ({
      id: String(index),
      label: `${index + 1}. ${paragraph.replace(/\s+/g, ' ').slice(0, 80)}`,
      text: paragraph,
    }));
}

function developerReplaceTestFormatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function developerReplaceTestGetStatusTone(status?: DeveloperExpansionReplaceTestStatus) {
  if (status === 'blocked') return 'is-danger';
  if (status === 'replace-success') return 'is-success';
  return 'is-muted';
}

// 开发者测试页：局部调用正式正文扩写 replace patch runtime，不保存正文、不更新技术方案状态。
function ContentExpansionReplaceTestPage() {
  const { showToast } = useToast();
  const [loadingState, setLoadingState] = useState(false);
  const [running, setRunning] = useState(false);
  const [sections, setSections] = useState<DeveloperReplaceTestSection[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState('');
  const [selectedParagraphId, setSelectedParagraphId] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [result, setResult] = useState<DeveloperExpansionReplaceTestResult | null>(null);

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId) || sections[0] || null,
    [sections, selectedSectionId],
  );

  const paragraphOptions = useMemo(
    () => developerReplaceTestBuildParagraphOptions(selectedSection?.content || ''),
    [selectedSection?.content],
  );

  const loadTechnicalPlanState = async () => {
    setLoadingState(true);
    try {
      const bridge = window.yibiao;
      if (!bridge?.technicalPlan?.loadState) {
        throw new Error('当前 preload 未暴露 technicalPlan.loadState。');
      }

      const state = await bridge.technicalPlan.loadState();
      const nextSections = developerReplaceTestFlattenOutline(state.outlineData?.outline || []);
      setSections(nextSections);
      setResult(null);

      if (!nextSections.length) {
        setSelectedSectionId('');
        setSelectedParagraphId('');
        setSelectedText('');
        showToast('当前 outlineData.outline[*].content 没有正文内容。', 'info', { title: '未找到可测试正文' });
        return;
      }

      const nextSection = nextSections.find((section) => section.id === selectedSectionId) || nextSections[0];
      const nextParagraph = developerReplaceTestBuildParagraphOptions(nextSection.content)[0];
      setSelectedSectionId(nextSection.id);
      setSelectedParagraphId(nextParagraph?.id || '');
      setSelectedText(nextParagraph?.text || '');
      showToast(`找到 ${nextSections.length} 个有正文的小节。`, 'success', { title: '已读取正文' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取技术方案状态失败', 'error', { title: '读取失败' });
    } finally {
      setLoadingState(false);
    }
  };

  useEffect(() => {
    void loadTechnicalPlanState();
  }, []);

  const handleSectionChange = (sectionId: string) => {
    const section = sections.find((item) => item.id === sectionId) || null;
    const nextParagraph = developerReplaceTestBuildParagraphOptions(section?.content || '')[0];
    setSelectedSectionId(sectionId);
    setSelectedParagraphId(nextParagraph?.id || '');
    setSelectedText(nextParagraph?.text || '');
    setResult(null);
  };

  const handleParagraphChange = (paragraphId: string) => {
    const paragraph = paragraphOptions.find((item) => item.id === paragraphId) || null;
    setSelectedParagraphId(paragraphId);
    setSelectedText(paragraph?.text || '');
    setResult(null);
  };

  const runReplaceTest = async () => {
    if (!selectedSection) {
      showToast('需要先读取并选择一个已有正文小节。', 'info', { title: '请选择小节' });
      return;
    }
    if (!selectedText.trim()) {
      showToast('需要提供本次要替换的原段落。', 'info', { title: '请选择段落' });
      return;
    }

    setRunning(true);
    setResult(null);
    try {
      const bridge = window.yibiao;
      if (!bridge?.developerExpansionReplaceTest?.run) {
        throw new Error('当前 preload 未暴露 developerExpansionReplaceTest.run。');
      }

      const nextResult = await bridge.developerExpansionReplaceTest.run({
        sectionId: selectedSection.id,
        sectionTitle: selectedSection.title,
        sectionDescription: selectedSection.description,
        content: selectedSection.content,
        selectedText,
      });
      setResult(nextResult);
      showToast(
        nextResult.status === 'blocked' ? '正式 applyContentExpansionPatch 未能应用本次 patch。' : '正式 applyContentExpansionPatch 已完成模拟替换。',
        nextResult.status === 'blocked' ? 'error' : nextResult.status === 'replace-success' ? 'success' : 'info',
        { title: `正式替换逻辑：${developerReplaceTestStatusLabels[nextResult.status]}` },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : '扩写替换测试失败', 'error', { title: '测试失败' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="developer-expansion-replace-test-page">
      <section className="panel developer-expansion-replace-hero">
        <div>
          <span className="section-kicker">Developer Patch Lab</span>
          <h2>扩写替换测试</h2>
          <p>
            这是开发者专用局部测试页：直接复用当前正式正文扩写 patch 解析、校验、修复和 applyContentExpansionPatch 应用逻辑。
            测试只做模拟应用，不保存正文，也不修改数据库。
          </p>
        </div>
        <div className="developer-expansion-replace-actions">
          <button type="button" className="secondary-action" onClick={loadTechnicalPlanState} disabled={loadingState || running}>
            {loadingState ? '读取中...' : '重新读取正文'}
          </button>
          <button type="button" className="primary-action" onClick={runReplaceTest} disabled={loadingState || running || !selectedSection}>
            {running ? '正式逻辑测试中...' : '运行正式替换逻辑测试'}
          </button>
        </div>
      </section>

      <div className="developer-expansion-replace-grid">
        <section className="panel developer-expansion-replace-panel developer-expansion-replace-config">
          <div className="settings-section-title">
            <span />
            <strong>测试输入</strong>
          </div>

          <label className="developer-expansion-replace-field">
            <span>正文小节</span>
            <select value={selectedSection?.id || ''} onChange={(event) => handleSectionChange(event.target.value)} disabled={running || !sections.length}>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>{section.path}</option>
              ))}
            </select>
          </label>

          <label className="developer-expansion-replace-field">
              <span>待替换目标块</span>
            <select value={selectedParagraphId} onChange={(event) => handleParagraphChange(event.target.value)} disabled={running || !paragraphOptions.length}>
              {paragraphOptions.map((paragraph) => (
                <option key={paragraph.id} value={paragraph.id}>{paragraph.label}</option>
              ))}
            </select>
          </label>

          <label className="developer-expansion-replace-field">
            <span>目标块原文，可手动调整</span>
            <textarea value={selectedText} onChange={(event) => setSelectedText(event.target.value)} rows={8} disabled={running} />
          </label>

          <div className="developer-expansion-replace-source-note">
            <strong>数据来源</strong>
            <span>只读取 window.yibiao.technicalPlan.loadState() 返回的 outlineData.outline[*].content。</span>
          </div>
        </section>

        <section className="panel developer-expansion-replace-panel developer-expansion-replace-diagnostics">
          <div className="settings-section-title">
            <span />
            <strong>诊断结果</strong>
          </div>

          <div className={`developer-expansion-replace-status ${developerReplaceTestGetStatusTone(result?.status)}`}>
            <span>状态</span>
            <strong>{result ? developerReplaceTestStatusLabels[result.status] : '尚未运行'}</strong>
          </div>

          <div className="developer-expansion-replace-metrics">
            <article>
              <span>逻辑模式</span>
              <strong>正式业务逻辑</strong>
            </article>
            <article>
              <span>匹配策略</span>
              <strong>{result?.diagnostics.matchStrategy || '-'}</strong>
            </article>
            <article>
              <span>小节数</span>
              <strong>{sections.length}</strong>
            </article>
            <article>
              <span>段落数</span>
              <strong>{paragraphOptions.length}</strong>
            </article>
            <article>
              <span>target_text 命中</span>
              <strong>{result ? String(result.diagnostics.targetTextMatched) : '-'}</strong>
            </article>
            <article>
              <span>候选命中数</span>
              <strong>{result?.diagnostics.candidateCount ?? '-'}</strong>
            </article>
            <article>
              <span>字数变化</span>
              <strong>{result ? result.diagnostics.deltaChars : '-'}</strong>
            </article>
          </div>

          <pre>{result ? developerReplaceTestFormatJson(result.diagnostics) : '运行后展示 target_text 命中、正式匹配策略和字数变化。'}</pre>
        </section>

        <section className="panel developer-expansion-replace-panel">
          <div className="settings-section-title">
            <span />
            <strong>模型原始 replace patch</strong>
          </div>
          <pre>{result ? developerReplaceTestFormatJson(result.rawPatch) : '暂无 patch。'}</pre>
        </section>

        <section className="panel developer-expansion-replace-panel">
          <div className="settings-section-title">
            <span />
            <strong>实际应用 patch</strong>
          </div>
          <pre>{result ? developerReplaceTestFormatJson(result.appliedPatch) : '这里会显示传入正式 applyContentExpansionPatch 的 patch。'}</pre>
        </section>

        <section className="panel developer-expansion-replace-panel is-wide">
          <div className="settings-section-title">
            <span />
            <strong>target_text 命中的原文块</strong>
          </div>
          <pre>{result?.diagnostics.matchedText || 'target_text 未命中时这里为空。'}</pre>
        </section>

        <section className="panel developer-expansion-replace-panel is-wide">
          <div className="settings-section-title">
            <span />
            <strong>模拟应用后的正文</strong>
          </div>
          <pre>{result?.nextContent || result?.applyError || '测试结果只在这里预览，不会写入真实正文。'}</pre>
        </section>
      </div>
    </div>
  );
}

export default ContentExpansionReplaceTestPage;
