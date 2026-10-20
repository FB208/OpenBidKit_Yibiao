export interface FixItem {
  ruleId: string;
  label: string;
  hint: string;
}

export interface FixGroup {
  id: string;
  title: string;
  description: string;
  items: FixItem[];
}

/** 自动修复项，按身份信息、版式格式、文本结构分组；规则 ID 与 Main 的 FIX_RULE_IDS 一致。 */
export const fixGroups: FixGroup[] = [
  {
    id: 'identity',
    title: '身份信息清理',
    description: '删除随文件提交、评审方可以直接读到的身份信息。',
    items: [
      { ruleId: 'struct.doc_props', label: '文档属性', hint: '清空作者、最后修改者、单位，模板名重置为 Normal，删除自定义属性' },
      { ruleId: 'struct.comment', label: '批注', hint: '删除批注及正文中的批注标记' },
      { ruleId: 'struct.revision', label: '未接受的修订', hint: '接受全部修订；段落合并、删除单元格类修订需在 Word 中手动接受' },
      { ruleId: 'text.hidden', label: '隐藏文字', hint: '直接删除隐藏的文字，而不是取消隐藏' },
      { ruleId: 'struct.hyperlink', label: '外部超链接', hint: '取消链接、保留文字，并删除链接地址' },
      { ruleId: 'struct.field', label: '身份类域', hint: '删除作者、文件名、单位等域及其显示内容' },
      { ruleId: 'struct.header_footer', label: '页眉页脚', hint: '按预设清空页眉页脚内容并去掉页眉横线；预设允许页码时保留页码' },
      { ruleId: 'image.meta', label: '图片元数据', hint: '去除 JPEG、PNG 图片里的作者、版权、拍摄位置等信息，不改画面' },
      { ruleId: 'struct.bookmark', label: '含身份信息的书签', hint: '删除名称里含身份信息的书签（需在预设中开启书签检查）' },
    ],
  },
  {
    id: 'format',
    title: '版式与格式',
    description: '按当前格式预设改正，只改有问题的那一项；标题按标题要求、表格按表格要求处理，封面和目录不改。',
    items: [
      { ruleId: 'page.paper_size', label: '纸张大小', hint: '保持原来的横竖方向' },
      { ruleId: 'page.margins', label: '页边距', hint: '四边按预设设置' },
      { ruleId: 'page.columns', label: '分栏', hint: '改为一栏；招标文件一般不规定分栏，默认不勾选' },
      { ruleId: 'page.background', label: '页面背景色', hint: '去掉页面颜色（招标文件不允许彩色时检查）' },
      { ruleId: 'para.line_spacing', label: '行距', hint: '按预设的行距类型和数值设置' },
      { ruleId: 'para.first_line_indent', label: '首行缩进', hint: '同时写入字符数和实际宽度' },
      { ruleId: 'para.space_before_after', label: '段前段后间距', hint: '按预设设置段前段后' },
      { ruleId: 'para.alignment', label: '对齐方式', hint: '预设写明固定值时才修改' },
      { ruleId: 'font.chinese', label: '中文字体', hint: '同时去掉会覆盖字体的主题字体设置' },
      { ruleId: 'font.western', label: '西文字体', hint: '预设写明西文字体时才修改' },
      { ruleId: 'font.size', label: '字号', hint: '按正文或标题的要求设置' },
      { ruleId: 'font.bold', label: '加粗', hint: '标题按标题要求，正文和表格不允许加粗时取消（样式继承的加粗也能取消）' },
      { ruleId: 'font.italic', label: '斜体', hint: '取消正文和表格文字的斜体' },
      { ruleId: 'font.underline', label: '下划线', hint: '取消正文和表格文字的下划线' },
      { ruleId: 'font.color', label: '文字颜色', hint: '正文和表格文字改为黑色' },
      { ruleId: 'font.highlight', label: '突出显示和文字底纹', hint: '取消突出显示颜色和文字底纹' },
      { ruleId: 'font.effects', label: '异常字体效果', hint: '取消删除线、阴影、空心等效果' },
      { ruleId: 'font.char_spacing', label: '字符间距', hint: '恢复标准间距' },
      { ruleId: 'font.scaling', label: '字体缩放', hint: '恢复为 100%' },
      { ruleId: 'table.font', label: '表格字体', hint: '按表格要求设置中文字体' },
      { ruleId: 'table.size', label: '表格字号', hint: '按表格要求设置字号' },
      { ruleId: 'table.indent', label: '单元格首行缩进', hint: '按表格要求设置' },
      { ruleId: 'table.shading', label: '单元格底纹', hint: '去掉彩色底纹（招标文件不允许彩色时检查）' },
      { ruleId: 'image.color', label: '彩色图片', hint: '把彩色的 PNG、JPEG 图片转为灰度，尺寸和位置不变（需在预设中开启彩色图片检查）' },
    ],
  },
  {
    id: 'text',
    title: '文本与结构',
    description: '英文标点、多余空格不是招标文件的格式条款，和段前分页、对齐到网格一样默认不勾选，确有需要时再选。',
    items: [
      { ruleId: 'text.english_punct', label: '英文标点', hint: '中文语境的英文标点改为全角，小数、版本号、网址等不改' },
      { ruleId: 'text.spaces', label: '多余空格', hint: '按预设的空格规则删除，章节编号后的空格保留' },
      { ruleId: 'text.irregular', label: '特殊字符', hint: '删除零宽字符，不换行空格改为普通空格' },
      { ruleId: 'text.linebreak', label: '手动换行', hint: '在换行处分成两段，沿用原段落格式；标题、编号段落和含超链接、域的段落不拆' },
      { ruleId: 'struct.empty_paragraph', label: '空段落', hint: '删除多余空行；分节、编号、段前分页、含对象、表格之间必需的段落和封面不删' },
      { ruleId: 'struct.heading_number', label: '标题序号', hint: '招标要求阿拉伯数字时：自动编号改为阿拉伯数字；文档总标题前的序号删除；全文手写中文序号且层级清楚时重排为 1、1.1、1.1.1，目录同步修改；写法混用的留给人工' },
      { ruleId: 'struct.toc', label: '目录', hint: '预设为“不得有目录”时删除目录：自动目录、转成纯文本的目录、带“目录”标题的手工目录，连同目录标题；前后只留一处换页。没有目录标题的手工目录留给人工' },
      { ruleId: 'para.page_break_before', label: '段前分页', hint: '取消段前分页' },
      { ruleId: 'para.snap_to_grid', label: '对齐到网格', hint: '取消"如果定义了文档网格，则对齐到网格"' },
    ],
  },
];

export const fixRuleLabels: Record<string, string> = Object.fromEntries(
  fixGroups.flatMap((group) => group.items.map((item) => [item.ruleId, item.label])),
);

