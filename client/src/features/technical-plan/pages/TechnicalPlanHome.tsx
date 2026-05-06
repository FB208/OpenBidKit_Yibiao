import { useEffect } from 'react';
import DocumentAnalysisPage from './DocumentAnalysisPage';
import BidAnalysisPage from './BidAnalysisPage';
import OutlineEditPage from './OutlineEditPage';
import ContentEditPage from './ContentEditPage';
import { useTechnicalPlanWorkflow } from '../hooks/useTechnicalPlanWorkflow';
import { FloatingToolbar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon } from '../../../shared/ui';
import type { TechnicalPlanStep } from '../types';

const steps: TechnicalPlanStep[] = [
  'document-analysis',
  'bid-analysis',
  'outline-generation',
  'content-edit',
  'expand',
];

const stepLabels: Record<TechnicalPlanStep, string> = {
  'document-analysis': '上传招标文件',
  'bid-analysis': '招标文件解析',
  'outline-generation': '目录生成',
  'content-edit': '生成正文',
  expand: '扩写改写',
};

const resetState = {
  step: 'document-analysis' as TechnicalPlanStep,
  fileName: '',
  fileContent: '',
  projectOverview: '',
  techRequirements: '',
  bidAnalysisMode: 'key' as const,
  bidAnalysisTasks: {},
  bidAnalysisProgress: 0,
  outlineMode: 'free' as const,
  bidAnalysisTask: undefined,
  outlineGenerationTask: undefined,
  outlineData: null,
};

function TechnicalPlanHome() {
  const { state, setState } = useTechnicalPlanWorkflow();
  const activeIndex = steps.indexOf(state.step);
  const bidAnalysisReady = Boolean(state.projectOverview && state.techRequirements && state.bidAnalysisProgress === 100);
  const isNextDisabled = activeIndex >= steps.length - 1
    || (state.step === 'document-analysis' && !state.fileContent)
    || (state.step === 'bid-analysis' && !bidAnalysisReady)
    || (state.step === 'outline-generation' && !state.outlineData);
  const nextTooltip = state.step === 'document-analysis' && !state.fileContent
    ? '上传完招标文件后才能进入下一步'
    : state.step === 'bid-analysis' && !bidAnalysisReady
      ? '招标文件解析完成后才能进入目录生成'
      : state.step === 'outline-generation' && !state.outlineData
        ? '目录生成完成后才能进入正文生成'
        : activeIndex >= steps.length - 1
          ? '当前已经是最后一步'
          : `进入${stepLabels[steps[activeIndex + 1]]}`;

  const switchStep = (step: TechnicalPlanStep) => {
    setState((prev) => ({ ...prev, step }));
  };

  const goToOffset = (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) {
      switchStep(nextStep);
    }
  };

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }

    const unsubscribe = window.yibiao.tasks.onTaskEvent<typeof state>((event) => {
      const taskType = (event.task as { type?: string } | undefined)?.type;
      const technicalPlan = event.technicalPlan;

      if (!technicalPlan) {
        return;
      }

      setState((prev) => {
        if (taskType === 'bid-analysis') {
          return {
            ...prev,
            bidAnalysisTask: technicalPlan.bidAnalysisTask,
            bidAnalysisTasks: technicalPlan.bidAnalysisTasks || prev.bidAnalysisTasks,
            bidAnalysisProgress: technicalPlan.bidAnalysisProgress ?? prev.bidAnalysisProgress,
            projectOverview: technicalPlan.projectOverview ?? prev.projectOverview,
            techRequirements: technicalPlan.techRequirements ?? prev.techRequirements,
          };
        }

        if (taskType === 'outline-generation') {
          return {
            ...prev,
            outlineGenerationTask: technicalPlan.outlineGenerationTask,
            outlineData: technicalPlan.outlineGenerationTask?.status === 'success' && technicalPlan.outlineData
              ? technicalPlan.outlineData
              : prev.outlineData,
          };
        }

        return prev;
      });
    });
    window.yibiao.tasks.getActiveTasks().catch((error) => {
      console.warn('获取后台任务状态失败', error);
    });

    return unsubscribe;
  }, [setState]);

  const toolbarGroups = [
    {
      id: 'technical-plan-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger' as const,
          tooltip: '清空当前技术方案流程',
          onClick: () => setState(resetState),
        },
        {
          id: 'home',
          label: '首页',
          variant: state.step === 'document-analysis' ? 'primary' as const : 'secondary' as const,
          tooltip: '回到上传招标文件',
          onClick: () => switchStep('document-analysis'),
        },
      ],
    },
    {
      id: 'technical-plan-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary' as const,
          disabled: isNextDisabled,
          tooltip: nextTooltip,
          onClick: () => goToOffset(1),
        },
      ],
    },
  ];

  return (
    <div className="page-stack technical-workbench">
      {state.step === 'document-analysis' && (
        <DocumentAnalysisPage
          fileName={state.fileName}
          fileContent={state.fileContent}
          onFileImported={(fileName, fileContent) => setState((prev) => ({
            ...prev,
            fileName,
            fileContent,
            projectOverview: '',
            techRequirements: '',
            bidAnalysisTasks: {},
            bidAnalysisProgress: 0,
            outlineMode: 'free',
            bidAnalysisTask: undefined,
            outlineGenerationTask: undefined,
            outlineData: null,
          }))}
        />
      )}

      {state.step === 'bid-analysis' && (
        <BidAnalysisPage
          fileContent={state.fileContent}
          mode={state.bidAnalysisMode}
          tasks={state.bidAnalysisTasks}
          task={state.bidAnalysisTask}
          progress={state.bidAnalysisProgress}
          onModeChange={(mode) => setState((prev) => ({ ...prev, bidAnalysisMode: mode }))}
          onTasksChange={(updater) => setState((prev) => ({ ...prev, bidAnalysisTasks: updater(prev.bidAnalysisTasks) }))}
          onProgressChange={(progress) => setState((prev) => ({ ...prev, bidAnalysisProgress: progress }))}
          onRequiredResultChange={(projectOverview, techRequirements) => setState((prev) => ({
            ...prev,
            projectOverview,
            techRequirements,
          }))}
        />
      )}
      {state.step === 'outline-generation' && (
        <OutlineEditPage
          projectOverview={state.projectOverview}
          techRequirements={state.techRequirements}
          outlineMode={state.outlineMode}
          outlineData={state.outlineData}
          task={state.outlineGenerationTask}
          onOutlineModeChange={(outlineMode) => setState((prev) => ({ ...prev, outlineMode }))}
          onOutlineGenerated={(outlineData) => setState((prev) => ({ ...prev, outlineData }))}
        />
      )}
      {state.step === 'content-edit' && <ContentEditPage />}
      {state.step === 'expand' && (
        <section className="empty-panel compact-placeholder">
          <span className="section-kicker">STEP 05</span>
          <h3>扩写改写</h3>
          <p>后续接入旧方案导入、章节扩写和人工校准。</p>
        </section>
      )}

      <FloatingToolbar groups={toolbarGroups} label="技术方案工具条" />
    </div>
  );
}

export default TechnicalPlanHome;
