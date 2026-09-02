const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { createCheckResultExportService, __test__ } = require('./checkResultExportService.cjs');

function roundTripWorkbook(workbook) {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return XLSX.read(buffer, { type: 'buffer', cellNF: true });
}

function sheetRows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
}

function createRejectionState() {
  return {
    bidDocuments: [
      { id: 'bid-a', fileName: '甲公司投标文件.docx' },
      { id: 'bid-b', fileName: '乙公司投标文件.docx' },
    ],
    rejectionCheckResult: {
      status: 'success',
      inputSignature: 'rejection-current',
      updatedAt: '2026-08-31T01:02:03.000Z',
      findings: [{
        id: 'risk-1',
        bidDocumentId: 'bid-b',
        type: 'invalidBid',
        severity: 'high',
        title: '签字缺失',
        summary: '法定代表人未签字',
        requirement: '必须签字',
        bidEvidence: '签字栏为空',
        riskReason: '可能被认定为无效标',
        suggestion: '补充签字',
      }],
    },
    typoCheckResult: {
      status: 'success',
      inputSignature: 'bid-current',
      updatedAt: '2026-08-31T02:03:04.000Z',
      findings: [{
        id: 'typo-1',
        bidDocumentId: 'bid-a',
        wrongText: '项目经里',
        correctText: '项目经理',
        originalExcerpt: '由项目经里负责',
        reason: '词语错误',
      }],
    },
    logicCheckResult: {
      status: 'success',
      inputSignature: 'bid-current',
      updatedAt: '2026-08-31T03:04:05.000Z',
      findings: [{
        id: 'logic-1',
        bidDocumentId: 'bid-a',
        title: '工期矛盾',
        originalText: '工期为30天，计划用时45天',
        locationHint: '施工组织设计第2章',
        fallacyReason: '计划工期超过承诺工期',
        suggestion: '统一为30天以内',
      }],
    },
  };
}

function createDuplicateState() {
  const bidFiles = [
    { id: 'file-a', file_name: 'A公司投标文件.docx' },
    { id: 'file-b', file_name: 'B公司投标文件.docx' },
  ];
  return {
    tenderFiles: [{ id: 'tender-a', file_name: '招标文件.docx' }],
    bidFiles,
    metadataAnalysis: {
      status: 'success',
      signature: 'duplicate-current',
      updated_at: '2026-08-31T04:05:06.000Z',
      message: '元数据分析完成',
      rows: [{
        key: 'creator',
        label: '作者',
        values: { 'file-a': '张三', 'file-b': '张三' },
        duplicate_file_ids: ['file-a', 'file-b'],
        same_day_file_ids: [],
      }, {
        key: 'created',
        label: '创建日期',
        values: { 'file-a': '2026-08-30 09:00', 'file-b': '2026-08-30 18:00' },
        duplicate_file_ids: [],
        same_day_file_ids: ['file-a', 'file-b'],
      }],
    },
    outlineAnalysis: {
      status: 'success',
      signature: 'duplicate-current',
      updated_at: '2026-08-31T05:06:07.000Z',
      message: '目录分析完成',
      tenderMatchedItemCount: 3,
      duplicateGroups: [{
        id: 'group-1',
        type: 'similar',
        title: '施工方案',
        score: 0.875,
        file_ids: ['file-a', 'file-b'],
        item_ids: { 'file-a': ['a-1'], 'file-b': ['b-1'] },
        paths: { 'file-a': ['第一章 > 施工方案'], 'file-b': ['第二章 > 实施方案'] },
      }],
      pairwiseSimilarities: [{
        file_a_id: 'file-a',
        file_b_id: 'file-b',
        score: 0.8,
        title_overlap: 0.75,
        path_overlap: 0.6,
        order_similarity: 0.9,
        shared_count: 4,
        risk: 'high',
      }],
    },
    contentAnalysis: {
      status: 'success',
      signature: 'duplicate-current',
      updated_at: '2026-08-31T06:07:08.000Z',
      message: '正文分析完成',
      tenderMatchedSentenceCount: 5,
      totalSentenceCount: 120,
      duplicateSentences: [{
        id: 'sentence-1',
        sentence: '本项目将严格按照招标文件要求实施。',
        file_ids: ['file-a', 'file-b'],
        occurrences: { 'file-a': 2, 'file-b': 1 },
      }],
    },
    imageAnalysis: {
      status: 'success',
      signature: 'duplicate-current',
      updated_at: '2026-08-31T07:08:09.000Z',
      message: '图片分析完成',
      totalImageCount: 18,
      duplicateImages: [{
        id: 'image-1',
        hash: 'abc123',
        preview_url: 'yibiao-asset://imported-images/internal.png',
        file_ids: ['file-a', 'file-b'],
        occurrences: { 'file-a': 2, 'file-b': 1 },
        locations: {
          'file-a': [
            { image_index: 2, directory: '第一章/组织架构', previous_sentence: '组织架构如下。' },
            { image_index: 8, directory: '第三章/人员安排', previous_sentence: '人员安排如下。' },
          ],
          'file-b': [{ image_index: 3, directory: '第二章/组织架构', previous_sentence: '项目架构如下。' }],
        },
      }],
    },
  };
}

