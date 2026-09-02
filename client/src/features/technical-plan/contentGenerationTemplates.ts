export interface ContentGenerationTemplateDefinition {
  id: string;
  name: string;
  description: string;
  guidance: string;
  htmlExample: string;
}

/** 实际正文模板注册表；htmlExample 不保存仅供 Renderer 展示的预览图片地址。 */
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
<p id="std_p_007">质量管理贯穿项目实施全过程。我方以质量策划为先导，以样板确认和工序检查为抓手，以成果复核和问题闭环为保障，执行编制、复核、批准三级审查制度；对关键工序设置质量控制点，未经检查确认不得转入下一阶段。</p>

<!-- yibiao:block -->
<figure id="std_fig_001" data-yb-generation="htmlImage" data-yb-size="wide">
  <template data-yb-role="prompt">生成 3:2 横向项目全过程质量管控架构图，展示质量策划、样板确认、工序检查、成果复核、问题整改和闭环验证之间的关系；采用专业工程蓝图风格，不使用文字，仅用清晰图形、箭头和层级表达，关键内容置于画面安全区域，无水印，适合竖版 A4 页面。</template>
  <img alt="项目全过程质量管控架构图">
  <figcaption>项目全过程质量管控架构</figcaption>
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
<h1 id="visual_h_001">第一章 项目实施总体策划</h1>

<!-- yibiao:block -->
<p id="visual_p_001">本方案以<strong>工作分解结构、里程碑计划、质量控制点和交付成果</strong>为主线，通过高密度表格与专业图示集中呈现项目实施逻辑、资源配置和全过程管控要求。</p>

<!-- yibiao:block -->
<table id="visual_tbl_001" data-yb-preset="headerRow">
  <caption>项目实施控制目标</caption>
  <thead>
    <tr><th scope="col">控制维度</th><th scope="col">管理目标</th><th scope="col">核验依据</th></tr>
  </thead>
  <tbody>
    <tr><td>工期控制</td><td>总工期受控，关键里程碑按期实现</td><td>基准计划、周进度报告、节点确认单</td></tr>
    <tr><td>质量控制</td><td>关键工序受检，质量问题闭环销项</td><td>检查记录、整改台账、复核结论</td></tr>
    <tr><td>技术控制</td><td>技术方案可实施，接口边界清晰</td><td>深化成果、技术交底、变更记录</td></tr>
    <tr><td>交付控制</td><td>实物、资料与培训同步完成</td><td>验收报告、竣工资料、移交清单</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_002" data-yb-preset="imageText">
  <caption>项目实施总控模型</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_001" data-yb-generation="aiImage" data-yb-size="tall"><template data-yb-role="prompt">生成 3:4 竖向大型工程项目实施总控数字孪生场景图，以轴测视角展示施工区域、临建设施、物流通道、作业分区和管理节点；主体集中在画面中央安全区域，蓝灰工程视觉，无文字、标志和水印，适合竖版 A4 页面。</template><img alt="项目实施总控数字孪生场景图"><figcaption>项目实施总控场景</figcaption></figure></td>
      <td><p><strong>计划、资源、质量一体化控制</strong></p><p>以批准的实施基线为依据，统一组织专业穿插、资源投入和质量检查。</p><ol><li>按 WBS 分解工作包与责任界面。</li><li>以里程碑驱动进度和资源计划。</li><li>通过质量门与问题台账闭环管控。</li></ol></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<h2 id="visual_h_002">第一节 进度、质量与技术协同</h2>

