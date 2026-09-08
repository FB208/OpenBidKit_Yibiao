/**
 * 骨架 → AI 指令 → 受限 HTML 组装。
 *
 * 下发给 AI 的只有块清单和字数区间：不出现厘米、行数、页码和任何排版词汇，
 * 版面知识全部留在程序侧。AI 负责写内容和配图提示词，程序负责补尺寸属性。
 */
import type { SkeletonBlock, SkeletonPlan } from './sectionSkeleton';
import { resolveFigureSize } from './sectionSkeleton';
import { DEFAULT_FIGURE_FIT, FIGURE_GEOMETRY } from './pageMetrics';
import type { FigureFit, FigureGeneration, FigureSize } from './pageMetrics';

/**
 * 占位图：本测试只验证版面，而版面只取决于画框尺寸，与图里画了什么无关，
 * 所以这里不接生图链路，直接借模板样张那几张图占位。
 * C# 侧按画框比例居中裁切，任意一张都能填进任意画框；按图序轮换，
 * 免得同一节里几张图长得一模一样，看起来像没生成。
 */
const PLACEHOLDER_ASSETS = [
  'assets/standard-quality-control.webp',
  'assets/visual-wbs-mindmap.webp',
  'assets/visual-technical-architecture.webp',
  'assets/visual-quality-closed-loop.webp',
  'assets/visual-master-plan-scene.webp',
];

const SHAPE_HINT: Record<FigureSize, string> = {
  tall: 'tall（竖版 3:4，适合自上而下的流程、分层结构）',
  square: 'square（方形 1:1，适合闭环、矩阵、九宫格）',
  wide: 'wide（横版 3:2，适合左右流向、并列对比）',
  panorama: 'panorama（宽幅 16:9，适合长横向时间轴、全景架构）',
};

const ROLE_HINT: Record<string, string> = {
  lead: '开篇，点明本节要解决什么问题',
  body: '主体论述，展开具体做法',
  bridge: '承接过渡，把上文的做法引向下文',
  close: '收束，说明成效或与后续工作的衔接',
};

/**
 * 把骨架写成逐条对照的块清单。
 *
 * forAi 时跳过标题块：标题由程序用小节标题直接拼出来，正文生成阶段只写正文。
 * 标题仍然留在骨架里，因为它照样占版面高度，装箱必须算上它。
 */
export function describeSkeleton(blocks: SkeletonBlock[], forAi = false) {
  const visible = forAi ? blocks.filter((block) => block.kind !== 'heading') : blocks;
  return visible.map((block, index) => {
    const order = index + 1;
    switch (block.kind) {
      case 'heading':
        return `${order}. 标题块（h${block.level}，由程序输出）：${block.text}`;
      case 'paragraph':
        return `${order}. 段落块 ${block.id}：${block.minChars}-${block.maxChars} 字，${ROLE_HINT[block.role] || '主体论述'}`;
      case 'list':
        return `${order}. ${block.ordered ? '有序' : '无序'}列表块 ${block.id}：${block.items} 项，每项 ${block.charsPerItem} 字左右`;
      case 'figure':
        return `${order}. 独立配图块 ${block.id}：建议用 ${block.suggestedGeneration}（内容明显不适合可改）；`
          + `可选画框 ${block.allowedSizes.map((size) => SHAPE_HINT[size]).join('、')}`;
      case 'imageText':
        return `${order}. 图文混排块 ${block.id}：左图右文的两栏表格。`
          + `左格放一张配图（id 用 ${block.figureId}，建议 ${block.suggestedGeneration}，`
          + `画框固定用 ${block.size}，不要改），`
          + `右格写 ${block.minChars}-${block.maxChars} 字说明这张图表达的做法；`
          + `${block.maxChars} 字是硬上限，超过会把这一行撑高、顶到下一页留出空白`;
      case 'figureGroup':
        return `${order}. 并列图组块 ${block.id}：${block.count === 3 ? '一行三列' : '两行两列四宫格'}，`
          + `${block.count} 张同一主题下互相并列的图（id 依次用 ${block.figureIds.join('、')}，`
          + `建议 ${block.suggestedGeneration}，画框统一用 ${block.allowedSizes[0]}）`;
      case 'table':
        return `${order}. 数据表格块 ${block.id}：${block.preset} 预设，`
          + `${block.cols} 列 ${block.rows} 行数据${block.hasHeader ? '加一行表头' : ''}，`
          + `用来归纳可对比的事实，不要把正文段落塞进表格`;
      default:
        return `${order}. 未知块`;
    }
  }).join('\n');
}

