import standardQualityControlUrl from '../../../assets/content-template-preview/standard-quality-control.webp';
import visualMasterPlanSceneUrl from '../../../assets/content-template-preview/visual-master-plan-scene.webp';
import visualQualityClosedLoopUrl from '../../../assets/content-template-preview/visual-quality-closed-loop.webp';
import visualTechnicalArchitectureUrl from '../../../assets/content-template-preview/visual-technical-architecture.webp';
import visualWbsMindmapUrl from '../../../assets/content-template-preview/visual-wbs-mindmap.webp';

/**
 * 展示模板：模板设置右侧预览使用的唯一样张。
 * 标题只写纯标题名，编号由导出模板的标题样式配置生成；图片使用已打包的本地地址。
 * 每一项模板设置都要能在样张里看到效果，因此保留六级标题、段落、有序与无序列表、
 * 独立图片、图文混排表格、并列图组以及带表头行与首列的表格各一处；
 * 样张每改一次配置就要重新生成并重新排版，所以刻意控制在三页左右，不做同类元素的重复堆叠。
 */
export const DOCUMENT_DISPLAY_TEMPLATE_HTML = `<!-- yibiao:block -->
<h1 id="tpl_h_001">项目实施总体方案</h1>

<!-- yibiao:block -->
<p id="tpl_p_001">我方充分理解本项目建设目标和招标要求，将坚持<strong>统筹规划、分步实施、质量受控、服务持续</strong>的原则，建立覆盖准备、实施、检查、验收和运维支持的全过程管理体系。</p>

<!-- yibiao:block -->
<h2 id="tpl_h_002">实施组织与工作路径</h2>

<!-- yibiao:block -->
<p id="tpl_p_002">项目启动后，我方首先完成现场条件核查、需求确认和接口梳理，并据此细化工作计划。进入实施阶段后，严格执行技术交底、过程检查和问题闭环制度；在交付阶段完成联调测试、用户培训、成果验收及资料移交。</p>

<!-- yibiao:block -->
<ol id="tpl_ol_001"><li>准备阶段：明确项目范围、实施条件、接口关系和责任分工。</li><li>实施阶段：按计划组织资源进场、现场作业、过程检查和阶段复核。</li><li>交付阶段：完成联调测试、问题整改、验收培训和资料移交。</li></ol>

<!-- yibiao:block -->
<h3 id="tpl_h_003">阶段成果要求</h3>

<!-- yibiao:block -->
<p id="tpl_p_003">每项阶段成果均明确责任人、完成时限和检查要求。项目资料与现场工作同步形成，确保过程记录真实完整、成果状态清晰可追溯。</p>

<!-- yibiao:block -->
<ul id="tpl_ul_001"><li>建立项目启动、过程检查和验收交付的闭环机制。</li><li>按周同步风险、进度和资源需求，确保实施节奏可控。</li><li>保留关键过程记录，便于后续审查和复盘。</li></ul>

<!-- yibiao:block -->
<h4 id="tpl_h_004">资料同步要求</h4>

<!-- yibiao:block -->
<p id="tpl_p_004">整理招标文件、现状资料和接口清单，随现场工作同步形成过程记录，支撑后续方案细化与成果复核。</p>

<!-- yibiao:block -->
<h5 id="tpl_h_005">记录归档要求</h5>

<!-- yibiao:block -->
<p id="tpl_p_005">按项目阶段整理归档目录、会议纪要、问题闭环记录和验收支撑材料，保证版本统一、状态可查。</p>

<!-- yibiao:block -->
<h6 id="tpl_h_006">过程复核要点</h6>

<!-- yibiao:block -->
<p id="tpl_p_006">对关键节点的确认材料、实施记录和交付清单进行复核，确保过程资料完整一致、责任可追溯。</p>

<!-- yibiao:block -->
<table id="tpl_tbl_001" data-yb-preset="headerRowAndColumn">
  <caption>项目岗位责任与协同界面</caption>
  <thead>
    <tr><th scope="col">责任岗位</th><th scope="col">核心职责</th><th scope="col">协同界面</th><th scope="col">过程记录</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">项目经理</th><td>统筹目标、资源和重大事项决策</td><td>采购人、监理及各专业负责人</td><td>会议纪要、决策清单</td></tr>
    <tr><th scope="row">技术负责人</th><td>深化设计、技术复核和接口协调</td><td>设计、设备供应与现场实施</td><td>图纸会审、技术交底</td></tr>
    <tr><th scope="row">施工负责人</th><td>作业面组织、工序穿插和资源调配</td><td>专业班组、物资设备与安全管理</td><td>施工日志、工序交接</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<h1 id="tpl_h_007">质量保障与图表展示</h1>

<!-- yibiao:block -->
<p id="tpl_p_007">质量管理贯穿项目实施全过程。我方以质量策划为先导，以样板确认和工序检查为抓手，以成果复核和问题闭环为保障，执行编制、复核、批准三级审查制度；对关键工序设置质量控制点，未经检查确认不得转入下一阶段。</p>

<!-- yibiao:block -->
<figure id="tpl_fig_001" data-yb-generation="htmlImage" data-yb-size="wide">
  <template data-yb-role="prompt">生成 3:2 横向项目全过程质量管控架构图，展示质量策划、样板确认、工序检查、成果复核、问题整改和闭环验证之间的关系；采用专业工程蓝图风格，不使用文字，仅用清晰图形、箭头和层级表达，关键内容置于画面安全区域，无水印。</template>
  <img src="${standardQualityControlUrl}" data-yb-asset-ref="assets/standard-quality-control.webp" alt="项目全过程质量管控架构图">
  <figcaption>项目全过程质量管控架构</figcaption>
</figure>

<!-- yibiao:block -->
<h2 id="tpl_h_008">图文混排与图组展示</h2>

<!-- yibiao:block -->
<table id="tpl_tbl_002" data-yb-preset="imageText">
  <caption>项目实施总控模型</caption>
  <tbody>
    <tr>
      <td><figure id="tpl_fig_002" data-yb-generation="aiImage" data-yb-size="tall"><template data-yb-role="prompt">生成 3:4 竖向大型工程项目实施总控数字孪生场景图，以轴测视角展示施工区域、临建设施、物流通道、作业分区和管理节点；主体集中在画面中央安全区域，蓝灰工程视觉，无文字、标志和水印。</template><img src="${visualMasterPlanSceneUrl}" data-yb-asset-ref="assets/visual-master-plan-scene.webp" alt="项目实施总控数字孪生场景图"><figcaption>项目实施总控场景</figcaption></figure></td>
      <td><p><strong>计划、资源、质量一体化控制</strong></p><p>以批准的合同目标和实施基线为依据，将进度安排、专业穿插、人员设备投入、材料供应及质量检查纳入统一管理。项目团队通过计划分级、动态跟踪和定期协调，及时识别影响关键节点的制约条件。</p><ol><li>按 WBS 分解工作包、责任岗位、接口条件和阶段成果。</li><li>以合同节点和关键里程碑为牵引，逐级落实月度和周作业计划。</li><li>结合作业强度配置人员、机械及材料，避免资源闲置或投入不足。</li></ol></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="tpl_tbl_003" data-yb-preset="threeImages">
  <caption>质量、工作分解与技术架构</caption>
  <tbody>
    <tr>
      <td><figure id="tpl_fig_003" data-yb-generation="htmlImage" data-yb-size="square"><template data-yb-role="prompt">生成 1:1 方形全过程质量控制闭环信息图，展示输入审查、样板确认、工序检查、问题整改、复核销项和持续改进的循环关系；采用专业蓝白信息图风格，不使用文字，仅用图标、节点和箭头表达，无水印。</template><img src="${visualQualityClosedLoopUrl}" data-yb-asset-ref="assets/visual-quality-closed-loop.webp" alt="全过程质量控制闭环信息图"><figcaption>全过程质量控制闭环</figcaption></figure></td>
      <td><figure id="tpl_fig_004" data-yb-generation="mermaid" data-yb-size="square"><template data-yb-role="prompt">生成 1:1 方形项目工作分解结构思维导图，以项目目标为中心，向外展开项目管理、深化设计、采购供应、现场实施、调试验收和资料移交六个一级分支；不使用文字，仅用层级色块、图标和连线表达，无水印。</template><img src="${visualWbsMindmapUrl}" data-yb-asset-ref="assets/visual-wbs-mindmap.webp" alt="项目工作分解结构思维导图"><figcaption>WBS 工作分解结构</figcaption></figure></td>
      <td><figure id="tpl_fig_005" data-yb-generation="htmlImage" data-yb-size="square"><template data-yb-role="prompt">生成 1:1 方形项目技术架构图，分层展示基础设施层、设备接入层、数据传输层、平台服务层和业务应用层，体现上下行数据流和安全边界；采用专业蓝图风格，不使用文字，仅用模块、图标和连线表达，无水印。</template><img src="${visualTechnicalArchitectureUrl}" data-yb-asset-ref="assets/visual-technical-architecture.webp" alt="项目分层技术架构图"><figcaption>分层技术架构</figcaption></figure></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="tpl_tbl_004" data-yb-preset="plain">
  <caption>重点风险分级响应要点</caption>
  <tbody>
    <tr><th scope="row">计划偏差</th><td>核对关键路径和剩余工作量，优先通过作业面释放、资源增补和工序穿插追回节点。</td></tr>
    <tr><th scope="row">质量缺陷</th><td>立即标识隔离并分析原因，明确整改责任、完成时限和复核标准，未经销项不得转序。</td></tr>
    <tr><th scope="row">供应异常</th><td>联动设计、采购和施工专业评估影响，启动催交、替代或调整施工顺序的处置方案。</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="tpl_p_008">我方将以明确的组织体系、可执行的进度计划和严格的质量控制措施保障项目顺利实施，并接受采购人对全过程工作的监督与考核。</p>`;

