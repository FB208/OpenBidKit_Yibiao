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
    description: '以正式文字论述为主，辅以少量标准表格和独立图片，适合常规投标文件。',
    guidance: '按照竖版 A4 单栏正文组织内容。以标题、连续段落和少量列表为主，只在需要对比或归纳时使用标准表格；图片少量穿插并独立排版，图例紧贴图片下方，不把图片嵌入表格。',
    htmlExample: `<!-- yibiao:block -->
<h1 id="std_h_001">第一章 项目实施总体方案</h1>

<!-- yibiao:block -->
<p id="std_p_001">我方充分理解本项目建设目标和招标要求，将坚持<strong>统筹规划、分步实施、质量受控、服务持续</strong>的原则，建立覆盖准备、实施、检查、验收和运维支持的全过程管理体系。</p>

<!-- yibiao:block -->
<p id="std_p_002">项目实施以采购人需求为中心，由项目经理统一协调人员、进度、质量与沟通工作。各专业负责人按照批准的实施计划组织作业，重要事项及时报告，阶段成果经内部复核后提交确认，确保工作边界清晰、责任落实到人。</p>

<!-- yibiao:block -->
<h2 id="std_h_002">第一节 实施组织与工作路径</h2>

<!-- yibiao:block -->
<p id="std_p_003">项目启动后，我方首先完成现场条件核查、需求确认和接口梳理，并据此细化工作计划。进入实施阶段后，严格执行技术交底、过程检查和问题闭环制度；在交付阶段完成联调测试、用户培训、成果验收及资料移交。</p>

<!-- yibiao:block -->
<p id="std_p_004">各阶段工作坚持“先确认、后实施，先检查、后转序”的原则。未经确认的需求不擅自变更，未经检查的成果不进入下一环节，以此减少返工并保障总体工期。</p>

<!-- yibiao:block -->
<ol id="std_ol_001"><li>准备阶段：明确项目范围、实施条件、接口关系和责任分工。</li><li>实施阶段：按计划组织资源进场、现场作业、过程检查和阶段复核。</li><li>交付阶段：完成联调测试、问题整改、验收培训和资料移交。</li></ol>

<!-- yibiao:block -->
<h2 id="std_h_003">第二节 进度与成果控制</h2>

<!-- yibiao:block -->
<p id="std_p_005">我方将合同工期分解为可检查的阶段节点，通过周计划跟踪、偏差预警和资源动态调整控制实施节奏。计划执行情况纳入项目例会，影响关键节点的问题由项目经理牵头协调解决。</p>

<!-- yibiao:block -->
<table id="std_tbl_001" data-yb-preset="headerRow">
  <caption>主要阶段实施计划</caption>
  <thead>
    <tr><th scope="col">实施阶段</th><th scope="col">主要工作</th><th scope="col">阶段成果</th></tr>
  </thead>
  <tbody>
    <tr><td>项目准备</td><td>现场调研、需求确认、计划编制</td><td>实施计划、需求清单</td></tr>
    <tr><td>深化实施</td><td>方案深化、资源进场、现场执行</td><td>深化成果、过程记录</td></tr>
    <tr><td>联调测试</td><td>功能测试、问题整改、复核确认</td><td>测试报告、整改记录</td></tr>
    <tr><td>验收交付</td><td>成果验收、用户培训、资料移交</td><td>验收资料、培训记录</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="std_p_006">每项阶段成果均明确责任人、完成时限和检查要求。项目资料与现场工作同步形成，确保过程记录真实完整、成果状态清晰可追溯。</p>

<!-- yibiao:block -->
<h2 id="std_h_004">第三节 质量与风险保障</h2>

<!-- yibiao:block -->
<p id="std_p_007">质量管理贯穿项目实施全过程。我方执行编制、复核、批准三级审查制度，对关键工序实行样板先行和专项检查，对发现的问题明确整改责任、整改期限和复核结论。</p>

<!-- yibiao:block -->
<figure id="std_fig_001" data-yb-generation="aiImage">
  <template data-yb-role="prompt">生成项目团队开展现场质量检查的真实工作场景，画面包含检查人员、记录表和作业区域，无文字水印，适合竖版 A4 页面。</template>
  <img alt="项目团队现场质量检查场景">
  <figcaption>现场质量检查与过程记录</figcaption>
</figure>

<!-- yibiao:block -->
<p id="std_p_008">针对进度、质量和协同风险，项目组分别建立节点预警、成果复核和重大事项升级机制。风险发生后立即评估影响，采取资源调整、技术复核或专项协调措施，并持续跟踪直至关闭。</p>

<!-- yibiao:block -->
<h2 id="std_h_005">第四节 服务与交付承诺</h2>

<!-- yibiao:block -->
<p id="std_p_009">项目交付后，我方继续提供技术咨询、故障处理和定期回访服务。服务事项形成完整记录，处理结果及时反馈采购人，确保项目成果稳定运行并持续发挥效益。</p>

<!-- yibiao:block -->
<p id="std_p_010">我方将以明确的组织体系、可执行的进度计划和严格的质量控制措施保障项目顺利实施，并接受采购人对全过程工作的监督与考核。</p>`,
  },
  {
    id: 'visual-table',
    name: '图文表格方案',
    description: '以表格作为主要版面容器，大量使用表格内图片、三列图组和四宫格图组。',
    guidance: '按照竖版 A4 单栏阅读顺序组织内容，不建立页面级左右双栏。通过左图右文、合并单元格、三列图组和四宫格图组强化信息层级；所有图片必须放在表格单元格内并提供图例，表格宽度应适合竖版页面。',
    htmlExample: `<!-- yibiao:block -->
<h1 id="visual_h_001">第一章 项目实施蓝图</h1>

<!-- yibiao:block -->
<p id="visual_p_001">本方案以<strong>目标、行动、成果</strong>为主线，通过高密度表格和表格内场景图片集中展示项目实施重点。</p>

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
  <caption>三列关键工作图组</caption>
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
  <caption>四宫格关键实施场景</caption>
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
