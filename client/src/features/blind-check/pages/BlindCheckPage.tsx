import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon, CopyIcon, FileTextIcon, ListBulletIcon, MagicWandIcon, Pencil1Icon, ReloadIcon, TrashIcon, UploadIcon } from '@radix-ui/react-icons';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, FloatingToolbar, OptionCardList, ProgressBar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, UploadBoard, UploadEmpty, UploadFilePill, UploadRow, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import ExtractionNotice from '../components/ExtractionNotice';
import FindingGroupList, { categoryLabels, severityLabels } from '../components/FindingGroupList';
import FixPanel from '../components/FixPanel';
import PresetEditor from '../components/PresetEditor';
import { StepHeader, StepTabs, type StepTab } from '../components/StepLayout';
import { formatDuration, formatFileSize } from '../format';
import { presetTabPending, presetTabs, presetTabSummary } from '../presetFields';
import type {
  BlindCheckCategory,
  BlindCheckCredentialWord,
  BlindCheckFile,
  BlindCheckFixResultState,
  BlindCheckIssue,
  BlindCheckPreset,
  BlindCheckPresetTab,
  BlindCheckProfile,
  BlindCheckResultState,
  BlindCheckResultTab,
  BlindCheckReviewState,
  BlindCheckSeverity,
  BlindCheckStep,
  BlindCheckSummary,
  BlindCheckTaskState,
  BlindCheckTenderSources,
  BlindCheckWorkspaceState,
} from '../types';

const steps: BlindCheckStep[] = ['upload', 'preset', 'results', 'fix'];

const stepLabels: Record<BlindCheckStep, string> = {
  upload: '选择标书',
  preset: '格式要求',
  results: '检查结果',
  fix: '自动修复',
};

const categoryTabs: BlindCheckCategory[] = ['privacy', 'structure', 'page', 'paragraph', 'font', 'text', 'table', 'consistency', 'image', 'other'];

const severities: BlindCheckSeverity[] = ['high', 'medium', 'low'];

const guideItems = [
  '仅支持 .docx，.doc / .wps 请先另存为 .docx 再检查。',
  '检查和修复都在副本上进行，不会改动原文件。',
  '照片、截图等图片里的文字无法识别，需人工核对。',
];

const MAX_PRESET_NAME_LENGTH = 30;
// 当前步骤超过这个时长没有新进展时，说明可能是模型或文件解析响应慢，程序仍在等待。
const SLOW_STEP_MS = 3 * 60 * 1000;
function emptyResult(): BlindCheckResultState {
  return { status: 'idle', groups: [] };
}

function emptyFixResult(): BlindCheckFixResultState {
  return { status: 'idle', groups: [] };
}

