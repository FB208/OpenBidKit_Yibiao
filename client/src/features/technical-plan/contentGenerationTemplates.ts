export interface ContentGenerationTemplateDefinition {
  id: string;
  name: string;
  description: string;
  recommendation: string;
  guidance: string;
  htmlExample: string;
}

/** 实际正文模板注册表；htmlExample 不保存仅供 Renderer 展示的预览图片地址。 */
export const contentGenerationTemplates = [
  {
    id: 'standard-document',
    name: '标准投标文档',
    description: '以正式文字论述为主，辅以少量标准表格和独立图片，适合常规投标文件。',
    recommendation: 'A4 竖版下效果最佳',
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
    description: '采用左右双列组织高密度图文，以表格、图组和重点说明快速呈现方案。',
    recommendation: 'A3 横版下效果最佳',
    guidance: '按照横版 A3 双列阅读顺序组织内容，先读左列再读右列；每列独立组合标题、正文、标准表格、图文表格和图组，不设计跨栏、浮动、叠加等受限 HTML 未提供的版式。所有图片必须放在表格单元格内并提供图例，单列内容宽度按竖版 A4 正文区域设计。',
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
      <td><figure id="visual_fig_001" data-yb-generation="aiImage" data-yb-size="tall"><template data-yb-role="prompt">生成 3:4 竖向大型工程项目实施总控数字孪生场景图，以轴测视角展示施工区域、临建设施、物流通道、作业分区和管理节点；主体集中在画面中央安全区域，蓝灰工程视觉，无文字、标志和水印，适合 A3 横版双列页面的单列栏宽。</template><img alt="项目实施总控数字孪生场景图"><figcaption>项目实施总控场景</figcaption></figure></td>
      <td><p><strong>计划、资源、质量一体化控制</strong></p><p>以批准的合同目标和实施基线为依据，将进度安排、专业穿插、人员设备投入、材料供应及质量检查纳入统一管理。项目团队通过计划分级、动态跟踪和定期协调，及时识别影响关键节点的制约条件，确保各项资源与现场作业需求准确匹配。</p><ol><li>按 WBS 分解工作包、责任岗位、接口条件和阶段成果，形成可执行、可检查的任务清单。</li><li>以合同节点和关键里程碑为牵引，建立总体计划、月度计划和周作业计划逐级落实机制。</li><li>结合施工区域、专业工序和作业强度配置人员、机械及材料，避免资源闲置或投入不足。</li><li>持续对比计划进度与实际完成量，对偏差事项明确原因、责任人、纠正措施和完成时限。</li><li>通过样板确认、工序检查、质量门控制和问题台账复核，实现质量问题全过程闭环销项。</li></ol></td>
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
<table id="visual_tbl_009" data-yb-preset="headerRow">
  <caption>关键里程碑控制清单</caption>
  <thead>
    <tr><th scope="col">控制节点</th><th scope="col">前置条件</th><th scope="col">完成标志</th><th scope="col">责任专业</th></tr>
  </thead>
  <tbody>
    <tr><td>深化设计冻结</td><td>需求、现场和接口资料完成复核</td><td>深化成果通过联合会审</td><td>技术管理组</td></tr>
    <tr><td>首批设备到场</td><td>排产、检验、运输条件全部落实</td><td>开箱验收合格并完成入库</td><td>物资设备组</td></tr>
    <tr><td>系统联动完成</td><td>单机调试和专业接口检查完成</td><td>试运行记录经各方确认</td><td>调试验收组</td></tr>
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
      <td><figure id="visual_fig_006" data-yb-generation="mermaid" data-yb-size="panorama"><template data-yb-role="prompt">生成 16:9 横向工程项目组织架构图，以项目经理部为核心，下设技术管理、工程实施、质量安全、物资设备和资料交付五个专业组，并体现汇报与协同关系；不使用文字，仅用人物图标、层级节点和连接线表达，关键内容置于画面安全区域，无水印。</template><img alt="工程项目组织架构图"><figcaption>项目组织架构</figcaption></figure></td>
      <td><figure id="visual_fig_007" data-yb-generation="aiImage" data-yb-size="panorama"><template data-yb-role="prompt">生成 16:9 横向工程项目设备与工器具配置专业轴测图，分区展示运输吊装、安装加工、检测调试和安全防护四类资源，器材摆放有序；关键内容置于画面安全区域，蓝灰工程视觉，无文字、品牌和水印。</template><img alt="工程设备与工器具配置轴测图"><figcaption>设备资源配置</figcaption></figure></td>
    </tr>
    <tr>
      <td><figure id="visual_fig_008" data-yb-generation="aiImage" data-yb-size="panorama"><template data-yb-role="prompt">生成 16:9 横向复杂工程现场多专业协同实施剖切场景图，展示结构、机电、管线和设备安装在不同作业面有序穿插，具备真实工程细节；关键内容置于画面安全区域，专业工程可视化风格，无文字、品牌和水印。</template><img alt="多专业协同现场实施剖切场景图"><figcaption>多专业协同实施</figcaption></figure></td>
      <td><figure id="visual_fig_009" data-yb-generation="htmlImage" data-yb-size="panorama"><template data-yb-role="prompt">生成 16:9 横向项目验收与移交流程图，展示专业自检、联合预验收、问题整改、正式验收、资料归档和运维移交的顺序及反馈闭环；采用专业蓝白流程图风格，不使用文字，仅用图标、节点和箭头表达，关键内容置于画面安全区域，无水印。</template><img alt="项目验收与移交流程图"><figcaption>验收与移交闭环</figcaption></figure></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_007" data-yb-preset="headerRowAndColumn">
  <caption>项目岗位责任与协同界面</caption>
  <thead>
    <tr><th scope="col">责任岗位</th><th scope="col">核心职责</th><th scope="col">协同界面</th><th scope="col">过程记录</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">项目经理</th><td>统筹目标、资源和重大事项决策</td><td>采购人、监理及各专业负责人</td><td>会议纪要、决策清单</td></tr>
    <tr><th scope="row">技术负责人</th><td>深化设计、技术复核和接口协调</td><td>设计、设备供应与现场实施</td><td>图纸会审、技术交底</td></tr>
    <tr><th scope="row">施工负责人</th><td>作业面组织、工序穿插和资源调配</td><td>专业班组、物资设备与安全管理</td><td>施工日志、工序交接</td></tr>
    <tr><th scope="row">质量安全负责人</th><td>检查验收、风险排查和整改复核</td><td>各专业责任人及验收参与方</td><td>检查表、整改闭环单</td></tr>
    <tr><th scope="row">资料负责人</th><td>过程资料同步、成果归档和移交</td><td>技术、质量、采购与运维团队</td><td>资料台账、移交清单</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_008" data-yb-preset="imageText">
  <caption>质量安全联合检查机制</caption>
  <tbody>
    <tr>
      <td><figure id="visual_fig_010" data-yb-generation="htmlImage" data-yb-size="wide"><template data-yb-role="prompt">生成 3:2 横向工程项目质量安全联合检查流程信息图，依次体现策划检查、样板确认、工序巡检、问题登记、整改复核和闭环归档；采用专业蓝白工程图标风格，不使用文字，仅用图标、节点和箭头表达，关键内容置于画面安全区域，无水印。</template><img alt="质量安全联合检查流程信息图"><figcaption>质量安全联合检查闭环</figcaption></figure></td>
      <td><p><strong>检查、整改、复核同步推进</strong></p><p>围绕高风险作业、关键工序和隐蔽工程设置联合检查点，形成责任到人、时限明确、证据完整的闭环记录。</p><ul><li>作业前核对条件与风险措施。</li><li>作业中记录实测结果和影像证据。</li><li>整改后由责任专业复核销项。</li></ul></td>
    </tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_014" data-yb-preset="headerRow">
  <caption>现场联合检查安排</caption>
  <thead>
    <tr><th scope="col">检查类型</th><th scope="col">组织频次</th><th scope="col">检查重点</th><th scope="col">闭环要求</th></tr>
  </thead>
  <tbody>
    <tr><td>日常巡检</td><td>每日作业前后</td><td>作业条件、防护状态、工序质量</td><td>当日登记、当日整改</td></tr>
    <tr><td>专项检查</td><td>每周及重要节点前</td><td>高风险作业、临时用电、机械设备</td><td>责任到人、限期复核</td></tr>
    <tr><td>联合验收</td><td>隐蔽及转序前</td><td>实测数据、影像资料、接口条件</td><td>各方签认后转序</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_010" data-yb-preset="plain">
  <caption>重点风险分级响应要点</caption>
  <tbody>
    <tr><th scope="row">计划偏差</th><td>核对关键路径和剩余工作量，优先通过作业面释放、资源增补和工序穿插追回节点。</td></tr>
    <tr><th scope="row">质量缺陷</th><td>立即标识隔离并分析原因，明确整改责任、完成时限和复核标准，未经销项不得转序。</td></tr>
    <tr><th scope="row">安全风险</th><td>暂停相关作业，重新核验防护条件和专项措施，完成交底确认后方可恢复施工。</td></tr>
    <tr><th scope="row">供应异常</th><td>联动设计、采购和施工专业评估影响，启动催交、替代或调整施工顺序的处置方案。</td></tr>
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
    <tr><td>资源基线</td><td>劳动力平衡、设备调度、材料到货与作业面匹配</td><td>资源计划、进场验收、调配记录</td></tr>
    <tr><td>安全基线</td><td>风险辨识、班前交底、旁站巡检与应急响应</td><td>风险清单、巡检记录、演练记录</td></tr>
    <tr><td>交付基线</td><td>实物验收、资料同步、培训移交与质保响应</td><td>验收文件、移交清单、培训记录</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="visual_p_002">通过总控场景、管理图表、工程架构和交付流程的组合表达，使计划逻辑、责任关系、技术路径和成果边界能够快速识别。项目团队以批准的管理基线为共同执行依据，将计划更新、现场记录、检查结论和交付成果同步纳入履约台账，确保各阶段工作过程可查、结果可验、责任可追溯。</p>

<!-- yibiao:block -->
<table id="visual_tbl_011" data-yb-preset="headerRow">
  <caption>阶段成果编制与交付清单</caption>
  <thead>
    <tr><th scope="col">实施阶段</th><th scope="col">主要成果</th><th scope="col">审核要求</th><th scope="col">交付状态</th></tr>
  </thead>
  <tbody>
    <tr><td>准备阶段</td><td>实施策划、组织职责、总体计划</td><td>项目经理组织内部评审</td><td>批准后执行</td></tr>
    <tr><td>深化阶段</td><td>深化图纸、接口清单、材料计划</td><td>专业复核并完成联合会审</td><td>确认后冻结</td></tr>
    <tr><td>实施阶段</td><td>施工记录、检查记录、变更资料</td><td>与现场进度同步形成</td><td>按周归档</td></tr>
    <tr><td>验收阶段</td><td>调试报告、竣工资料、移交清单</td><td>完整性和一致性联合审查</td><td>签认后移交</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="visual_p_003">各项成果实行<strong>编制、复核、批准、发布</strong>四级状态管理。正式版本统一编号，变更内容注明原因、影响范围和替换关系；现场使用文件与资料台账保持一致，避免错版、漏项和过程资料滞后。</p>

<!-- yibiao:block -->
<table id="visual_tbl_012" data-yb-preset="headerRowAndColumn">
  <caption>验收移交任务与责任分工</caption>
  <thead>
    <tr><th scope="col">验收任务</th><th scope="col">实施要点</th><th scope="col">参加单位</th><th scope="col">确认成果</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">实物核验</th><td>核对数量、位置、标识和安装质量</td><td>采购人、监理、施工团队</td><td>实物核验记录</td></tr>
    <tr><th scope="row">功能验收</th><td>按场景完成单项及联动测试</td><td>使用部门、技术与调试团队</td><td>测试报告</td></tr>
    <tr><th scope="row">资料审查</th><td>检查完整性、准确性和版本一致性</td><td>资料、质量及各专业负责人</td><td>资料审查表</td></tr>
    <tr><th scope="row">培训移交</th><td>完成操作培训、维护交底和权限交接</td><td>运维人员、项目实施团队</td><td>培训及移交记录</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_015" data-yb-preset="headerRow">
  <caption>现场施工部署与作业面安排</caption>
  <thead>
    <tr><th scope="col">作业阶段</th><th scope="col">施工组织</th><th scope="col">质量安全控制</th><th scope="col">阶段成果</th></tr>
  </thead>
  <tbody>
    <tr><td>作业准备</td><td>完成现场复核、测量放线、临设布置和进场交底</td><td>核验人员资质、设备状态及防护条件</td><td>开工条件确认单</td></tr>
    <tr><td>样板实施</td><td>选择典型区域完成首件施工，统一工艺和验收尺度</td><td>样板未经联合确认不得展开批量作业</td><td>样板验收记录</td></tr>
    <tr><td>分区施工</td><td>按照区域、楼层和专业划分流水段，落实日任务清单</td><td>执行工序交接、旁站检查和实测实量</td><td>施工日志与检查表</td></tr>
    <tr><td>联调收尾</td><td>统筹单机测试、系统联动、缺陷整改和成品保护</td><td>逐项核对功能、标识、资料及使用条件</td><td>完工确认清单</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="visual_p_006">现场实施坚持<strong>先条件确认、后工序展开，先样板验证、后批量施工</strong>。项目经理部根据场地移交、材料到货和专业接口情况动态释放作业面，通过日碰头、周协调和节点复盘及时解决交叉作业冲突，使施工节奏与总体计划保持一致。</p>

<!-- yibiao:block -->
<table id="visual_tbl_016" data-yb-preset="headerRowAndColumn">
  <caption>人员、设备与材料资源投入计划</caption>
  <thead>
    <tr><th scope="col">资源类别</th><th scope="col">配置原则</th><th scope="col">投入节点</th><th scope="col">动态控制</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">管理人员</th><td>项目经理及技术、施工、质量、安全专岗到位</td><td>开工准备阶段</td><td>按专业界面明确授权和替补人员</td></tr>
    <tr><th scope="row">专业班组</th><td>依据作业量、流水段和计划峰值配置熟练人员</td><td>作业面释放前</td><td>按周平衡工种数量和进退场时间</td></tr>
    <tr><th scope="row">机械工器具</th><td>满足运输、吊装、安装、检测和调试需要</td><td>相应工序开始前</td><td>建立使用、保养、检定和调拨台账</td></tr>
    <tr><th scope="row">材料设备</th><td>结合深化成果和安装顺序分批采购、分区堆放</td><td>计划使用前到场</td><td>跟踪排产、催交、验收和库存状态</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_017" data-yb-preset="headerColumn">
  <caption>绿色施工与文明现场控制措施</caption>
  <tbody>
    <tr><th scope="row">现场环境</th><td>施工区域实行围挡、标识和定置管理；易产生扬尘、噪声的作业采取覆盖、吸尘、降噪和时段控制措施。</td></tr>
    <tr><th scope="row">临时用电</th><td>配电设施分级设置并定期检查，移动机具执行使用前确认，电缆跨越通道时设置可靠防护。</td></tr>
    <tr><th scope="row">材料管理</th><td>材料按专业、规格和使用顺序分类码放，设置防潮、防碰撞措施，剩余材料及时清点退库。</td></tr>
    <tr><th scope="row">废弃物管理</th><td>包装物、边角料和施工垃圾分类收集、日产日清，危险废弃物单独存放并按规定移交处置。</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_018" data-yb-preset="headerRow">
  <caption>异常事件应急处置程序</caption>
  <thead><tr><th scope="col">异常场景</th><th scope="col">先期处置</th><th scope="col">恢复条件</th></tr></thead>
  <tbody>
    <tr><td>现场险情</td><td>立即停工、隔离区域、组织人员撤离并上报现场负责人</td><td>风险消除且安全条件复核通过</td></tr>
    <tr><td>设备故障</td><td>切断相关能源，保护故障状态，联系专业人员检查处理</td><td>维修试运行正常并形成处置记录</td></tr>
    <tr><td>质量事件</td><td>停止后续工序，标识隔离问题范围，组织原因和影响分析</td><td>整改方案批准且复验结果合格</td></tr>
    <tr><td>供应中断</td><td>核实库存和到货计划，评估关键路径，启动催交或替代方案</td><td>资源重新匹配且计划调整获确认</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<table id="visual_tbl_013" data-yb-preset="headerColumn">
  <caption>履约服务与运维响应机制</caption>
  <tbody>
    <tr><th scope="row">问题受理</th><td>设置统一联系人和问题台账，完整记录提出时间、影响范围、责任专业及期望完成时间。</td></tr>
    <tr><th scope="row">分级响应</th><td>按照一般、重要和紧急三级组织响应，影响安全、运行或关键节点的问题优先处理。</td></tr>
    <tr><th scope="row">现场处置</th><td>责任人员到场核查原因，形成临时控制措施和正式解决方案，并持续反馈处理进度。</td></tr>
    <tr><th scope="row">复盘预防</th><td>完成效果验证和经验总结，将共性问题转化为检查项、交底要点或标准作业要求。</td></tr>
    <tr><th scope="row">运维跟踪</th><td>移交设备台账、备品备件和维护要点，通过回访、巡检及运行分析跟踪遗留事项并提出改进建议。</td></tr>
  </tbody>
</table>

<!-- yibiao:block -->
<p id="visual_p_004"><strong>项目交付并非实施工作的终点。</strong>在质量保证期内，项目团队持续跟踪设施运行状态、用户反馈和遗留事项，定期复核问题闭环情况；对影响正常使用的事项快速组织技术、设备和现场力量联合处理，保障项目成果稳定发挥效益。</p>
`,
  },
] as const satisfies readonly ContentGenerationTemplateDefinition[];

export type ContentGenerationTemplateId = typeof contentGenerationTemplates[number]['id'];

export const DEFAULT_CONTENT_GENERATION_TEMPLATE_ID: ContentGenerationTemplateId = 'standard-document';

/** 获取可用模板；未知 ID 回到默认模板。 */
export function getContentGenerationTemplate(value: unknown) {
  return contentGenerationTemplates.find((template) => template.id === value) || contentGenerationTemplates[0];
}
