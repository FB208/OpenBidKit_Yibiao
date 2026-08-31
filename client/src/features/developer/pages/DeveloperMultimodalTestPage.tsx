import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { aiClient } from '../../../shared/ai/aiClient';
import { useToast } from '../../../shared/ui';

const DEFAULT_PROMPT = '请描述这张图片的内容。';

interface SelectedImage {
  name: string;
  path: string;
  previewUrl: string;
  size: number;
}

// 格式化测试图片大小，便于确认当前选择的文件。
function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 开发者多模态测试页：发送单张本地图片和自定义提示词，并展示模型返回结果。
function DeveloperMultimodalTestPage() {
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [result, setResult] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();

  useEffect(() => () => {
    if (selectedImage?.previewUrl) URL.revokeObjectURL(selectedImage.previewUrl);
  }, [selectedImage]);

  const appendEvent = (message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setEvents((current) => [...current, `[${time}] ${message}`]);
  };

  const handleImageSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const filePath = window.yibiao?.file.getPathForFile(file) || '';
    if (!filePath) {
      showToast('无法读取图片本地路径，请重新选择', 'error');
      return;
    }

    setSelectedImage({
      name: file.name,
      path: filePath,
      previewUrl: URL.createObjectURL(file),
      size: file.size,
    });
    setEvents([]);
    setResult('');
  };

  const runTest = async () => {
    if (!selectedImage) {
      showToast('请先选择一张测试图片', 'info');
      return;
    }
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      showToast('请输入测试提示词', 'info');
      return;
    }

    setRunning(true);
    setEvents([]);
    setResult('');
    appendEvent(`开始测试图片：${selectedImage.name}`);

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: normalizedPrompt },
              { type: 'local_image', path: selectedImage.path, detail: 'auto' },
            ],
          },
        ],
        logTitle: '开发者测试-多模态',
      });
      if (!response.trim()) {
        throw new Error('模型未返回有效内容');
      }
      setResult(response);
      appendEvent('多模态请求完成。');
      showToast('多模态测试完成', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '多模态测试失败';
      appendEvent(`多模态请求错误：${message}`);
      showToast(message, 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page-stack developer-multimodal-test-page">
      <section className="panel developer-multimodal-hero">
        <div className="hero-copy">
          <span className="eyebrow">Multimodal Lab</span>
          <h2>多模态测试</h2>
          <p>选择一张本地图片并输入提示词，通过当前文本模型配置验证图片理解能力。</p>
        </div>
      </section>

      <div className="developer-multimodal-grid">
        <section className="panel developer-multimodal-form">
          <div className="settings-section-title">
            <span />
            <strong>测试输入</strong>
          </div>

          <div className="developer-multimodal-upload">
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              aria-label="选择多模态测试图片"
              disabled={running}
              onChange={handleImageSelect}
            />
            {selectedImage ? (
              <div className="developer-multimodal-image-card">
                <img src={selectedImage.previewUrl} alt="多模态测试图片预览" />
                <div>
                  <strong title={selectedImage.name}>{selectedImage.name}</strong>
                  <span>{formatFileSize(selectedImage.size)}</span>
                </div>
                <button type="button" className="text-button" onClick={() => setSelectedImage(null)} disabled={running}>移除</button>
              </div>
            ) : (
              <div className="developer-multimodal-empty">
                <strong>尚未选择图片</strong>
                <span>支持当前系统可读取的常见图片格式</span>
              </div>
            )}
            <button type="button" className="secondary-action" onClick={() => fileInputRef.current?.click()} disabled={running}>
              {selectedImage ? '重新选择图片' : '选择图片'}
            </button>
          </div>

          <label className="developer-multimodal-prompt">
            <span>自定义提示词</span>
            <textarea
              value={prompt}
              rows={6}
              placeholder="请输入希望模型结合图片回答的问题"
              disabled={running}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <div className="developer-multimodal-actions">
            <button type="button" className="primary-action" onClick={() => void runTest()} disabled={running}>
              {running ? '测试中...' : '测试多模态'}
            </button>
          </div>
        </section>

        <div className="developer-multimodal-output">
          <section className="panel developer-test-panel">
            <div className="settings-section-title">
              <span />
              <strong>事件日志</strong>
            </div>
            <pre>{events.length ? events.join('\n') : '尚未开始请求。'}</pre>
          </section>

          <section className="panel developer-test-panel">
            <div className="settings-section-title">
              <span />
              <strong>模型返回</strong>
            </div>
            <pre>{result || (running ? '正在等待模型返回...' : '暂无内容。')}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}

export default DeveloperMultimodalTestPage;
