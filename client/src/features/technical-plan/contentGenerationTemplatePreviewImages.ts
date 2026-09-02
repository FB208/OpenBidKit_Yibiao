import standardQualityControlUrl from '../../../assets/content-template-preview/standard-quality-control.webp';
import visualAcceptanceWorkflowUrl from '../../../assets/content-template-preview/visual-acceptance-workflow.webp';
import visualEquipmentConfigurationUrl from '../../../assets/content-template-preview/visual-equipment-configuration.webp';
import visualMasterPlanSceneUrl from '../../../assets/content-template-preview/visual-master-plan-scene.webp';
import visualProjectOrganizationUrl from '../../../assets/content-template-preview/visual-project-organization.webp';
import visualQualityClosedLoopUrl from '../../../assets/content-template-preview/visual-quality-closed-loop.webp';
import visualScheduleGanttUrl from '../../../assets/content-template-preview/visual-schedule-gantt.webp';
import visualSiteImplementationUrl from '../../../assets/content-template-preview/visual-site-implementation.webp';
import visualTechnicalArchitectureUrl from '../../../assets/content-template-preview/visual-technical-architecture.webp';
import visualWbsMindmapUrl from '../../../assets/content-template-preview/visual-wbs-mindmap.webp';
import { parseRestrictedHtml } from '../../shared/bodyHtml/restrictedHtml';
import type { ContentGenerationTemplateId } from './contentGenerationTemplates';

const previewImages = {
  'standard-document': {
    std_fig_001: standardQualityControlUrl,
  },
  'visual-table': {
    visual_fig_001: visualMasterPlanSceneUrl,
    visual_fig_002: visualScheduleGanttUrl,
    visual_fig_003: visualQualityClosedLoopUrl,
    visual_fig_004: visualWbsMindmapUrl,
    visual_fig_005: visualTechnicalArchitectureUrl,
    visual_fig_006: visualProjectOrganizationUrl,
    visual_fig_007: visualEquipmentConfigurationUrl,
    visual_fig_008: visualSiteImplementationUrl,
    visual_fig_009: visualAcceptanceWorkflowUrl,
  },
} satisfies Record<ContentGenerationTemplateId, Record<string, string>>;

/** 仅为排版风格预览副本注入本地图片，不改变模板 HTML。 */
export function buildContentTemplatePreviewHtml(templateId: ContentGenerationTemplateId, html: string) {
  const previewHtml = parseRestrictedHtml(html).previewHtml;
  if (!previewHtml) return '';

  const document = new DOMParser().parseFromString(previewHtml, 'text/html');
  Object.entries(previewImages[templateId]).forEach(([figureId, src]) => {
    const figure = document.getElementById(figureId);
    const image = figure?.querySelector('img');
    if (!figure || !image) return;
    figure.setAttribute('data-yb-preview-image', '');
    image.setAttribute('src', src);
  });
  return document.body.innerHTML;
}