test('废标检查工作簿固定生成四张工作表并完整映射三类结果', () => {
  const workbook = roundTripWorkbook(__test__.buildRejectionWorkbook(
    createRejectionState(),
    { rejectionInputSignature: 'rejection-current', bidSignature: 'bid-current' },
    { exportedAt: new Date('2026-09-01T08:09:10.000Z') },
  ));
  assert.deepEqual(workbook.SheetNames, ['检查概览', '废标项', '错别字', '逻辑问题']);

  const overview = sheetRows(workbook, '检查概览');
  assert.deepEqual(overview[2], ['检查类型', '状态', '问题数量', '更新时间', '检查对象', '说明']);
  assert.deepEqual(overview[3].slice(0, 5), ['废标项检查', '已完成', 1, '2026-08-31T01:02:03.000Z', '甲公司投标文件.docx；乙公司投标文件.docx']);

  const rejection = sheetRows(workbook, '废标项');
  assert.deepEqual(rejection[1], [1, 2, '乙公司投标文件.docx', '无效标', '高风险', '签字缺失', '法定代表人未签字', '必须签字', '签字栏为空', '可能被认定为无效标', '补充签字']);

  const typo = sheetRows(workbook, '错别字');
  assert.deepEqual(typo[1], [1, 1, '甲公司投标文件.docx', '项目经里', '项目经理', '', '由项目经里负责', '词语错误']);
  assert.equal(typo.flat().includes('undefined'), false);

  const logic = sheetRows(workbook, '逻辑问题');
  assert.deepEqual(logic[1], [1, 1, '甲公司投标文件.docx', '工期矛盾', '施工组织设计第2章', '工期为30天，计划用时45天', '计划工期超过承诺工期', '统一为30天以内']);
});

test('废标检查按不同签名筛选三类结果且保留成功零问题报告', () => {
  const state = createRejectionState();
  state.rejectionCheckResult.inputSignature = 'rejection-old';
  state.typoCheckResult = { status: 'success', inputSignature: 'bid-current', findings: [] };
  state.logicCheckResult = { status: 'error', inputSignature: 'bid-old', findings: [{ id: 'old' }] };

  const selected = __test__.selectCurrentRejectionResults(state, {
    rejectionInputSignature: 'rejection-current',
    bidSignature: 'bid-current',
  });
  assert.equal(selected.exportable, true);
  assert.equal(selected.rejectionCheckResult.valid, false);
  assert.deepEqual(selected.rejectionCheckResult.findings, []);
  assert.equal(selected.typoCheckResult.valid, true);
  assert.deepEqual(selected.typoCheckResult.findings, []);
  assert.equal(selected.logicCheckResult.valid, false);
  assert.deepEqual(selected.logicCheckResult.findings, []);

  const workbook = roundTripWorkbook(__test__.buildRejectionWorkbook(state, {
    rejectionInputSignature: 'rejection-current',
    bidSignature: 'bid-current',
  }));
  assert.deepEqual(sheetRows(workbook, '废标项'), [[
    '序号', '投标文件序号', '投标文件名', '类型', '风险等级', '标题', '摘要', '招标要求', '投标证据', '风险原因', '修改建议',
  ]]);
  assert.deepEqual(sheetRows(workbook, '错别字'), [[
    '序号', '投标文件序号', '投标文件名', '错误文本', '建议改正', '位置', '原文摘录', '判断原因',
  ]]);
  assert.equal(sheetRows(workbook, '检查概览')[4][5], '检查已完成，未发现问题');
});