export interface SkeletonPromptContext {
  projectName: string;
  projectOverview: string;
  sectionPath: string;
  sectionTitle: string;
  sectionDescription: string;
  globalFacts: string;
}

export function buildSkeletonSystemPrompt() {
  return `你是投标文件正文撰写助手，只输出受限 HTML 正文流。

输出格式：
- 每个块前面单独一行 <!-- yibiao:block --> 注释，块与块之间空一行。
- 只允许这些标签：p、ol、ul、li、figure、img、figcaption、template、table、caption、thead、tbody、tr、th、td；
  行内只允许 strong、em、u、sup、sub、br。
- 不输出 style、class、CSS、宽高、颜色、对齐、分页信息，不输出 markdown 代码围栏。
- 每个块元素带一个 id 属性，用给定的块编号，例如 <p id="p1">。
- 不要输出任何标题（h1-h6）。本节标题由程序用目录里的小节标题直接拼出来，你只写正文。

配图块的写法：
<!-- yibiao:block -->
<figure id="fig1" data-yb-generation="生成方式" data-yb-size="画框">
  <template data-yb-role="prompt">这里写配图生成提示词，说清楚画什么、有哪些节点和关系</template>
  <img alt="图片内容的简短描述">
  <figcaption>图例文字</figcaption>
</figure>

data-yb-generation 三选一，按这张图真正该画什么来选，不要固定用同一种：
- mermaid：有明确先后或从属关系的流程图、层级图、职责关系图；
- htmlImage：组织架构、矩阵、看板、指标卡、架构拓扑这类需要排版的信息图；
- aiImage：施工现场、设备、环境、实施场景这类需要写实画面的效果图。
一节里有多张图时，尽量让它们用不同的生成方式，不要全用同一种。

data-yb-size 从块清单为该图列出的可选画框里挑一个，按内容的自然形状选：
自上而下的长流程用竖版，左右流向或并列对比用横版，闭环和矩阵用方形。

图文混排块（左图右文）的写法：
<!-- yibiao:block -->
<table id="mix1" data-yb-preset="imageText">
  <caption>这一块的小标题</caption>
  <tbody>
    <tr>
      <td><figure id="fig2" data-yb-generation="htmlImage" data-yb-size="tall">…同上…</figure></td>
      <td><p><strong>一句话要点</strong></p><p>结合左图展开的说明文字</p></td>
    </tr>
  </tbody>
</table>

并列图组块的写法（三列用 threeImages，四宫格用 fourImages，四宫格写两行两列）：
<!-- yibiao:block -->
<table id="grp1" data-yb-preset="threeImages">
  <caption>这一组图的总标题</caption>
  <tbody>
    <tr>
      <td><figure id="fig3" …>…</figure></td>
      <td><figure id="fig4" …>…</figure></td>
      <td><figure id="fig5" …>…</figure></td>
    </tr>
  </tbody>
</table>
一组图必须是同一主题下互相并列、可比较的几个侧面，不要凑数；
组里每张图都必须有自己的 figcaption，整组再有一个 caption 作为总标题。
图文混排块的左图不需要 figcaption。

数据表格块的写法（preset 用块清单指定的那个）：
<!-- yibiao:block -->
<table id="tbl1" data-yb-preset="headerRow">
  <caption>表题</caption>
  <thead><tr><th scope="col">列名</th>…</tr></thead>
  <tbody><tr><td>单元格</td>…</tr></tbody>
</table>
headerRow 只有表头行；headerColumn 只有首列表头，首列写成 <th scope="row">；
headerRowAndColumn 两者都有。表格用来归纳可对比的事实，每格控制在 20 字以内。

硬性要求：
- 一节正文可能分几批写。块清单永远给完整的那一份，但你每次只输出标了"本批要写"的块，
  其余的块一个都不要输出。本批之内块的数量、顺序、类型都不能改。
- 每个段落块的字数必须落在给定区间内，这是硬指标。中文按字符计。
- 配图块前后必须各有正文块，绝不允许两个配图块相邻。
- 只输出 HTML，不要任何解释、前言或结语。`;
}

