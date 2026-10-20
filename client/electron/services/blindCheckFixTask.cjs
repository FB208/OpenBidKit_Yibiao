const fs = require('node:fs');
const path = require('node:path');
const { collectImageColorFacts, writeGrayscaleCopy } = require('./blindCheckImageColor.cjs');
const { agentActivityText, canResumeReviewAgent, runBlindCheckFixAgent } = require('./blindCheckAgent.cjs');
const { FIX_RULE_IDS } = require('./blindCheckPresets.cjs');
const { buildFixItems, buildIssueList, fixScope, issueSummary, newProblemGroups, pendingSummary, reviewForResult } = require('./blindCheckReview.cjs');
const { mapReport } = require('./blindCheckTask.cjs');

const FIXABLE_RULES = new Set(FIX_RULE_IDS);

function now() {
  return new Date().toISOString();
}

function mapFixReport(report) {
  const after = mapReport(report?.after);
  const validation = report?.validation || {};
  return {
    sourceBytes: Number(report?.source_bytes || 0),
    outputBytes: Number(report?.output_bytes || 0),
    fixes: report?.fixes || {},
    notes: Array.isArray(report?.notes) ? report.notes.map(String) : [],
    // 删除了原文赖以认标题的目录时为 false：之后复查、导出结构和编辑修复副本都要沿用，标题认法才与检查时一致。
    headingFallback: report?.heading_fallback !== false,
    validation: {
      checked: Boolean(validation.checked),
      skippedReason: String(validation.skipped_reason || ''),
      originalErrors: Number(validation.original_errors || 0),
      fixedErrors: Number(validation.fixed_errors || 0),
    },
    afterSummary: after.summary,
    afterStats: after.stats,
    groups: after.groups,
  };
}

/** 修复阶段能否续接 AI 复核会话：选择了 AI 修复，且当前检查条件的复核已成功、会话还在。 */
function reviewForFix(state, input, agentService, ai) {
  if (!ai) return { review: null, reason: '本次选择仅程序修复' };
  const review = state.review;
  if (review?.status !== 'success' || review.inputSignature !== input.signature || !review.review) {
    return { review: null, reason: review?.status === 'error' ? 'AI 复核失败，本次只做了程序修复' : 'AI 复核尚未完成，本次只做了程序修复' };
  }
  if (!canResumeReviewAgent(agentService, input.signature)) return { review: null, reason: 'AI 复核会话已失效，请重新检查后再修复' };
  return { review: review.review, reason: '' };
}

/**
 * 暗标自动修复任务：只修复与当前检查条件一致的成功结果对应的文档。
 * 修复范围取自最终问题清单（复核后的检查结论）：开着的修复项覆盖的问题，选了 AI 修复时再加上没有修复项覆盖的问题。
 * 助手在工作区写出副本、校验并复查，原文件不改动；选了 AI 修复时续接复核会话处理程序修不了的问题，
 * 最后只对修复范围逐条对账。进度只推送不落库，完成时一次提交。
 */
