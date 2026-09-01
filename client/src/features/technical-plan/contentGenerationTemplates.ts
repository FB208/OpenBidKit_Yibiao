export interface ContentGenerationTemplateDefinition {
  id: string;
  name: string;
  description: string;
  guidance: string;
  htmlExample: string;
}

/** 实际正文模板注册表；列表卡片和完整预览均直接渲染 htmlExample。 */
export const contentGenerationTemplates = [
  {
    id: 'standard-document',
    name: '标准投标文档',
    description: '采用正式投标文风，以标准表格归纳项目目标、实施计划和保障措施。',
    guidance: '按照竖版 A4 单栏正文组织内容。使用标题和段落完成正式论述，以标准表格归纳项目概况、实施计划、风险措施和服务承诺；关键流程使用左图右文结构，图片必须紧跟相关正文并提供图例。',
    htmlExample: `<!-- yibiao:block -->
<h1 id="std_h_001">第一章 项目实施总体方案</h1>

<!-- yibiao:block -->
<p id="std_p_001">我方充分理解本项目建设目标和招标要求，将坚持<strong>统筹规划、分步实施、质量受控、服务持续</strong>的原则，建立覆盖准备、实施、检查、验收和运维支持的全过程管理体系。</p>

<!-- yibiao:block -->
<table id="std_tbl_001" data-yb-preset="headerColumn">
  <caption>项目实施目标概览</caption>
  <tbody>
    <tr><th scope="row">建设目标</th><td>按照招标文件要求完成项目建设、成果交付和配套服务，确保各项功能稳定运行。</td></tr>
    <tr><th scope="row">计划工期</th><td>合同签订后 120 日历天内完成实施与验收，具体节点服从采购人统一安排。</td></tr>
    <tr><th scope="row">质量目标</th><td>成果一次验收合格，符合国家、行业标准及采购人管理制度。</td></tr>
    <tr><th scope="row">服务目标</th><td>建立快速响应机制，提供持续技术支持和完整项目资料。</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<h2 id="std_h_002">第一节 实施组织与工作路径</h2>

<!-- yibiao:block -->
<table id="std_tbl_002" data-yb-preset="imageText">
  <caption>项目实施总体路径</caption>
  <tbody>
    <tr>
      <td><figure id="std_fig_001" data-yb-generation="mermaid"><template data-yb-role="prompt">生成竖向项目实施流程图，依次展示项目启动、需求确认、方案深化、现场实施、联调测试、验收交付和运维支持，中文清晰，适合竖版 A4 页面。</template><img alt="项目实施总体流程图"><figcaption>项目实施总体流程</figcaption></figure></td>
      <td><p><strong>全过程分阶段推进</strong></p><p>项目经理统一组织人员、进度、质量和沟通管理，各专业负责人按照计划完成阶段成果。</p><ol><li>启动阶段明确范围、接口和责任。</li><li>实施阶段执行计划、检查和问题闭环。</li><li>交付阶段完成测试、培训和资料移交。</li></ol></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<h2 id="std_h_003">第二节 进度与成果控制</h2>

<!-- yibiao:block -->
<table id="std_tbl_003" data-yb-preset="headerRow">
  <caption>主要阶段实施计划</caption>
  <thead>
    <tr><th scope="col">实施阶段</th><th scope="col">主要工作</th><th scope="col">阶段成果</th><th scope="col">控制要求</th></tr>
  </thead>
  <tbody>
    <tr><td>项目准备</td><td>现场调研、需求确认、计划编制</td><td>实施计划、需求清单</td><td>条件齐备、职责明确</td></tr>
    <tr><td>深化实施</td><td>方案深化、资源进场、现场执行</td><td>深化成果、过程记录</td><td>按图实施、检查留痕</td></tr>
    <tr><td>联调测试</td><td>功能测试、问题整改、复核确认</td><td>测试报告、整改记录</td><td>问题闭环、结果可追溯</td></tr>
    <tr><td>验收交付</td><td>成果验收、用户培训、资料移交</td><td>验收资料、培训记录</td><td>资料完整、一次通过</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<h2 id="std_h_004">第三节 质量与风险保障</h2>

<!-- yibiao:block -->
<table id="std_tbl_004" data-yb-preset="headerRowAndColumn">
  <caption>主要风险及应对措施</caption>
  <thead><tr><th scope="col">风险类别</th><th scope="col">风险表现</th><th scope="col">应对措施</th></tr></thead>
  <tbody>
    <tr><th scope="row">进度风险</th><td>接口条件变化影响关键节点</td><td>提前确认条件，动态调整资源并执行节点预警。</td></tr>
    <tr><th scope="row">质量风险</th><td>阶段成果存在遗漏或偏差</td><td>执行编制、复核、批准三级审查和样板先行制度。</td></tr>
    <tr><th scope="row">协同风险</th><td>多方信息传递不及时</td><td>建立例会、周报和重大事项升级决策机制。</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<figure id="std_fig_002" data-yb-generation="aiImage">
  <template data-yb-role="prompt">生成项目团队开展现场质量检查的真实工作场景，画面包含检查人员、记录表和作业区域，无文字水印，适合竖版 A4 页面。</template>
  <img alt="项目团队现场质量检查场景">
  <figcaption>现场质量检查与过程记录</figcaption>
</figure>

<!-- yibiao:block -->
<table id="std_tbl_005" data-yb-preset="headerRow">
  <caption>项目服务承诺</caption>
  <thead><tr><th scope="col">服务事项</th><th scope="col">响应要求</th><th scope="col">交付记录</th></tr></thead>
  <tbody>
    <tr><td>技术咨询</td><td>工作时间 2 小时内响应</td><td>咨询记录与处理意见</td></tr>
    <tr><td>故障处理</td><td>接报后立即分析并安排处理</td><td>故障工单与闭环报告</td></tr>
    <tr><td>持续支持</td><td>定期回访并提供优化建议</td><td>回访记录与优化清单</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="std_p_002">我方将以明确的组织体系、可执行的进度计划和严格的质量控制措施保障项目顺利实施，并接受采购人对全过程工作的监督与考核。</p>`,
  },
  {
    id: 'visual-table',
    name: '图文表格方案',
    description: '参考图册式投标文件，以表格组织信息并嵌入图片和图例，视觉表达更丰富。',
    guidance: '按照竖版 A4 单栏阅读顺序组织内容，不建立页面级左右双栏。参考图册式表格布局，通过左图右文、合并单元格、三列图例和四宫格图组强化信息层级；局部表格可以多列，但图片必须提供图例，且表格宽度应适合竖版页面。',
    htmlExample: `<!-- yibiao:block -->
<h1 id="visual_h_001">第一章 项目实施蓝图</h1>

<!-- yibiao:block -->
<p id="visual_p_001">本方案以<strong>目标、行动、成果</strong>为主线，通过表格化信息组织与场景图片展示项目实施重点。</p>

<!-- yibiao:block -->
<table id="visual_tbl_001" data-yb-preset="headerRow">
  <caption>项目实施核心目标</caption>
  <thead>
    <tr><th scope="col">管理维度</th><th scope="col">实施目标</th><th scope="col">成果标志</th></tr>
  </thead>
  <tbody>
    <tr><td>进度管理</td><td>关键节点按期完成</td><td>节点验收记录完整</td></tr>
    <tr><td>质量管理</td><td>全过程质量受控</td><td>问题整改闭环</td></tr>
    <tr><td>协同管理</td><td>信息传递及时准确</td><td>协同机制稳定运行</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_002" data-yb-preset="imageText">
  <caption>实施阶段图文说明</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_001" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目启动部署会议与现场踏勘组合场景，人员正在查看图纸并核对现场条件，真实工程摄影风格，无文字水印，适合竖版 A4 页面。</template><img alt="项目启动部署与现场踏勘场景"><figcaption>项目启动部署与现场踏勘</figcaption></figure></td>
      <td><p><strong>现场部署与组织协同</strong></p><p>根据项目条件完成资源进场、工作界面确认和责任分工。</p><ol><li>核对实施条件。</li><li>明确接口责任。</li><li>建立检查机制。</li></ol></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<h2 id="visual_h_002">第一节 全过程质量控制</h2>

<!-- yibiao:block -->
<table id="visual_tbl_003" data-yb-preset="plain">
  <caption>质量控制方法</caption>
  <tbody>
    <tr><th scope="row">事前控制</th><td>审查方案、人员、材料和设备条件，形成开工检查记录。</td></tr>
    <tr><th scope="row">事中控制</th><td>执行旁站、巡检和阶段复核，对发现的问题限时整改。</td></tr>
    <tr><th scope="row">事后控制</th><td>整理过程资料，完成成果复核和交付验收。</td></tr>
    <tr><td colspan="2"><figure id="visual_fig_002" data-yb-generation="htmlImage"><template data-yb-role="prompt">生成竖向全过程质量控制信息图，展示事前控制、事中控制、事后控制和闭环改进，中文清晰，适合竖版 A4 页面。</template><img alt="全过程质量控制信息图"><figcaption>全过程质量控制闭环</figcaption></figure></td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_004" data-yb-preset="threeImages">
  <caption>关键工作图例</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_003" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目团队进行技术交底的真实场景，无文字水印。</template><img alt="技术交底场景"><figcaption>技术交底</figcaption></figure></td>
      <td><figure id="visual_fig_004" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目人员开展过程检查的真实场景，无文字水印。</template><img alt="过程检查场景"><figcaption>过程检查</figcaption></figure></td>
      <td><figure id="visual_fig_005" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目人员复核过程资料的真实办公场景，无文字水印。</template><img alt="资料复核场景"><figcaption>资料复核</figcaption></figure></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_005" data-yb-preset="fourImages">
  <caption>关键实施场景</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_006" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目人员组织协调会议的真实场景，无文字水印。</template><img alt="人员组织场景"><figcaption>人员组织</figcaption></figure></td>
      <td><figure id="visual_fig_007" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目设备进场与配置的真实场景，无文字水印。</template><img alt="设备配置场景"><figcaption>设备配置</figcaption></figure></td>
    </tr>
    <tr>
      <td><figure id="visual_fig_008" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目人员开展现场实施的真实场景，无文字水印。</template><img alt="现场实施场景"><figcaption>现场实施</figcaption></figure></td>
      <td><figure id="visual_fig_009" data-yb-generation="aiImage"><template data-yb-role="prompt">生成项目成果验收会议的真实场景，无文字水印。</template><img alt="成果验收场景"><figcaption>成果验收</figcaption></figure></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_006" data-yb-preset="headerRow">
  <caption>项目实施保障措施</caption>
  <thead><tr><th scope="col">保障方向</th><th scope="col">主要措施</th><th scope="col">预期成效</th></tr></thead>
  <tbody>
    <tr><td>组织保障</td><td>项目经理负责制，专业负责人分工协同</td><td>责任到人、决策高效</td></tr>
    <tr><td>进度保障</td><td>节点计划、每日跟踪、偏差预警</td><td>关键任务按期完成</td></tr>
    <tr><td>质量保障</td><td>样板先行、过程检查、三级复核</td><td>成果一次验收合格</td></tr>
    <tr><td>服务保障</td><td>快速响应、定期回访、持续优化</td><td>服务全过程可追溯</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="visual_p_002">通过纵向章节编排、表格化要点表达和带图例的场景图片，使实施逻辑清晰、重点直观且便于查阅。</p>`,
  },
] as const satisfies readonly ContentGenerationTemplateDefinition[];

export type ContentGenerationTemplateId = typeof contentGenerationTemplates[number]['id'];

export const DEFAULT_CONTENT_GENERATION_TEMPLATE_ID: ContentGenerationTemplateId = 'standard-document';

/** 获取可用模板；未知 ID 回到默认模板。 */
export function getContentGenerationTemplate(value: unknown) {
  return contentGenerationTemplates.find((template) => template.id === value) || contentGenerationTemplates[0];
}