export function buildSkeletonUserPrompt(plan: SkeletonPlan, context: SkeletonPromptContext) {
  const facts = context.globalFacts.trim();
  return `# 项目信息
项目名称：${context.projectName || '（未填写）'}
${context.projectOverview ? `项目概述：${context.projectOverview}` : ''}

# 本节位置
${context.sectionPath}
本节标题：${context.sectionTitle}
${context.sectionDescription ? `本节说明：${context.sectionDescription}` : ''}

${facts ? `# 本节须遵守的事实设定\n${facts}\n` : ''}
# 块清单（严格按此输出，标题不在其中，由程序补）
${describeSkeleton(plan.blocks, true)}

正文合计约 ${plan.plannedChars} 字。请按块清单逐块撰写专业、具体、可执行的投标正文，避免空话套话。`;
}

/** 从模型返回里剥掉代码围栏和多余说明，只留 HTML。 */
export function extractHtml(raw: string) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const first = body.search(/<(?:!--\s*yibiao:block|h[1-6]|p|ol|ul|figure|table)\b/i);
  return first > 0 ? body.slice(first).trim() : body;
}

export interface AssembleResult {
  html: string;
  /** 程序补齐的属性数量，用于确认组装确实生效。 */
  patchedFigures: number;
  /** 模型多写、被程序剥掉的标题数；正常应为 0。 */
  strippedHeadings: number;
  /** AI 实际产出的块与骨架的对照。 */
  blockDiff: { expected: number; actual: number; figureExpected: number; figureActual: number };
  /** 每张图的规格与模型写好的提示词，交给生图环节直接用。 */
  figures: AssembledFigure[];
}

/** 模型写的生成方式；没写或写歪了返回 undefined，交给骨架的建议值兜底。 */
function normalizeGeneration(value: string | null): FigureGeneration | undefined {
  const text = String(value || '').trim();
  return text === 'aiImage' || text === 'htmlImage' || text === 'mermaid' ? text : undefined;
}

/** 模型写的画框；写歪了返回 undefined，交给版面挑默认值。 */
function normalizeSize(value: string | null): FigureSize | undefined {
  const text = String(value || '').trim() as FigureSize;
  return text in FIGURE_GEOMETRY ? text : undefined;
}

export interface AssembledFigure {
  id: string;
  size: FigureSize;
  /** 模型原本想要的画框；与 size 不同就说明被版面降级了。 */
  requestedSize?: FigureSize;
  downgraded: boolean;
  generation: FigureGeneration;
  fit: FigureFit;
  prompt: string;
  caption: string;
  alt: string;
  /** 画框比例，生图环节按它定画布或裁切。 */
  aspectWidth: number;
  aspectHeight: number;
}

/**
 * 把 AI 产出的 HTML 补成可渲染的受限 HTML：按骨架顺序给每个 figure
 * 补 data-yb-size 和占位图引用。尺寸是版面规划的结果，绝不交给模型决定。
 */
export function assembleRestrictedHtml(
  rawHtml: string,
  plan: SkeletonPlan,
  /** 真实生成好的配图，按块 id 索引；缺的那张退回占位图。 */
  assetRefs: Record<string, string> = {},
): AssembleResult {
  const html = extractHtml(rawHtml);
  const parser = new DOMParser();
  const document = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  // 标题归程序：模型即使写了也剥掉，避免和程序拼的标题重复。
  let strippedHeadings = 0;
  for (const heading of Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    heading.remove();
    strippedHeadings += 1;
  }

  // 图现在可能藏在图文混排和图组表格里，按文档顺序一起收；
  // 骨架里每个图位也按同样的顺序展开，两边就能一一对上。
  const figures = Array.from(document.body.querySelectorAll('figure'));
  const planned = plan.blocks.flatMap((block) => {
    if (block.kind === 'figure') {
      return [{ id: block.id, allowedSizes: block.allowedSizes, suggested: block.suggestedGeneration }];
    }
    if (block.kind === 'imageText') {
      // 画框是版面定死的，这里只给一个候选，模型写别的会被换回来。
      return [{ id: block.figureId, allowedSizes: [block.size], suggested: block.suggestedGeneration }];
    }
    if (block.kind === 'figureGroup') {
      return block.figureIds.map((id) => ({
        id,
        allowedSizes: block.allowedSizes,
        suggested: block.suggestedGeneration,
      }));
    }
    return [];
  });

  let patched = 0;
  const assembledFigures: AssembledFigure[] = [];
  figures.forEach((figure, index) => {
    const spec = planned[index];
    if (!spec) return;
    const asset = assetRefs[spec.id] || PLACEHOLDER_ASSETS[index % PLACEHOLDER_ASSETS.length];

    // 生成方式听模型的，它没写或写歪了就用骨架轮转分配的那种。
    const generation = normalizeGeneration(figure.getAttribute('data-yb-generation')) || spec.suggested;
    // 画框也听模型的，但要过版面这一关：超出高度预算就降到最接近的可用画框。
    const wanted = normalizeSize(figure.getAttribute('data-yb-size'));
    const { size, downgraded } = resolveFigureSize(wanted, spec.allowedSizes);
    // 流程图和信息图一个像素都不能切，实景照片才走裁切。
    const fit: FigureFit = DEFAULT_FIGURE_FIT[generation];
    const geometry = FIGURE_GEOMETRY[size];

    assembledFigures.push({
      id: spec.id,
      size,
      requestedSize: wanted,
      downgraded,
      generation,
      fit,
      // template 的文字挂在 content 这个 fragment 上，元素自身的 textContent 恒为空，
      // 直接读元素会把模型写的详细配图要求整份丢掉。口径与 restrictedHtml 的校验保持一致。
      prompt: figure.querySelector('template')?.content.textContent?.trim() || '',
      caption: figure.querySelector('figcaption')?.textContent?.trim() || '',
      alt: figure.querySelector('img')?.getAttribute('alt') || '',
      aspectWidth: geometry.aspectWidth,
      aspectHeight: geometry.aspectHeight,
    });

    figure.setAttribute('data-yb-size', size);
    figure.setAttribute('data-yb-generation', generation);
    figure.setAttribute('data-yb-fit', fit);
    figure.setAttribute('id', spec.id);
    const image = figure.querySelector('img');
    if (image) {
      image.setAttribute('data-yb-asset-ref', asset);
      image.setAttribute('src', asset);
    }
    patched += 1;
  });

  // 渲染器按 <!-- yibiao:block --> 分块，AI 偶尔会漏写，这里按顶层元素补齐。
  const bodyBlocks = Array.from(document.body.children)
    .map((element) => `<!-- yibiao:block -->\n${element.outerHTML}`);

  // 标题块由程序用小节标题拼出来，放在正文最前面。
  const headingSpec = plan.blocks.find((block) => block.kind === 'heading') as
    Extract<SkeletonBlock, { kind: 'heading' }> | undefined;
  const headingHtml = headingSpec
    ? `<!-- yibiao:block -->\n<h${headingSpec.level} id="${headingSpec.id}">${escapeText(headingSpec.text)}</h${headingSpec.level}>`
    : '';

  const serialized = [headingHtml, ...bodyBlocks].filter(Boolean).join('\n\n');

  return {
    html: serialized,
    patchedFigures: patched,
    strippedHeadings,
    figures: assembledFigures,
    blockDiff: {
      // 骨架里的标题块由程序补，模型只需交出其余的块。
      expected: plan.blocks.filter((block) => block.kind !== 'heading').length,
      actual: document.body.children.length,
      // planned 已经把图组和图文混排里的图位展开了。
      figureExpected: planned.length,
      figureActual: figures.length,
    },
  };
}

/** 小节标题是纯文本，进 HTML 前转义，避免标题里的尖括号破坏结构。 */
function escapeText(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 把组装好的 HTML 按块拆开，统计每块的实际字数，用于和配额对照。 */
export function measureBlocks(html: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  return Array.from(document.body.children).map((element) => {
    const tag = element.tagName.toLowerCase();
    const preset = element.getAttribute('data-yb-preset') || '';
    return {
      id: element.getAttribute('id') || '',
      tag: preset ? `${tag}/${preset}` : tag,
      chars: countBlockChars(element),
    };
  });
}

/**
 * 一个块里的正文字数。
 * 配图的生成提示词不是正文，图例也不是；图文混排只数右栏的说明文字。
 */
function countBlockChars(element: Element) {
  const clone = element.cloneNode(true) as Element;
  for (const node of Array.from(clone.querySelectorAll('template, figcaption, caption'))) {
    node.remove();
  }
  return (clone.textContent || '').replace(/\s+/g, '').length;
}