async function runBlindCheckFixTask({ agentService, aiService, workspaceStore, openXmlHelperService, updateTask, checkpointTask, payload, taskControl }) {
  const input = workspaceStore.prepareFixInput();
  if (!input.source || !input.signature) throw new Error('请先选择要检查的投标文件');
  const state = workspaceStore.loadBlindCheck();
  const checkResult = state.result;
  if (checkResult.status !== 'success' || checkResult.inputSignature !== input.signature) {
    throw new Error('请先完成当前文件和格式预设的检查，再进行修复');
  }
  if (state.review?.status === 'running') throw new Error('AI 复核还在进行，请等复核完成后再修复');
  // 启动前用户在弹窗里选择仅程序修复或程序修复 + AI 修复，记下来作为下次的默认选项。
  const ai = payload?.ai === true;
  workspaceStore.setFixAiEnabled(ai);
  // 问题清单按检查结论（复核后的结果），与本次是否选 AI 修复无关；续用复核会话只在选了 AI 修复且会话还在时。
  const checkReview = reviewForResult(checkResult, state.review);
  const scope = fixScope(buildIssueList(checkResult.groups, checkReview), { fixRules: input.fixRules, fixableRules: FIXABLE_RULES, ai });
  const beforeSummary = issueSummary(scope);
  const { review, reason } = reviewForFix(state, input, agentService, ai);

  const logs = [`开始修复「${input.fileName}」，本次修复范围共 ${beforeSummary.total} 处问题。`];
  const runningResult = {
    status: 'running',
    inputSignature: input.signature,
    fixRules: input.fixRules,
    output: input.output,
    // 修复前是修复范围的处数，修复后是待人工处理的处数（含修复后新出现的）。
    beforeSummary,
    error: null,
    groups: [],
    items: [],
    agent: null,
    updatedAt: now(),
  };
  const { task } = checkpointTask({ status: 'running', progress: 1, logs }, { fixResult: runningResult });

  // 彩色图片转灰度要解码像素，助手不做：先在修复副本旁写出灰度副本作为助手的修复源，修复结束后删除。
  const graySource = input.output.replace(/\.docx$/i, '.gray.docx');
  const grayPath = input.outputPath.replace(/\.docx$/i, '.gray.docx');
  try {
    // 复查时彩色图片规则需要 Main 的像素抽样结论，与检查任务一致；转过灰度的图片按非彩色复查。
    let imageFacts = input.profile.image.check_color ? await collectImageColorFacts(input.sourcePath, { signal: taskControl.signal }) : [];
    const colorParts = input.fixRules.includes('image.color') ? imageFacts.filter((fact) => fact.color).map((fact) => fact.part) : [];
    let grayParts = [];
    if (colorParts.length) {
      updateTask({ status: 'running', progress: 1, logs: [...logs, `正在把 ${colorParts.length} 张彩色图片转为灰度`] });
      grayParts = await writeGrayscaleCopy(input.sourcePath, grayPath, colorParts, { signal: taskControl.signal });
      imageFacts = imageFacts.map((fact) => (grayParts.includes(fact.part) ? { ...fact, color: false, color_ratio: 0 } : fact));
    }
    // 没有勾选任何修复项时跳过程序修复，直接从原文件复制一份副本交给 AI 处理和对账。
    let mapped;
    if (input.fixRules.length) {
      const report = await openXmlHelperService.runBlindCheckFix({
        source: grayParts.length ? graySource : input.source,
        output: input.output,
        profile: input.profile,
        sensitive_words: input.sensitiveWords,
        image_facts: imageFacts,
        fix_rules: input.fixRules,
      }, {
        signal: taskControl.signal,
        onProgress: ({ frac, label }) => {
          updateTask({ status: 'running', progress: Math.max(1, Math.min(60, Math.round(frac * 60))), logs: [...logs, label] });
        },
      });
      mapped = mapFixReport(report);
    } else {
      // 副本目录平时由助手写出副本时创建，首次使用或重置后还不存在。
      fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
      fs.copyFileSync(input.sourcePath, input.outputPath);
      const after = mapReport(await openXmlHelperService.runBlindCheck({
        source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: imageFacts,
      }, { signal: taskControl.signal }));
      mapped = {
        sourceBytes: fs.statSync(input.sourcePath).size, outputBytes: fs.statSync(input.outputPath).size, fixes: {}, notes: [], headingFallback: true,
        validation: { checked: false, skippedReason: '没有勾选程序修复项', originalErrors: 0, fixedErrors: 0 },
        afterSummary: after.summary, afterStats: after.stats, groups: after.groups,
      };
    }
    if (grayParts.length) {
      mapped.fixes = { ...mapped.fixes, 'image.color': grayParts.length };
      // 助手的修复源是灰度副本，文件大小按原文件计。
      mapped.sourceBytes = fs.statSync(input.sourcePath).size;
    }
    const changed = Object.values(mapped.fixes).reduce((sum, value) => sum + Number(value || 0), 0);
    logs.push(`程序修复完成：共修改 ${changed} 处。`);

    let agent = { status: 'skipped', reason, summary: '', edits: [] };
    let finalGroups = mapped.groups;
    let finalStats = mapped.afterStats;
    let finalDump = null;
    let reviewImages = [];
    let dispositions = new Map();
    let refreshedClauses = [];
    if (review) {
      const agentLogs = [...logs, 'AI 正在处理程序修不了的问题，通常需要几分钟。'];
      updateTask({ status: 'running', progress: 65, logs: agentLogs });
      try {
        const fixedDump = await openXmlHelperService.runBlindCheckDump({
          source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: [], heading_fallback: mapped.headingFallback,
        }, { signal: taskControl.signal });
        const result = await runBlindCheckFixAgent({
          agentService,
          aiService,
          openXmlHelperService,
          input,
          checkGroups: checkResult.groups,
          review,
          afterGroups: mapped.groups,
          fixedDump,
          fixedSource: input.output,
          headingFallback: mapped.headingFallback,
          imageFacts,
          mapReport,
          fixableRules: FIXABLE_RULES,
          taskId: task.task_id,
          signal: taskControl.signal,
          onActivity(event) {
            const text = agentActivityText(event, '处理结果');
            if (text) updateTask({ status: 'running', progress: 65, logs: [...agentLogs, text] });
          },
        });
        if (result.skipped) {
          agent = { status: 'skipped', reason: result.reason, summary: '', edits: [] };
        } else {
          agent = { status: 'success', reason: '', summary: result.disposition.summary, edits: result.edits };
          dispositions = new Map(result.disposition.items.map((item) => [item.id, item]));
          finalGroups = result.finalReport.groups;
          finalStats = result.finalReport.stats;
          finalDump = result.finalDump;
          reviewImages = result.reviewImages;
          refreshedClauses = result.disposition.clauses;
        }
      } catch (error) {
        if (taskControl.signal.aborted) throw error;
        // AI 修复失败时副本可能已有部分修改：重新复查并读取副本正文，程序问题和 AI 补充的问题都按实际状态对账，失败前的修改照常记录。
        const final = mapReport(await openXmlHelperService.runBlindCheck({
          source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: imageFacts, heading_fallback: mapped.headingFallback,
        }, { signal: taskControl.signal }));
        finalGroups = final.groups;
        finalStats = final.stats;
        finalDump = await openXmlHelperService.runBlindCheckDump({
          source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: [], heading_fallback: mapped.headingFallback,
        }, { signal: taskControl.signal });
        reviewImages = error?.partial?.reviewImages || [];
        agent = { status: 'error', reason: '', error: error?.message || 'AI 修复失败', summary: '', edits: error?.partial?.edits || [] };
      }
    }

    // 选了 AI 修复却没能完成（失败或会话失效）时，原本交给 AI 的问题在待人工的原因里写明。
    const unavailable = ai ? (agent.status === 'error' ? agent.error : agent.status === 'skipped' ? agent.reason : '') : '';
    const items = buildFixItems({
      scope,
      checkGroups: checkResult.groups,
      review: checkReview,
      finalGroups,
      newGroups: newProblemGroups(checkResult.groups, finalGroups),
      dispositions,
      edits: agent.edits,
      refreshedClauses,
      unavailable,
      finalDumpText: finalDump?.text,
      reviewImages,
      finalImages: finalDump?.images,
    });
    const afterSummary = pendingSummary(items);
    const fixedCount = items.reduce((sum, item) => sum + item.fixed, 0);
    const summary = `修复完成：已修复 ${fixedCount} 处，待人工处理 ${afterSummary.total} 处${unavailable ? `（自动修复未完成：${unavailable}）` : ''}。`;
    checkpointTask(
      { status: 'success', progress: 100, logs: [...logs, ...(agent.summary ? [`AI 处理：${agent.summary}`] : []), summary], error: undefined },
      // outputPath 只用于推送给页面打开副本；落库时按工作区相对路径保存，读取时再拼成绝对路径。
      {
        fixResult: {
          ...runningResult,
          ...mapped,
          afterSummary,
          afterStats: finalStats,
          groups: finalGroups,
          items,
          agent,
          outputBytes: fs.statSync(input.outputPath).size,
          outputPath: input.outputPath,
          status: 'success',
          updatedAt: now(),
        },
      },
    );
    workspaceStore.removeStaleFixedFiles();
  } catch (error) {
    if (taskControl.signal.aborted) throw error;
    const message = error?.message || '暗标自动修复失败';
    checkpointTask(
      { status: 'error', progress: 100, logs: [...logs, '修复失败。'], error: message },
      { fixResult: { ...runningResult, status: 'error', error: message, updatedAt: now() } },
    );
  } finally {
    fs.rmSync(grayPath, { force: true });
  }
}

module.exports = {
  runBlindCheckFixTask,
};