test('查重工作簿固定生成六张工作表并导出所有现有分析维度', () => {
  const workbook = roundTripWorkbook(__test__.buildDuplicateWorkbook(
    createDuplicateState(),
    { signature: 'duplicate-current' },
    { exportedAt: new Date('2026-09-01T08:09:10.000Z') },
  ));
  assert.deepEqual(workbook.SheetNames, ['查重概览', '元数据', '目录重复', '文件相似度', '重复句子', '重复图片']);

  const overview = sheetRows(workbook, '查重概览');
  assert.deepEqual(overview.slice(-4).map((row) => row.slice(0, 2)), [
    ['识别图片总数', 18],
    ['招标目录排除数量', 3],
    ['招标引用句子排除数量', 5],
    ['正文句子总量', 120],
  ]);

  const metadata = sheetRows(workbook, '元数据');
  assert.deepEqual(metadata[0], ['元数据项', '重复文件', '同日文件', '投标文件1：A公司投标文件.docx', '投标文件2：B公司投标文件.docx']);
  assert.deepEqual(metadata[1], ['作者', 'A公司投标文件.docx；B公司投标文件.docx', '', '张三', '张三']);
  assert.deepEqual(metadata[2], ['创建日期', '', 'A公司投标文件.docx；B公司投标文件.docx', '2026-08-30 09:00', '2026-08-30 18:00']);

  const outline = sheetRows(workbook, '目录重复');
  assert.deepEqual(outline[1], [1, '相似', '施工方案', 0.875, 'A公司投标文件.docx；B公司投标文件.docx', 'A公司投标文件.docx：第一章 > 施工方案；B公司投标文件.docx：第二章 > 实施方案']);
  assert.equal(workbook.Sheets['目录重复'].D2.z, '0.00%');

  const pairwise = sheetRows(workbook, '文件相似度');
  assert.deepEqual(pairwise[1], ['A公司投标文件.docx', 'B公司投标文件.docx', 0.8, 0.75, 0.6, 0.9, 4, '高']);
  assert.equal(workbook.Sheets['文件相似度'].C2.z, '0.00%');
  assert.equal(workbook.Sheets['文件相似度'].F2.z, '0.00%');

  const sentences = sheetRows(workbook, '重复句子');
  assert.deepEqual(sentences[1], [1, '本项目将严格按照招标文件要求实施。', 'A公司投标文件.docx；B公司投标文件.docx', 'A公司投标文件.docx × 2；B公司投标文件.docx × 1', 3]);

  const images = sheetRows(workbook, '重复图片');
  assert.equal(images[1][1], 'abc123');
  assert.equal(images[1][3], 'A公司投标文件.docx × 2；B公司投标文件.docx × 1');
  assert.match(images[1][4], /A公司投标文件\.docx：第一章\/组织架构（图片 2）/);
  assert.match(images[1][4], /A公司投标文件\.docx：第三章\/人员安排（图片 8）/);
  assert.match(images[1][4], /B公司投标文件\.docx：第二章\/组织架构（图片 3）/);
  assert.match(images[1][5], /人员安排如下。/);
  assert.equal(images.flat().some((value) => String(value).includes('yibiao-asset://')), false);
});

test('查重按每个维度签名筛选，旧结果不进入工作簿，成功零结果仍可导出', () => {
  const state = createDuplicateState();
  state.metadataAnalysis.signature = 'duplicate-old';
  state.outlineAnalysis = { status: 'success', signature: 'duplicate-current', duplicateGroups: [], pairwiseSimilarities: [] };
  state.contentAnalysis = { status: 'error', signature: 'duplicate-old', duplicateSentences: [{ id: 'old' }] };
  state.imageAnalysis = undefined;

  const selected = __test__.selectCurrentDuplicateResults(state, { signature: 'duplicate-current' });
  assert.equal(selected.exportable, true);
  assert.equal(selected.metadataAnalysis.valid, false);
  assert.equal(selected.outlineAnalysis.valid, true);
  assert.equal(selected.contentAnalysis.valid, false);
  assert.equal(selected.imageAnalysis.valid, false);

  const workbook = roundTripWorkbook(__test__.buildDuplicateWorkbook(state, { signature: 'duplicate-current' }));
  assert.equal(sheetRows(workbook, '元数据').length, 1);
  assert.equal(sheetRows(workbook, '目录重复').length, 1);
  assert.equal(sheetRows(workbook, '文件相似度').length, 1);
  assert.equal(sheetRows(workbook, '重复句子').length, 1);
  assert.equal(sheetRows(workbook, '查重概览')[4][6], '分析已完成，未发现重复项');
});