/**
 * 核心模板：供后续正文生成链路使用，删除全部标题块且图片不含 src。
 * 与展示模板成对维护，本次合并未修改其内容。
 */
export const DOCUMENT_CORE_TEMPLATE_HTML = `<!-- yibiao:block -->
<p id="std_p_001">我方充分理解本项目建设目标和招标要求，将坚持<strong>统筹规划、分步实施、质量受控、服务持续</strong>的原则，建立覆盖准备、实施、检查、验收和运维支持的全过程管理体系。</p>

<!-- yibiao:block -->
<p id="std_p_002">项目实施以采购人需求为中心，由项目经理统一协调人员、进度、质量与沟通工作。各专业负责人按照批准的实施计划组织作业，重要事项及时报告，阶段成果经内部复核后提交确认，确保工作边界清晰、责任落实到人。</p>

<!-- yibiao:block -->
<p id="std_p_003">项目启动后，我方首先完成现场条件核查、需求确认和接口梳理，并据此细化工作计划。进入实施阶段后，严格执行技术交底、过程检查和问题闭环制度；在交付阶段完成联调测试、用户培训、成果验收及资料移交。</p>

<!-- yibiao:block -->
<p id="std_p_004">各阶段工作坚持“先确认、后实施，先检查、后转序”的原则。未经确认的需求不擅自变更，未经检查的成果不进入下一环节，以此减少返工并保障总体工期。</p>

<!-- yibiao:block -->
<ol id="std_ol_001"><li>准备阶段：明确项目范围、实施条件、接口关系和责任分工。</li><li>实施阶段：按计划组织资源进场、现场作业、过程检查和阶段复核。</li><li>交付阶段：完成联调测试、问题整改、验收培训和资料移交。</li></ol>

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
<p id="std_p_009">项目交付后，我方继续提供技术咨询、故障处理和定期回访服务。服务事项形成完整记录，处理结果及时反馈采购人，确保项目成果稳定运行并持续发挥效益。</p>

<!-- yibiao:block -->
<p id="std_p_010">我方将以明确的组织体系、可执行的进度计划和严格的质量控制措施保障项目顺利实施，并接受采购人对全过程工作的监督与考核。</p>`;

/** 正文生成时描述本模板排版要求的指导语。 */
export const DOCUMENT_TEMPLATE_GUIDANCE = '按照竖版 A4 单栏正文组织内容。以标题、连续段落和少量列表为主，只在需要对比或归纳时使用标准表格；图片少量穿插并独立排版，图例紧贴图片下方，不把图片嵌入表格。';