<!-- yibiao:block -->
<table id="visual_tbl_003" data-yb-preset="plain">
  <caption>项目总体进度控制计划</caption>
  <tbody>
    <tr><th scope="row">基准计划</th><td>将准备、深化、采购、实施、调试和验收工作分解到可检查的阶段节点。</td></tr>
    <tr><th scope="row">滚动控制</th><td>按周更新实际进展、剩余工作量和资源需求，持续校核关键路径。</td></tr>
    <tr><th scope="row">偏差纠正</th><td>对滞后事项及时采取资源增补、工序优化和专业穿插调整措施。</td></tr>
    <tr><td colspan="2"><figure id="visual_fig_002" data-yb-generation="htmlImage" data-yb-size="panorama"><template data-yb-role="prompt">生成 16:9 全景项目总体进度甘特图，体现准备、深化、采购、实施、调试和验收六类工作在时间轴上的穿插关系、关键里程碑和关键路径；采用专业项目管理图表风格，不使用文字和数字，仅用分组色带、进度条和菱形节点表达，关键内容置于画面安全区域，无水印。</template><img alt="项目总体进度甘特图"><figcaption>总体进度甘特计划</figcaption></figure></td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_004" data-yb-preset="threeImages">
  <caption>质量、工作分解与技术架构</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_003" data-yb-generation="htmlImage" data-yb-size="square"><template data-yb-role="prompt">生成 1:1 方形全过程质量控制闭环信息图，展示输入审查、样板确认、工序检查、问题整改、复核销项和持续改进的循环关系；采用专业蓝白信息图风格，不使用文字，仅用图标、节点和箭头表达，关键内容置于画面安全区域，无水印。</template><img alt="全过程质量控制闭环信息图"><figcaption>全过程质量控制闭环</figcaption></figure></td>
      <td><figure id="visual_fig_004" data-yb-generation="mermaid" data-yb-size="square"><template data-yb-role="prompt">生成 1:1 方形项目工作分解结构思维导图，以项目目标为中心，向外展开项目管理、深化设计、采购供应、现场实施、调试验收和资料移交六个一级分支，并继续分解关键工作；不使用文字，仅用层级色块、图标和连线表达，关键内容置于画面安全区域，无水印。</template><img alt="项目工作分解结构思维导图"><figcaption>WBS 工作分解结构</figcaption></figure></td>
      <td><figure id="visual_fig_005" data-yb-generation="htmlImage" data-yb-size="square"><template data-yb-role="prompt">生成 1:1 方形项目技术架构图，分层展示基础设施层、设备接入层、数据传输层、平台服务层和业务应用层，体现上下行数据流和安全边界；采用专业蓝图风格，不使用文字，仅用模块、图标和连线表达，关键内容置于画面安全区域，无水印。</template><img alt="项目分层技术架构图"><figcaption>分层技术架构</figcaption></figure></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_005" data-yb-preset="fourImages">
  <caption>组织、资源、实施与交付图组</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_006" data-yb-generation="mermaid" data-yb-size="wide"><template data-yb-role="prompt">生成 3:2 横向工程项目组织架构图，以项目经理部为核心，下设技术管理、工程实施、质量安全、物资设备和资料交付五个专业组，并体现汇报与协同关系；不使用文字，仅用人物图标、层级节点和连接线表达，关键内容置于画面安全区域，无水印。</template><img alt="工程项目组织架构图"><figcaption>项目组织架构</figcaption></figure></td>
      <td><figure id="visual_fig_007" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">生成 3:2 横向工程项目设备与工器具配置专业轴测图，分区展示运输吊装、安装加工、检测调试和安全防护四类资源，器材摆放有序；关键内容置于画面安全区域，蓝灰工程视觉，无文字、品牌和水印。</template><img alt="工程设备与工器具配置轴测图"><figcaption>设备资源配置</figcaption></figure></td>
    </tr>
    <tr>
      <td><figure id="visual_fig_008" data-yb-generation="aiImage" data-yb-size="wide"><template data-yb-role="prompt">生成 3:2 横向复杂工程现场多专业协同实施剖切场景图，展示结构、机电、管线和设备安装在不同作业面有序穿插，具备真实工程细节；关键内容置于画面安全区域，专业工程可视化风格，无文字、品牌和水印。</template><img alt="多专业协同现场实施剖切场景图"><figcaption>多专业协同实施</figcaption></figure></td>
      <td><figure id="visual_fig_009" data-yb-generation="htmlImage" data-yb-size="wide"><template data-yb-role="prompt">生成 3:2 横向项目验收与移交流程图，展示专业自检、联合预验收、问题整改、正式验收、资料归档和运维移交的顺序及反馈闭环；采用专业蓝白流程图风格，不使用文字，仅用图标、节点和箭头表达，关键内容置于画面安全区域，无水印。</template><img alt="项目验收与移交流程图"><figcaption>验收与移交闭环</figcaption></figure></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_006" data-yb-preset="headerRow">
  <caption>项目实施管理基线</caption>
  <thead><tr><th scope="col">管理基线</th><th scope="col">主要控制措施</th><th scope="col">输出成果</th></tr></thead>
  <tbody>
    <tr><td>组织基线</td><td>岗位授权、责任矩阵、专业协同与重大事项升级</td><td>组织架构、职责矩阵、沟通机制</td></tr>
    <tr><td>进度基线</td><td>里程碑分解、滚动计划、偏差分析与赶工纠偏</td><td>总控计划、周计划、偏差报告</td></tr>
    <tr><td>质量基线</td><td>样板先行、质量门检查、实测实量与问题销项</td><td>检查记录、问题台账、复核报告</td></tr>
    <tr><td>交付基线</td><td>实物验收、资料同步、培训移交与质保响应</td><td>验收文件、移交清单、培训记录</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="visual_p_002">通过总控场景、管理图表、工程架构和交付流程的组合表达，使计划逻辑、责任关系、技术路径和成果边界能够快速识别，并为项目实施和履约检查提供统一依据。</p>`,
  },
] as const satisfies readonly ContentGenerationTemplateDefinition[];

export type ContentGenerationTemplateId = typeof contentGenerationTemplates[number]['id'];

export const DEFAULT_CONTENT_GENERATION_TEMPLATE_ID: ContentGenerationTemplateId = 'standard-document';

/** 获取可用模板；未知 ID 回到默认模板。 */
export function getContentGenerationTemplate(value: unknown) {
  return contentGenerationTemplates.find((template) => template.id === value) || contentGenerationTemplates[0];
}
