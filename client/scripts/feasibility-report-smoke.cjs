const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { createSqliteDatabase, schemaVersion } = require('../electron/services/sqliteDatabase.cjs');
const { createFeasibilityReportStore } = require('../electron/services/feasibilityReportStore.cjs');
const {
  runFeasibilityAnalysisTask,
  runFeasibilityOutlineTask,
  runFeasibilityParametersTask,
  runFeasibilityContentTask,
  runFeasibilityHumanWritingTask,
} = require('../electron/services/feasibilityReportTasks.cjs');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-feasibility-smoke-'));
app.setPath('userData', tempUserData);

async function run() {
  let database;
  try {
    database = createSqliteDatabase(app);
    assert.equal(database.db.pragma('user_version', { simple: true }), schemaVersion);
    const tables = new Set(database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.ok(tables.has('technical_plan_meta'));
    assert.ok(tables.has('feasibility_report_meta'));
    assert.ok(tables.has('feasibility_report_tasks'));

    const fileService = {
      async importTechnicalPlanDocument() {
        return {
          success: true,
          message: '已导入测试项目资料',
          file_content: '项目拟建设一套业务管理系统，建设期 2 年，由测试单位负责实施。',
          file_name: '测试项目资料.md',
          parser_label: '冒烟测试解析器',
        };
      },
    };
    const store = createFeasibilityReportStore({ app, db: database.db, fileService });
    store.saveProjectInfo({
      projectName: '可研冒烟测试项目',
      projectType: 'government',
      industry: '信息化',
      constructionLocation: '测试地点',
      constructionScale: '建设测试系统一套',
      constructionPeriod: 2,
      operationPeriod: 10,
      totalInvestment: '1000 万元',
      fundingSource: '财政资金',
      projectUnit: '测试单位',
    });
    await store.importSourceDocuments();

    let jsonCall = 0;
    let chatCall = 0;
    const aiService = {
      getConfig() { return { contextWindow: 128000 }; },
      async collectJsonResponse() {
        jsonCall += 1;
        if (jsonCall === 1) {
          return {
            project_overview: '项目拟建设一套业务管理系统，建设期 2 年。',
            construction_and_technical_conditions: '由测试单位负责实施。',
            missing_information: '- 【待补充】投资构成明细',
          };
        }
        return {
          outline: [{
            title: '概述',
            description: '说明项目总体情况',
            children: [{ title: '项目概况', description: '说明项目建设内容与实施安排', knowledge_item_ids: [] }],
          }],
        };
      },
      async chat() {
        chatCall += 1;
        if (chatCall === 1) return '## 建设期\n\n- 2 年\n\n## 投资与资金来源\n\n- 【待补充】投资构成明细';
        if (chatCall === 2) return '需要指出的是，项目拟建设一套业务管理系统。项目建设期为 2 年，由测试单位负责实施。投资构成明细【待补充】。';
        return '项目拟建设一套业务管理系统，建设期为 2 年，由测试单位负责实施。投资构成明细【待补充】。';
      },
    };
    const knowledgeBaseService = {
      getOutlineReferences() { return { items: [] }; },
      readItems() { return []; },
    };
    const updateTask = () => {};
    await runFeasibilityAnalysisTask({ aiService, workspaceStore: store, updateTask });
    await runFeasibilityOutlineTask({ aiService, workspaceStore: store, knowledgeBaseService, updateTask, payload: {} });
    await runFeasibilityParametersTask({ aiService, workspaceStore: store, knowledgeBaseService, updateTask });
    await runFeasibilityContentTask({ aiService, workspaceStore: store, knowledgeBaseService, updateTask });
    await runFeasibilityHumanWritingTask({ aiService, workspaceStore: store, updateTask });
    const humanizedState = store.loadFeasibilityReport();
    const protectedContent = humanizedState.outlineData.outline[0].children[0].content;
    await runFeasibilityHumanWritingTask({
      aiService: { async chat() { return '项目拟建设一套业务管理系统，由测试单位负责实施。'; } },
      workspaceStore: store,
      updateTask,
    });
    const state = store.loadFeasibilityReport();
    assert.equal(state.projectInfo.projectName, '可研冒烟测试项目');
    assert.match(state.analysisMarkdown, /项目拟建设一套业务管理系统/);
    assert.match(state.keyParametersMarkdown, /【待补充】投资构成明细/);
    assert.match(state.outlineData.outline[0].children[0].content, /建设期为 2 年/);
    assert.equal(jsonCall, 2);
    assert.doesNotMatch(state.outlineData.outline[0].children[0].content, /需要指出的是/);
    assert.equal(state.outlineData.outline[0].children[0].content, protectedContent);
    assert.equal(chatCall, 3);
    const { runFeasibilityValidationCheck, runFeasibilityConsistencyCheck, syncFinancialsToOutlineAndContent } = require('../electron/services/feasibilityReportTasks.cjs');
    const { calculateFinancials } = require('../electron/services/financialCalculator.cjs');
    const { buildDocxBuffer } = require('../electron/services/exportService.cjs');

    const calculatedFin = calculateFinancials(null, null, state.projectInfo);
    assert.ok(calculatedFin.evaluation.npv !== undefined);
    assert.ok(calculatedFin.evaluation.irr > 0);
    assert.equal(calculatedFin.evaluation.sensitivity.length, 5);

    const syncedState = syncFinancialsToOutlineAndContent(store);
    assert.ok(syncedState.financialData);
    assert.match(syncedState.projectInfo.totalInvestment, /万元/);

    const validationReport = runFeasibilityValidationCheck(state);
    assert.ok(validationReport.score >= 0 && validationReport.score <= 100);
    assert.ok(Array.isArray(validationReport.missingParameters));
    assert.ok(Array.isArray(validationReport.missingMaterials));

    const consistencyReport = runFeasibilityConsistencyCheck(state);
    assert.ok(typeof consistencyReport.totalCheckedNodes === 'number');
    assert.ok(Array.isArray(consistencyReport.issues));

    const docxBuffer = await buildDocxBuffer({
      project_name: state.projectInfo.projectName,
      outline: state.outlineData.outline,
      is_feasibility: true,
      project_info: state.projectInfo,
      financial_data: syncedState.financialData,
      feasibility_options: {
        includeCover: true,
        includePreparationNotes: true,
        includeAppendixTables: true,
        preparationUnit: '测试编制单位',
        documentCode: 'KYBG-TEST-001',
      },
    });
    assert.ok(docxBuffer instanceof Buffer && docxBuffer.length > 500);

    console.log(`[feasibility-smoke] schema=v20, isolated store, 5-step task flow, and Word export passed.`);
    database.close();
    database = null;
    fs.rmSync(tempUserData, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error('[feasibility-smoke] failed');
    console.error(error?.stack || error?.message || String(error));
    database?.close();
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    app.exit(1);
  }
}

app.whenReady().then(run, (error) => {
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
