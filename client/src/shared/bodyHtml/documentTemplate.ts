import templateHtml from '../../../electron/resources/content-generation/正文模板.html?raw';
import standardQualityControlUrl from '../../../assets/content-template-preview/standard-quality-control.webp';
import visualMasterPlanSceneUrl from '../../../assets/content-template-preview/visual-master-plan-scene.webp';
import visualQualityClosedLoopUrl from '../../../assets/content-template-preview/visual-quality-closed-loop.webp';
import visualTechnicalArchitectureUrl from '../../../assets/content-template-preview/visual-technical-architecture.webp';
import visualWbsMindmapUrl from '../../../assets/content-template-preview/visual-wbs-mindmap.webp';

/** 共用样张的示例图片地址，预览时替换为 Vite 打包后的本地资源地址。 */
const previewImages: Record<string, string> = {
  'assets/standard-quality-control.webp': standardQualityControlUrl,
  'assets/visual-master-plan-scene.webp': visualMasterPlanSceneUrl,
  'assets/visual-quality-closed-loop.webp': visualQualityClosedLoopUrl,
  'assets/visual-technical-architecture.webp': visualTechnicalArchitectureUrl,
  'assets/visual-wbs-mindmap.webp': visualWbsMindmapUrl,
};

/** 模板设置读取共用 HTML，仅补入预览图片地址，正文结构保持一致。 */
export const DOCUMENT_DISPLAY_TEMPLATE_HTML = Object.entries(previewImages).reduce(
  (html, [assetRef, url]) => html.replaceAll(`src="${assetRef}"`, `src="${url}"`),
  templateHtml,
);