function emptyReview(): BlindCheckReviewState {
  return { status: 'idle' };
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function BlindCheckPage() {
  const { showToast } = useToast();
  const [step, setStep] = useState<BlindCheckStep>('upload');
  const [presetTab, setPresetTab] = useState<BlindCheckPresetTab>('page');
  const [resultTab, setResultTab] = useState<BlindCheckResultTab>('all');
  const [file, setFile] = useState<BlindCheckFile | null>(null);
  const [presetId, setPresetId] = useState('');
  const [presets, setPresets] = useState<BlindCheckPreset[]>([]);
  const [useCredentialWords, setUseCredentialWords] = useState(true);
  const [aiReviewEnabled, setAiReviewEnabled] = useState(true);
  const [fixAiEnabled, setFixAiEnabled] = useState(true);
  const [checkDialogOpen, setCheckDialogOpen] = useState(false);
  const [fixDialogOpen, setFixDialogOpen] = useState(false);
  const [credentialWords, setCredentialWords] = useState<BlindCheckCredentialWord[]>([]);
  const [result, setResult] = useState<BlindCheckResultState>(emptyResult);
  const [checkTask, setCheckTask] = useState<BlindCheckTaskState | undefined>();
  const [review, setReview] = useState<BlindCheckReviewState>(emptyReview);
  const [issues, setIssues] = useState<BlindCheckIssue[]>([]);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<'file' | 'preset' | 'credential' | null>(null);
  const [currentSignature, setCurrentSignature] = useState<string | null>(null);
  const [presetDialog, setPresetDialog] = useState<{ mode: 'create' | 'rename'; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const [fixRules, setFixRules] = useState<string[]>([]);
  const [fixResult, setFixResult] = useState<BlindCheckFixResultState>(emptyFixResult);
  const [fixTask, setFixTask] = useState<BlindCheckTaskState | undefined>();
  const [startingFix, setStartingFix] = useState(false);
  const [savingFixed, setSavingFixed] = useState(false);
  const [savedFixedPath, setSavedFixedPath] = useState('');
  const [extractionTask, setExtractionTask] = useState<BlindCheckTaskState | undefined>();
  const [startingExtraction, setStartingExtraction] = useState(false);
  const [tenderSources, setTenderSources] = useState<BlindCheckTenderSources | null>(null);
  const [dismissedExtractionError, setDismissedExtractionError] = useState('');
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const hydratedRef = useRef(false);
  const extractionStatusRef = useRef<string | undefined>(undefined);
  const checkStatusRef = useRef<string | undefined>(undefined);
  const saveSequenceRef = useRef(0);

  const applyState = useCallback((state: BlindCheckWorkspaceState) => {
    setStep(state.step);
    setPresetTab(state.presetTab);
    setResultTab(state.resultTab);
    setFile(state.file);
    setPresetId(state.presetId);
    setUseCredentialWords(state.useCredentialWords);
    setAiReviewEnabled(state.aiReviewEnabled);
    setFixAiEnabled(state.fixAiEnabled);
    setResult(state.result || emptyResult());
    setCheckTask(state.checkTask);
    setReview(state.review || emptyReview());
    setIssues(state.issues || []);
    setFixRules(state.fixRules || []);
    setFixResult(state.fixResult || emptyFixResult());
    setFixTask(state.fixTask);
    setExtractionTask(state.extractionTask);
  }, []);

  const activePreset = presets.find((preset) => preset.id === presetId) || presets[0];
  // 程序检查阶段；AI 复核在程序结果出来之后进行，期间结果照常显示。
  const isRunning = starting || result.status === 'running';
  const isReviewing = review.status === 'running';
  const isCheckBusy = isRunning || isReviewing || checkTask?.status === 'running';
  const isFixRunning = startingFix || fixTask?.status === 'running' || fixResult.status === 'running';
  const isExtracting = startingExtraction || extractionTask?.status === 'running';
  const activeIndex = steps.indexOf(step);
  // 提取中的 AI 请求可能等待较久且没有中间进度，用已运行时长和长时间无进展提示表明程序仍在工作。
  const extractionStartedAt = extractionTask?.status === 'running' ? Date.parse(extractionTask.started_at) : Number.NaN;
  const extractionUpdatedAt = extractionTask?.status === 'running' ? Date.parse(extractionTask.updated_at) : Number.NaN;
  const extractionElapsedText = Number.isFinite(extractionStartedAt) ? `已运行 ${formatDuration(nowTick - extractionStartedAt)}` : '';
  const extractionSlow = Number.isFinite(extractionUpdatedAt) && nowTick - extractionUpdatedAt > SLOW_STEP_MS;

  useEffect(() => {
    if (!isExtracting) return undefined;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isExtracting]);

  // 受管任务页面的初始化顺序：先读快照并应用，再订阅任务事件，最后回放活动任务。
  // 快照显示运行中、但任务恰好在读快照与订阅之间结束时，不会再有事件纠正，回放后补读一次快照。
  useEffect(() => {
    let canceled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const [state, presetList, words] = await Promise.all([
          window.yibiao.blindCheck.loadState(),
          window.yibiao.blindCheck.listPresets(),
          window.yibiao.blindCheck.getCredentialWords(),
        ]);
        if (canceled) return;
        setPresets(presetList);
        setCredentialWords(words);
        applyState(state);

        unsubscribe = window.yibiao.tasks.onTaskEvent((event) => {
          if (event.blindCheck) applyState(event.blindCheck);
          const patch = event.blindCheckPatch;
          if (!patch) return;
          if (Object.prototype.hasOwnProperty.call(patch, 'checkTask')) setCheckTask(patch.checkTask);
          if (Object.prototype.hasOwnProperty.call(patch, 'result')) setResult((prev) => ({ ...prev, ...(patch.result || emptyResult()) }));
          if (Object.prototype.hasOwnProperty.call(patch, 'review')) setReview((prev) => ({ ...prev, ...(patch.review || emptyReview()) }));
          if (Object.prototype.hasOwnProperty.call(patch, 'fixTask')) setFixTask(patch.fixTask);
          if (Object.prototype.hasOwnProperty.call(patch, 'fixResult')) setFixResult((prev) => ({ ...prev, ...(patch.fixResult || emptyFixResult()) }));
          if (Object.prototype.hasOwnProperty.call(patch, 'extractionTask')) setExtractionTask(patch.extractionTask);
        });

        const activeTypes = new Set((await window.yibiao.tasks.getActiveTasks()).map((task) => task.type));
        if (canceled) return;
        const finishedMeanwhile = ([[state.checkTask, 'blind-check-run'], [state.fixTask, 'blind-check-fix'], [state.extractionTask, 'blind-check-preset-extraction']] as const)
          .some(([task, type]) => task?.status === 'running' && !activeTypes.has(type));
        if (finishedMeanwhile) applyState(await window.yibiao.blindCheck.loadState());
      } catch (error) {
        if (!canceled) showToast(errorMessage(error, '读取暗标合规检查状态失败'), 'error');
      } finally {
        if (!canceled) {
          hydratedRef.current = true;
          setAnalyticsReady(true);
        }
      }
    })();
    return () => {
      canceled = true;
      unsubscribe?.();
    };
  }, [applyState, showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    void window.yibiao.blindCheck.saveUiState({ step, presetTab, resultTab })
      .catch((error) => showToast(errorMessage(error, '保存暗标合规检查页面状态失败'), 'error'));
  }, [presetTab, resultTab, showToast, step]);

  useEffect(() => {
    if (!analyticsReady) return;
    trackPageView(step === 'upload'
      ? 'blind-check/upload'
      : step === 'preset'
        ? `blind-check/preset/${presetTab}`
        : step === 'fix'
          ? 'blind-check/fix'
          : `blind-check/results/${resultTab}`);
  }, [analyticsReady, presetTab, resultTab, step]);

  // 提取任务从运行变为完成时，重新读取预设列表和选中的预设；失败时提示原因。
  useEffect(() => {
    const previous = extractionStatusRef.current;
    extractionStatusRef.current = extractionTask?.status;
    if (previous !== 'running' || !extractionTask || extractionTask.status === 'running') return;
    if (extractionTask.status === 'error') {
      showToast(extractionTask.error || '从招标文件提取格式要求失败', 'error');
      return;
    }
    void Promise.all([window.yibiao.blindCheck.listPresets(), window.yibiao.blindCheck.loadState()])
      .then(([presetList, state]) => {
        setPresets(presetList);
        applyState(state);
        setPresetTab('source');
        showToast(extractionTask.logs.at(-1) || '已从招标文件生成预设', extractionTask.stats?.unverified || extractionTask.stats?.omissions || extractionTask.stats?.fewFields ? 'info' : 'success');
      })
      .catch((error) => showToast(errorMessage(error, '读取生成的预设失败'), 'error'));
  }, [applyState, extractionTask, showToast]);

  // 检查任务（含 AI 复核）结束时重新读取一次状态，拿到 Main 按最终结论算好的问题清单。
  useEffect(() => {
    const previous = checkStatusRef.current;
    checkStatusRef.current = checkTask?.status;
    if (previous !== 'running' || !checkTask || checkTask.status === 'running') return;
    void window.yibiao.blindCheck.loadState()
      .then(applyState)
      .catch((error) => showToast(errorMessage(error, '读取暗标检查结果失败'), 'error'));
  }, [applyState, checkTask, showToast]);

  const openSourceDialog = async () => {
    try {
      setTenderSources(await window.yibiao.blindCheck.getTenderSources());
      setSourceDialogOpen(true);
    } catch (error) {
      showToast(errorMessage(error, '读取招标文件来源失败'), 'error');
    }
  };

  const startExtraction = async (source: 'technical-plan' | 'file') => {
    let filePath: string | undefined;
    if (source === 'file') {
      const selection = await window.yibiao.file.selectBlindCheckTenderFile().catch((error) => {
        showToast(errorMessage(error, '选择招标文件失败'), 'error');
        return null;
      });
      if (!selection) return;
      if (!selection.success || !selection.files?.length) {
        showToast(selection.message || '未选择文件', selection.message === '已取消选择' ? 'info' : 'error');
        return;
      }
      filePath = selection.files[0].file_path;
    }
    setSourceDialogOpen(false);
    setStartingExtraction(true);
    setDismissedExtractionError('');
    extractionStatusRef.current = 'running';
    try {
      await window.yibiao.tasks.startBlindCheckPresetExtraction({ source, filePath });
    } catch (error) {
      extractionStatusRef.current = undefined;
      showToast(errorMessage(error, '启动格式要求提取失败'), 'error');
    } finally {
      setStartingExtraction(false);
    }
  };

  /** 检查弹窗里选定方式后启动：仅程序检查，或程序检查后接着 AI 复核。选择由 Main 记下作为下次的默认选项。 */
  const startCheck = (aiReview: boolean) => {
    setCheckDialogOpen(false);
    setAiReviewEnabled(aiReview);
    setStarting(true);
    void window.yibiao.tasks.startBlindCheck({ aiReview })
      .catch((error) => showToast(errorMessage(error, '启动暗标合规检查失败'), 'error'))
      .finally(() => setStarting(false));
  };

  // 进入检查结果时读取当前检查条件，判断已有结果是否过期；检查由用户点「开始检查」后在弹窗里选择方式再启动。
  useEffect(() => {
    if (!analyticsReady || step !== 'results' || !file) return;
    let canceled = false;
    void window.yibiao.blindCheck.getInputSignature()
      .then((signature) => {
        if (!canceled) setCurrentSignature(signature);
      })
      .catch((error) => showToast(errorMessage(error, '读取检查条件失败'), 'error'));
    return () => {
      canceled = true;
    };
  }, [activePreset, analyticsReady, file, showToast, step, useCredentialWords]);

  // 自动修复只针对与当前检查条件一致的结果，进入第四步时读取一次当前签名。
  useEffect(() => {
    if (!analyticsReady || step !== 'fix' || !file) return;
    let canceled = false;
    void window.yibiao.blindCheck.getInputSignature()
      .then((signature) => {
        if (!canceled) setCurrentSignature(signature);
      })
      .catch((error) => showToast(errorMessage(error, '读取检查条件失败'), 'error'));
    return () => {
      canceled = true;
    };
  }, [activePreset, analyticsReady, file, showToast, step, useCredentialWords]);

  /** 修复弹窗里选定方式后启动：仅程序修复，或程序修复后续接检查时的 AI 复核会话做 AI 修复。 */
  const startFix = (ai: boolean) => {
    setFixDialogOpen(false);
    setFixAiEnabled(ai);
    setStartingFix(true);
    void window.yibiao.tasks.startBlindCheckFix({ ai })
      .catch((error) => showToast(errorMessage(error, '启动暗标自动修复失败'), 'error'))
      .finally(() => setStartingFix(false));
  };

  const toggleFixRule = async (ruleId: string, enabled: boolean) => {
    const next = enabled ? [...fixRules, ruleId] : fixRules.filter((item) => item !== ruleId);
    setFixRules(next);
    try {
      const state = await window.yibiao.blindCheck.saveFixRules(next);
      setFixRules(state.fixRules);
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(errorMessage(error, '保存修复项失败'), 'error');
    }
  };

  const saveFixedDocument = async () => {
    setSavingFixed(true);
    try {
      const saved = await window.yibiao.blindCheck.saveFixedDocument();
      if (saved.canceled) return;
      if (!saved.success || !saved.path) {
        showToast(saved.message || '修复结果导出失败', 'error');
        return;
      }
      setSavedFixedPath(saved.path);
      showToast(saved.message || '修复结果已导出', 'success');
    } catch (error) {
      showToast(errorMessage(error, '修复结果导出失败'), 'error');
    } finally {
      setSavingFixed(false);
    }
  };

  const openSavedDocument = async () => {
    try {
      await window.yibiao.export.openFile(savedFixedPath);
      setSavedFixedPath('');
    } catch (error) {
      showToast(errorMessage(error, '打开文档失败'), 'error');
    }
  };

  const chooseFile = async (filePaths?: string[]) => {
    setBusy('file');
    try {
      const selection = await window.yibiao.file.selectBlindCheckFile({ filePaths });
      if (!selection?.success || !selection.files?.length) {
        const message = selection?.message || '未选择文件';
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      applyState(await window.yibiao.blindCheck.importFile(selection.files[0].file_path));
      showToast('已选择待检文档', 'success');
    } catch (error) {
      showToast(errorMessage(error, '选择待检文档失败'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const removeFile = async () => {
    setBusy('file');
    try {
      applyState(await window.yibiao.blindCheck.removeFile());
    } catch (error) {
      showToast(errorMessage(error, '移除待检文档失败'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const resetAll = async () => {
    try {
      applyState(await window.yibiao.blindCheck.clear());
      setCurrentSignature(null);
      showToast('已重置暗标合规检查', 'success');
    } catch (error) {
      showToast(errorMessage(error, '重置暗标合规检查失败'), 'error');
    }
  };

  const selectPreset = async (nextId: string) => {
    setBusy('preset');
    try {
      applyState(await window.yibiao.blindCheck.selectPreset(nextId));
    } catch (error) {
      showToast(errorMessage(error, '切换格式预设失败'), 'error');
    } finally {
      setBusy(null);
    }
  };

  // 先在页面上更新，再保存；只采用最后一次保存的返回值，避免连续修改时被旧结果覆盖。
  const savePresetProfile = async (profile: BlindCheckProfile) => {
    if (!activePreset) return;
    if (activePreset.builtin) {
      await copyBuiltinAndSave(profile);
      return;
    }
    const targetId = activePreset.id;
    const sequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = sequence;
    setPresets((current) => current.map((preset) => (preset.id === targetId ? { ...preset, profile } : preset)));
    try {
      const saved = await window.yibiao.blindCheck.updatePreset(targetId, { profile });
      if (saveSequenceRef.current !== sequence) return;
      setPresets((current) => current.map((preset) => (preset.id === saved.id ? saved : preset)));
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(errorMessage(error, '保存格式预设失败'), 'error');
      const presetList = await window.yibiao.blindCheck.listPresets().catch(() => null);
      if (presetList) setPresets(presetList);
    }
  };

  // 内置预设只读：首次修改时自动复制为"我的预设"并切换过去，内置预设保持不变。
  const copyBuiltinAndSave = async (profile: BlindCheckProfile) => {
    if (!activePreset) return;
    const baseName = activePreset.name;
    setBusy('preset');
    try {
      const created = await window.yibiao.blindCheck.createPreset({ basePresetId: activePreset.id });
      await window.yibiao.blindCheck.updatePreset(created.id, { profile });
      setPresets(await window.yibiao.blindCheck.listPresets());
      setPresetId(created.id);
      showToast(`内置预设不可修改，已复制为「${created.name}」并保存修改`, 'success');
    } catch (error) {
      showToast(errorMessage(error, `复制「${baseName}」失败`), 'error');
    } finally {
      setBusy(null);
    }
  };

  const validatePresetName = (name: string, excludeId?: string) => {
    const value = name.trim();
    if (!value) return '请输入预设名称';
    if (value.length > MAX_PRESET_NAME_LENGTH) return `预设名称不超过 ${MAX_PRESET_NAME_LENGTH} 个字`;
    if (presets.some((preset) => preset.id !== excludeId && preset.name === value)) return '已存在同名预设';
    return '';
  };

  const submitPresetDialog = async () => {
    if (!presetDialog || !activePreset) return;
    const invalid = validatePresetName(presetDialog.name, presetDialog.mode === 'rename' ? activePreset.id : undefined);
    if (invalid) {
      showToast(invalid, 'info');
      return;
    }
    setBusy('preset');
    try {
      if (presetDialog.mode === 'create') {
        const created = await window.yibiao.blindCheck.createPreset({ name: presetDialog.name.trim(), basePresetId: activePreset.id });
        setPresets(await window.yibiao.blindCheck.listPresets());
        setPresetId(created.id);
        showToast('已创建我的预设', 'success');
      } else {
        const renamed = await window.yibiao.blindCheck.updatePreset(activePreset.id, { name: presetDialog.name.trim() });
        setPresets((current) => current.map((preset) => (preset.id === renamed.id ? renamed : preset)));
        showToast('保存成功', 'success');
      }
      setPresetDialog(null);
    } catch (error) {
      showToast(errorMessage(error, '保存格式预设失败'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const deletePreset = async () => {
    if (!activePreset || activePreset.builtin) return;
    setBusy('preset');
    try {
      setPresets(await window.yibiao.blindCheck.deletePreset(activePreset.id));
      applyState(await window.yibiao.blindCheck.loadState());
      setDeleteOpen(false);
      showToast('已删除预设', 'success');
    } catch (error) {
      showToast(errorMessage(error, '删除格式预设失败'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleCredentialWords = async (enabled: boolean) => {
    setBusy('credential');
    try {
      applyState(await window.yibiao.blindCheck.setUseCredentialWords(enabled));
      showToast('保存成功', 'success');
    } catch (error) {
      showToast(errorMessage(error, '保存资信库设置失败'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const goToOffset = (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (nextStep) setStep(nextStep);
  };

  // 当前文件和预设已有成功的检查结果（不在检查或复核中）。
  const checkReady = !isRunning && !isReviewing && result.status === 'success' && currentSignature !== null && result.inputSignature === currentSignature;
  // 与当前检查结果对应的 AI 复核成功时，修复才能选 AI 修复。
  const reviewReady = review.status === 'success' && Boolean(review.review) && currentSignature !== null && review.inputSignature === currentSignature && result.inputSignature === currentSignature;
  const fixStale = fixResult.status !== 'idle' && fixResult.status !== 'running' && currentSignature !== null && fixResult.inputSignature !== currentSignature;
  const hasFixedDocument = !isFixRunning && fixResult.status === 'success' && !fixStale && Boolean(fixResult.outputPath);
  // 修复项开关旁的"当前 N 处"：按最终问题清单里该规则的处数。
  const currentRuleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!checkReady) return counts;
    for (const issue of issues) {
      if (issue.ruleId) counts[issue.ruleId] = (counts[issue.ruleId] || 0) + issue.count;
    }
    return counts;
  }, [checkReady, issues]);

  // 卡片和页签摘要：按最终问题清单的处数汇总，全部、各类别和其中的高风险处数。
  const issueStats = useMemo(() => {
    const summary: BlindCheckSummary = { high: 0, medium: 0, low: 0, total: 0 };
    const byCategory = new Map<BlindCheckCategory, { total: number; high: number }>();
    for (const issue of issues) {
      summary[issue.severity] += issue.count;
      summary.total += issue.count;
      const entry = byCategory.get(issue.category) || { total: 0, high: 0 };
      entry.total += issue.count;
      if (issue.severity === 'high') entry.high += issue.count;
      byCategory.set(issue.category, entry);
    }
    return { summary, byCategory };
  }, [issues]);

  const canGoNext = Boolean(file);
  const nextTooltip = canGoNext ? `进入${stepLabels[steps[activeIndex + 1]]}` : '请先选择需要检查的投标文件';

  const toolbarGroups: FloatingToolbarGroup[] = [
    {
      id: 'blind-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          tooltip: '清空待检文档和检查结果，保留格式预设',
          onClick: () => { void resetAll(); },
        },
        {
          id: 'home',
          label: '首页',
          variant: step === 'upload' ? 'primary' : 'secondary',
          tooltip: '回到选择标书',
          onClick: () => setStep('upload'),
        },
      ],
    },
    {
      id: 'blind-check-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        // 最后一步把「下一步」换成导出，与投标文件最后一步的「导出 Word」一致。
        step === 'fix' ? {
          id: 'export-fixed-document',
          label: savingFixed ? '导出中...' : '导出修复结果',
          icon: <ToolbarDocumentIcon />,
          variant: 'primary' as const,
          disabled: savingFixed || !hasFixedDocument,
          tooltip: isFixRunning
            ? '请等待修复完成后再导出'
            : hasFixedDocument
              ? '把修复后的文档导出为 Word，原文件不会被覆盖'
              : '还没有当前文件和预设对应的修复结果',
          onClick: () => { void saveFixedDocument(); },
        } : {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary' as const,
          disabled: !canGoNext,
          tooltip: nextTooltip,
          onClick: () => goToOffset(1),
        },
      ],
    },
  ];

  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((item) => window.yibiao.file.getPathForFile(item) || '').filter(Boolean);

  const renderUploadStep = () => (
    <>
      <UploadBoard
        kicker="STEP 01"
        title="选择标书"
        aside={(
          <div className="duplicate-upload-summary">
            <span>{file ? '已选择待检文档' : '未选择文档'}</span>
            <strong>{file ? file.fileName : '仅支持 .docx'}</strong>
            <small>{file ? formatFileSize(file.size) : '单个文件'}</small>
          </div>
        )}
      >
        <UploadRow
          index="01"
          title="投标文件"
          note="必选，仅 .docx"
          onDropFiles={(files) => {
            const paths = resolveDroppedFilePaths(files);
            if (paths.length) void chooseFile(paths.slice(0, 1));
          }}
          dropDisabled={busy !== null}
          actions={(
            <button type="button" className="primary-action" onClick={() => void chooseFile()} disabled={busy !== null}>
              {busy === 'file' ? '处理中...' : file ? '更换' : '上传'}
            </button>
          )}
        >
          {file ? (
            <div className="duplicate-file-list">
              <UploadFilePill
                badge="DOCX"
                name={file.fileName}
                meta={`${formatFileSize(file.size)} · ${formatDate(file.modifiedAt)}`}
                onRemove={() => void removeFile()}
                removeDisabled={busy !== null}
                removeAriaLabel={`移除 ${file.fileName}`}
              />
            </div>
          ) : (
            <UploadEmpty title="等待投标文件" hint="选择需要按暗标要求检查的技术标 .docx 文件。">
              <button type="button" className="text-button" onClick={() => void chooseFile()} disabled={busy !== null}>选择投标文件</button>
            </UploadEmpty>
          )}
        </UploadRow>
      </UploadBoard>

      <section className="duplicate-guide-panel">
        <ul className="duplicate-guide-list">
          {guideItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </>
  );

  const renderPresetStep = () => {
    if (!activePreset) {
      return <div className="markdown-empty-state rejection-finding-empty"><strong>正在读取格式预设</strong></div>;
    }
    const builtinPresets = presets.filter((preset) => preset.builtin);
    const userPresets = presets.filter((preset) => !preset.builtin);
    // AI 提取说明页签只在 AI 生成的预设上出现；切到其他预设时回到页面页签。
    const visiblePresetTabs = presetTabs.filter((tab) => tab.id !== 'source' || activePreset.source);
    const shownPresetTab = presetTab === 'source' && !activePreset.source ? 'page' : presetTab;
    return (
      <>
        <StepHeader kicker="STEP 02" title="格式要求">
          <div className="blind-check-preset-picker">
            <span className="blind-check-preset-picker-label">当前预设</span>
            <select aria-label="当前预设" value={activePreset.id} onChange={(event) => void selectPreset(event.target.value)} disabled={busy !== null || isExtracting}>
              <optgroup label="内置预设">
                {builtinPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
              </optgroup>
              {userPresets.length > 0 && (
                <optgroup label="我的预设">
                  {userPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
                </optgroup>
              )}
            </select>
            {activePreset.builtin ? (
              <span className="blind-check-preset-badge">内置</span>
            ) : (
              <span className="blind-check-preset-picker-tools">
                <button type="button" title="重命名" aria-label="重命名" disabled={busy !== null || isExtracting} onClick={() => setPresetDialog({ mode: 'rename', name: activePreset.name })}>
                  <Pencil1Icon />
                </button>
                <button type="button" className="is-danger" title="删除" aria-label="删除" disabled={busy !== null || isExtracting} onClick={() => setDeleteOpen(true)}>
                  <TrashIcon />
                </button>
              </span>
            )}
          </div>
          <button type="button" className="secondary-action" disabled={busy !== null || isExtracting} onClick={() => setPresetDialog({ mode: 'create', name: `${activePreset.name.replace(/（参考）$/, '')} 副本` })}>
            <CopyIcon />
            复制为我的预设
          </button>
          <button type="button" className="primary-action" disabled={busy !== null || isExtracting} onClick={() => void openSourceDialog()}>
            <MagicWandIcon />
            {isExtracting ? '提取中...' : '从招标文件生成'}
          </button>
        </StepHeader>

        <StepTabs
          label="格式要求分类"
          panelId="blind-check-preset-panel"
          active={shownPresetTab}
          onSelect={setPresetTab}
          tabs={visiblePresetTabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            summary: presetTabSummary(tab.id, activePreset.profile, activePreset.source),
            warning: presetTabPending(tab.id, activePreset.profile, activePreset.source) > 0,
          }))}
        />

        <section className="blind-check-step-panel" role="tabpanel" id="blind-check-preset-panel" aria-labelledby={`blind-check-preset-panel-tab-${shownPresetTab}`}>
          {isExtracting && (
            <div className="blind-check-running blind-check-extraction-progress">
              <span className="section-kicker">从招标文件生成预设</span>
              <p>{extractionTask?.logs?.at(-1) || '正在准备读取招标文件。'}</p>
              <ProgressBar value={Math.max(0, Math.min(100, extractionTask?.progress ?? 0))} active label={`格式要求提取进度 ${extractionTask?.progress ?? 0}%`} />
              {extractionElapsedText && (
                <div className="outline-progress-meta">
                  <span>{extractionElapsedText}</span>
                </div>
              )}
              {extractionSlow && (
                <p className="blind-check-extraction-slow">已超过 3 分钟没有新进展，可能是模型服务或文件解析响应较慢，程序仍在等待；AI 请求单次超过 10 分钟会自动重试。</p>
              )}
            </div>
          )}
          {!isExtracting && extractionTask?.status === 'error' && dismissedExtractionError !== extractionTask.task_id && (
            <div className="blind-check-rule-errors">
              <strong>从招标文件提取格式要求失败</strong>
              <pre className="blind-check-error">{extractionTask.error || '提取失败，请重试。'}</pre>
              <button type="button" className="text-button" onClick={() => setDismissedExtractionError(extractionTask.task_id)}>知道了</button>
            </div>
          )}
          {activePreset.builtin && (
            <div className="blind-check-readonly-note">当前为内置参考预设。直接修改会自动复制为"我的预设"，内置预设保持不变；也可点「从招标文件生成」由 AI 按招标文件生成。</div>
          )}
          {shownPresetTab === 'source' && activePreset.source ? (
            <ExtractionNotice source={activePreset.source} profile={activePreset.profile} />
          ) : (
            <PresetEditor
              tab={shownPresetTab}
              profile={activePreset.profile}
              readOnly={isExtracting || busy === 'preset'}
              onCommit={(profile) => void savePresetProfile(profile)}
              credential={{ enabled: useCredentialWords, words: credentialWords, busy: busy === 'credential', onToggle: (enabled) => void toggleCredentialWords(enabled) }}
              source={activePreset.source}
            />
          )}
        </section>
      </>
    );
  };

  const renderResultContent = () => {
    if (!file) {
      return (
        <div className="markdown-empty-state rejection-finding-empty">
          <strong>还没有待检文档</strong>
          <p>请先在第一步选择需要检查的投标文件。</p>
        </div>
      );
    }
    // 复核期间只显示进度，复核完成后一次性给出最终结果，避免数字中途变化。
    if (isRunning || isReviewing) {
      const progress = Math.max(0, Math.min(100, checkTask?.progress ?? 0));
      return (
        <div className="blind-check-running">
          <span className="section-kicker">暗标合规检查</span>
          <h3>{isReviewing ? '正在 AI 复核' : '正在检查文档'}</h3>
          <p>{checkTask?.logs?.at(-1) || '正在准备检查。'}</p>
          {isReviewing
            ? <ProgressBar value={50} active label="AI 复核进行中" />
            : <ProgressBar value={progress} label={`暗标合规检查进度 ${progress}%`} />}
        </div>
      );
    }
    if (result.status === 'error') {
      return (
        <div className="markdown-empty-state rejection-finding-empty is-error">
          <strong>检查失败</strong>
          <pre className="blind-check-error">{result.error || '暗标合规检查失败，请重新检查。'}</pre>
        </div>
      );
    }
    if (result.status !== 'success') {
      return (
        <div className="markdown-empty-state rejection-finding-empty">
          <strong>等待检查</strong>
          <p>点「开始检查」，选择仅程序检查或程序检查 + AI 复核。</p>
        </div>
      );
    }
    const visibleIssues = resultTab === 'all' ? issues : issues.filter((issue) => issue.category === resultTab);
    return (
      <>
        {!!result.ruleErrors?.length && (
          <div className="blind-check-rule-errors">
            <strong>{`有 ${result.ruleErrors.length} 条规则执行出错，其余规则结果不受影响：`}</strong>
            <ul>{result.ruleErrors.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
        {resultTab === 'all' && (
          <div className="blind-check-summary-cards">
            {severities.map((severity) => (
              <article className={`is-${severity}`} key={severity}>
                <span>{severityLabels[severity]}</span>
                <strong>{issueStats.summary[severity]}<small>处</small></strong>
              </article>
            ))}
          </div>
        )}
        {visibleIssues.length ? (
          <FindingGroupList issues={visibleIssues} key={resultTab} />
        ) : (
          <div className="markdown-empty-state rejection-finding-empty">
            <strong>{resultTab === 'all' ? '未发现问题' : `「${categoryLabels[resultTab]}」未发现问题`}</strong>
            <p>{resultTab === 'all' ? '当前格式预设下没有检查出问题。' : '可切换到其他类别查看。'}</p>
          </div>
        )}
      </>
    );
  };

  const renderResultStep = () => {
    const stale = !isRunning && result.status === 'success' && currentSignature !== null && result.inputSignature !== currentSignature;
    const hasCurrentResult = result.status !== 'idle' && !stale;
    const showTabs = !isRunning && !isReviewing && result.status === 'success';
    // 复核失败时以程序检查结果为最终结果。
    const reviewFailed = showTabs && review.status === 'error' && review.inputSignature === result.inputSignature;
    const summary = issueStats.summary;
    // 没有问题的类别不显示；当前选中的类别保留，避免重新检查后页签消失。
    const tabs: StepTab<BlindCheckResultTab>[] = showTabs
      ? [
        { id: 'all', label: '全部', summary: summary.total ? `高 ${summary.high} · 中 ${summary.medium} · 低 ${summary.low}` : '未发现问题' },
        ...categoryTabs
          .filter((tab) => tab === resultTab || (issueStats.byCategory.get(tab)?.total || 0) > 0)
          .map((tab) => {
            const count = issueStats.byCategory.get(tab);
            return { id: tab, label: categoryLabels[tab], summary: `${count?.total || 0} 处${count?.high ? ` · 高 ${count.high}` : ''}` };
          }),
      ]
      : [];
    return (
      <>
        <StepHeader kicker="STEP 03" title="检查结果">
          <button type="button" className={hasCurrentResult ? 'secondary-action' : 'primary-action'} onClick={() => setCheckDialogOpen(true)} disabled={!file || isCheckBusy || isFixRunning}>
            <ReloadIcon />
            {isRunning ? '检查中...' : isReviewing ? 'AI 复核中...' : hasCurrentResult ? '重新检查' : '开始检查'}
          </button>
        </StepHeader>

        {showTabs && <StepTabs label="检查结果分类" panelId="blind-check-result-panel" active={resultTab} onSelect={setResultTab} tabs={tabs} />}

        <section className="blind-check-step-panel" role={showTabs ? 'tabpanel' : undefined} id="blind-check-result-panel" aria-labelledby={showTabs ? `blind-check-result-panel-tab-${resultTab}` : undefined}>
          {stale && (
            <p className="blind-check-result-note is-warning">文档、格式预设或敏感词已变化，当前结果不是最新的，请点「重新检查」。</p>
          )}
          {reviewFailed && (
            <p className="blind-check-result-note is-warning">{`AI 复核失败：${review.error || '未知原因'}。当前为程序检查结果。`}</p>
          )}
          {activePreset?.builtin && (
            <p className="blind-check-result-note">
              {`当前使用内置参考预设「${activePreset.name}」，检查标准不一定符合本项目招标文件。`}
              <button type="button" className="text-button" onClick={() => setStep('preset')}>按招标文件生成预设</button>
            </p>
          )}
          {renderResultContent()}
        </section>
      </>
    );
  };

  return (
    <div className={`blind-check-page is-${step}`}>
      {step === 'upload'
        ? renderUploadStep()
        : step === 'preset'
          ? renderPresetStep()
          : step === 'fix'
            ? (
              <FixPanel
                fixRules={fixRules}
                currentCounts={currentRuleCounts}
                fixResult={fixResult}
                fixTask={fixTask}
                running={isFixRunning}
                checkReady={checkReady}
                stale={fixStale}
                busy={isCheckBusy}
                reviewReady={reviewReady}
                onToggle={(ruleId, enabled) => void toggleFixRule(ruleId, enabled)}
                onStart={() => setFixDialogOpen(true)}
              />
            )
            : renderResultStep()}

      <AppDialog
        open={checkDialogOpen}
        onOpenChange={setCheckDialogOpen}
        kicker="暗标合规检查"
        title="选择检查方式"
        actions={<button type="button" className="secondary-action" onClick={() => setCheckDialogOpen(false)}>取消</button>}
      >
        {/* 点选项直接开始检查；上次的选择用描边标出。 */}
        <OptionCardList
          aria-label="检查方式"
          options={[
            { value: 'program', title: '仅程序检查', icon: <ListBulletIcon /> },
            { value: 'ai', title: '程序检查 + AI 复核', description: 'AI 复核需要约 5-10 分钟', icon: <MagicWandIcon /> },
          ]}
          highlightedValue={aiReviewEnabled ? 'ai' : 'program'}
          highlightLabel="上次选择"
          onSelect={(value) => startCheck(value === 'ai')}
        />
      </AppDialog>

      <AppDialog
        open={fixDialogOpen}
        onOpenChange={setFixDialogOpen}
        kicker="暗标自动修复"
        title="选择修复方式"
        actions={<button type="button" className="secondary-action" onClick={() => setFixDialogOpen(false)}>取消</button>}
      >
        {/* 点选项直接开始修复；不可选的写明原因，可选时上次的选择用描边标出。 */}
        <OptionCardList
          aria-label="修复方式"
          options={[
            { value: 'program', title: '仅程序修复', description: fixRules.length ? undefined : '还没有勾选修复项', disabled: !fixRules.length, icon: <Pencil1Icon /> },
            { value: 'ai', title: '程序修复 + AI 修复', description: reviewReady ? undefined : '本次检查没有 AI 复核，需重新检查并选择「程序检查 + AI 复核」', disabled: !reviewReady, icon: <MagicWandIcon /> },
          ]}
          highlightedValue={reviewReady && (fixAiEnabled || !fixRules.length) ? 'ai' : 'program'}
          // 有一项不可选时标出的是唯一可选项，不是上次的选择。
          highlightLabel={fixRules.length && reviewReady ? '上次选择' : undefined}
          onSelect={(value) => startFix(value === 'ai')}
        />
      </AppDialog>

      <AppDialog
        open={Boolean(presetDialog)}
        onOpenChange={(open) => !open && setPresetDialog(null)}
        kicker="格式预设"
        title={presetDialog?.mode === 'rename' ? '重命名预设' : '复制为我的预设'}
        description={presetDialog?.mode === 'rename' ? undefined : `以「${activePreset?.name || ''}」为底稿创建，可按招标文件调整。`}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setPresetDialog(null)} disabled={busy === 'preset'}>取消</button>
            <button type="button" className="primary-action" onClick={() => void submitPresetDialog()} disabled={busy === 'preset'}>
              {busy === 'preset' ? '保存中...' : '确定'}
            </button>
          </>
        )}
      >
        <label className="blind-check-name-field">
          <span>预设名称</span>
          <input
            value={presetDialog?.name || ''}
            maxLength={MAX_PRESET_NAME_LENGTH}
            autoFocus
            placeholder="例如：某某项目暗标要求"
            onChange={(event) => setPresetDialog((current) => (current ? { ...current, name: event.target.value } : current))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitPresetDialog();
            }}
          />
        </label>
      </AppDialog>

      <AppDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        kicker="格式预设"
        title="删除预设"
        description={`删除「${activePreset?.name || ''}」后不可恢复，当前选择将切换为通用预设。`}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setDeleteOpen(false)} disabled={busy === 'preset'}>取消</button>
            <button type="button" className="danger-action" onClick={() => void deletePreset()} disabled={busy === 'preset'}>删除</button>
          </>
        )}
      />

      <AppDialog
        open={Boolean(savedFixedPath)}
        onOpenChange={(open) => !open && setSavedFixedPath('')}
        kicker="导出完成"
        title="修复结果已导出"
        description={savedFixedPath ? `文件已导出到：${savedFixedPath}。请在 Word / WPS 中核对版面。` : undefined}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setSavedFixedPath('')}>稍后打开</button>
            <button type="button" className="primary-action" onClick={() => { void openSavedDocument(); }}>打开文件</button>
          </>
        )}
      />

      <AppDialog
        open={sourceDialogOpen}
        onOpenChange={setSourceDialogOpen}
        kicker="格式预设"
        title="从招标文件生成预设"
        description="AI 读取招标文件里的排版要求，生成一份新的「我的预设」。请选择招标文件来源："
        actions={<button type="button" className="secondary-action" onClick={() => setSourceDialogOpen(false)}>取消</button>}
      >
        <div className="blind-check-source-options">
          <button
            type="button"
            className="blind-check-source-option"
            disabled={!tenderSources?.technicalPlan.available}
            onClick={() => void startExtraction('technical-plan')}
          >
            <span className="blind-check-source-icon"><FileTextIcon /></span>
            <span className="blind-check-source-text">
              <strong>使用技术方案中的招标文件</strong>
              <small title={tenderSources?.technicalPlan.fileName || undefined}>{tenderSources?.technicalPlan.available ? tenderSources.technicalPlan.fileName : '技术方案中还没有上传招标文件'}</small>
            </span>
            <ChevronRightIcon className="blind-check-source-arrow" />
          </button>
          <button type="button" className="blind-check-source-option" onClick={() => void startExtraction('file')}>
            <span className="blind-check-source-icon"><UploadIcon /></span>
            <span className="blind-check-source-text">
              <strong>选择本地招标文件</strong>
              <small>支持 PDF、Word</small>
            </span>
            <ChevronRightIcon className="blind-check-source-arrow" />
          </button>
        </div>
      </AppDialog>

      <FloatingToolbar groups={toolbarGroups} label="暗标合规检查工具条" />
    </div>
  );
}