test('文本归一化移除 XML 控制字符、保留空格换行并稳定截断超长单元格', () => {
  assert.equal(__test__.normalizeCellText(null), '');
  assert.equal(__test__.normalizeCellText(undefined), '');
  assert.equal(__test__.normalizeCellText('  第一行\n第二行\u0001  '), '  第一行\n第二行  ');
  const normalized = __test__.normalizeCellText('长'.repeat(40000));
  assert.equal(normalized.length, 32750 + '……（内容过长，已截断）'.length);
  assert.equal(normalized.startsWith('长'.repeat(32750)), true);
  assert.equal(normalized.endsWith('……（内容过长，已截断）'), true);
});

test('保存服务在取消时不写文件', async () => {
  const writes = [];
  const service = createCheckResultExportService({
    app: { getPath: () => 'C:\\用户\\下载' },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    rejectionCheckStore: { loadRejectionCheck: () => createRejectionState() },
    duplicateCheckStore: { loadDuplicateCheck: () => createDuplicateState() },
    fileSystem: { writeFileSync: (...args) => writes.push(args) },
    now: () => new Date('2026-09-01T08:09:10.000Z'),
  });
  const result = await service.exportRejectionExcel({ rejectionInputSignature: 'rejection-current', bidSignature: 'bid-current' });
  assert.deepEqual(result, { success: false, canceled: true, message: '已取消导出' });
  assert.deepEqual(writes, []);
});

test('保存服务补充 xlsx 扩展名并写入可重新读取的真实工作簿 Buffer', async () => {
  const writes = [];
  let saveOptions;
  const service = createCheckResultExportService({
    app: { getPath: () => 'C:\\用户\\下载' },
    dialog: {
      showSaveDialog: async (options) => {
        saveOptions = options;
        return { canceled: false, filePath: 'D:\\中文目录\\查重结果' };
      },
    },
    rejectionCheckStore: { loadRejectionCheck: () => createRejectionState() },
    duplicateCheckStore: { loadDuplicateCheck: () => createDuplicateState() },
    fileSystem: { writeFileSync: (...args) => writes.push(args) },
    now: () => new Date(2026, 8, 1, 8, 9, 10),
  });
  const result = await service.exportDuplicateExcel({ signature: 'duplicate-current' });
  assert.deepEqual(result, { success: true, path: 'D:\\中文目录\\查重结果.xlsx', message: 'Excel 已导出' });
  assert.equal(saveOptions.defaultPath.endsWith('标书查重结果_20260901_080910.xlsx'), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'D:\\中文目录\\查重结果.xlsx');
  assert.ok(Buffer.isBuffer(writes[0][1]));
  const reopened = XLSX.read(writes[0][1], { type: 'buffer' });
  assert.deepEqual(reopened.SheetNames, ['查重概览', '元数据', '目录重复', '文件相似度', '重复句子', '重复图片']);
});

test('仅有当前错误状态且没有结果行时服务拒绝导出', async () => {
  const state = createRejectionState();
  state.rejectionCheckResult = { status: 'error', inputSignature: 'rejection-current', findings: [] };
  state.typoCheckResult = { status: 'error', inputSignature: 'bid-current', findings: [] };
  state.logicCheckResult = { status: 'idle', inputSignature: 'bid-current', findings: [] };
  const service = createCheckResultExportService({
    dialog: { showSaveDialog: async () => assert.fail('不应打开保存对话框') },
    rejectionCheckStore: { loadRejectionCheck: () => state },
    duplicateCheckStore: { loadDuplicateCheck: () => createDuplicateState() },
  });
  assert.deepEqual(
    await service.exportRejectionExcel({ rejectionInputSignature: 'rejection-current', bidSignature: 'bid-current' }),
    { success: false, message: '没有可导出的当前废标检查结果' },
  );
});
