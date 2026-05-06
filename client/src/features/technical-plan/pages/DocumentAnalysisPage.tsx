import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { useToast } from '../../../shared/ui';
import type { FileParserProvider } from '../../../shared/types';

const parserLabels: Record<FileParserProvider, string> = {
  local: '本地解析',
  'mineru-accurate-api': 'MinerU 精准解析 API',
  'mineru-agent-api': 'MinerU-Agent 轻量解析 API',
};

interface DocumentAnalysisPageProps {
  fileName: string;
  fileContent: string;
  onFileImported: (fileName: string, fileContent: string) => void;
}

function DocumentAnalysisPage({
  fileName,
  fileContent,
  onFileImported,
}: DocumentAnalysisPageProps) {
  const [parserLabel, setParserLabel] = useState(parserLabels.local);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let mounted = true;

    const loadParserConfig = async () => {
      if (!window.yibiao) {
        return;
      }

      try {
        const config = await window.yibiao.config.load();
        if (mounted) {
          setParserLabel(parserLabels[config.file_parser.provider] || parserLabels.local);
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '读取文件解析配置失败', 'error');
      }
    };

    loadParserConfig();

    return () => {
      mounted = false;
    };
  }, [showToast]);

  const importDocument = async () => {
    try {
      setBusy(true);
      const result = await window.yibiao?.file.importDocument();

      if (!result?.success || !result.file_content) {
        showToast(result?.message || '未导入文件', 'info');
        return;
      }

      onFileImported(result.file_name || '未命名文件', result.file_content);
      if (result.parser_label) {
        setParserLabel(result.parser_label);
      }
      showToast(result.message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文件解析失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-step-body">
      <section className="analysis-import-card">
        <div>
          <span className="section-kicker">STEP 01</span>
          <strong>上传招标文件</strong>
          <p>当前解析方案：{parserLabel}</p>
        </div>
        <div className="analysis-actions">
          <button type="button" className="primary-action" onClick={importDocument} disabled={busy}>
            {busy ? '解析中...' : fileContent ? '重新选择文件' : '选择文件'}
          </button>
        </div>
      </section>

      <section className="analysis-markdown-card">
        <div className="analysis-result-head">
          <strong>招标文件内容</strong>
          <span>{fileContent ? '来自原始招标文件' : '等待上传'}</span>
        </div>

        {fileContent ? (
          <div className="markdown-viewer">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
              {fileContent}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="markdown-empty-state">
            <strong>尚未导入招标文件</strong>
            <p>当前步骤只负责把招标文件解析成 Markdown。下一步再基于这里的 Markdown 内容进行 AI 标书理解。</p>
          </div>
        )}
      </section>

    </div>
  );
}

export default DocumentAnalysisPage;
