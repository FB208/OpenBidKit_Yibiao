# -*- coding: utf-8 -*-
"""
阶段2 模块1：定位器（Locator）

定位：为 writer/deleter/clipboard 提供精确的"操作位置锚定"能力。
所有写入/删除/复制粘贴都先经 locator 找到目标 <w:p> 或目标 run，再动手。

================================================================
开发依据（基于 base.docx 真实结构，见 logs/base_structure.md）
================================================================
1. 段落节点 <w:p> 是 <w:body> 的直接子级；body 内段落绝对索引 0~38。
2. 文本分散在多个 run：如段落12「链接」真正有字的是 run[4]/run[5]，
   前 4 个 run 文本为空 → 文本定位必须遍历段落内所有 <w:r>/<w:t> 拼接，
   不能假设文本集中在单个 run。
3. pStyle 是混淆短名：标题1/2/3 的 pStyle 值是 1/2/3（非 Heading1），
   列表段落是 a9，默认正文无 pStyle → 按标题层级定位需 pStyle 映射，
   不依赖 outlineLvl（base.docx 标题段落实测无 outlineLvl）。
4. 书签：<w:bookmarkStart w:id w:name>，含 _Toc234486118/119/120、_标题3、_top。
5. 表格：<w:tbl><w:tr><w:tc>，tc 内是 <w:tcPr> + 一个或多个 <w:p>。
6. 超链接：<w:hyperlink w:anchor=...> 内含 run，文本需进入 hyperlink 找 run。

已确认的 XML 样本（来自 base.docx 实测）：
  - 标题段落：<w:pPr><w:pStyle w:val="1"/></w:pPr>  （无 outlineLvl）
  - bookmarkStart：<w:bookmarkStart w:id="1" w:name="_Toc234486118"/>
  - 表格单元格：<w:tc><w:tcPr/>...<w:p>...</w:p></w:tc>
  - 超链接：<w:hyperlink w:anchor="_Toc234486118" w:history="1"><w:r>...</w:r></w:hyperlink>
"""

from __future__ import annotations

from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


# 标题层级 -> pStyle 值映射（依据 base.docx styles.xml：heading1..9 的 styleId 为 1..9）
HEADING_PSTYLE = {1: "1", 2: "2", 3: "3", 4: "4", 5: "5",
                  6: "6", 7: "7", 8: "8", 9: "9"}

# 标题层级 -> style name 映射（OOXML 规范命名：heading 1 ~ heading 9）
HEADING_STYLE_NAMES = {i: f"heading {i}" for i in range(1, 10)}


# ============================================================================
# 内部工具
# ============================================================================
def _local(tag) -> str:
    return etree.QName(tag).localname


def _outline_level(p_elem) -> int | None:
    """取段落 pPr/outlineLvl 的 w:val（int）；无则 None。"""
    ppr = p_elem.find(_w("pPr"))
    if ppr is None:
        return None
    ol = ppr.find(_w("outlineLvl"))
    if ol is None:
        return None
    val = ol.get(_w("val"))
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _style_id_to_name(doc) -> dict[str, str]:
    """取文档 styles.xml 的 {styleId -> style name} 映射。
    无 styles 部件时返回空 dict（降级为只用 HEADING_PSTYLE 映射判定）。
    """
    out: dict[str, str] = {}
    if doc is None or not hasattr(doc, "part"):
        return out
    try:
        styles_part = doc.part.part_related_by(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
        )
    except Exception:
        return out
    try:
        tree = etree.fromstring(styles_part.blob)
    except Exception:
        return out
    for st in tree.findall(_w("style")):
        sid = st.get(_w("styleId"))
        name_el = st.find(_w("name"))
        name = name_el.get(_w("val")) if name_el is not None else None
        if sid and name:
            out[sid] = name
    return out


def _is_heading(p_elem, level: int, style_id_map: dict[str, str] | None = None) -> bool:
    """判定段落是否为指定层级(level, 1 基)的标题。

    两种来源都认（依据规格 §1.1）：
      1) pPr/pStyle 的 w:val 对应 style 的 name == "heading {level}"
         （通过 style_id_map 把 styleId 翻译为 name；若文档无 styles.xml 则
          退化用 HEADING_PSTYLE 数值映射，命中 base.docx 的 styleId 1/2/3）。
      2) pPr/outlineLvl 的 w:val == str(level-1)（烟草招标.docx 用此机制）。

    style_id_map 为 None 时尝试从 p_elem 所属文档自动取（按需），但为避免
    重复解析，调用方可预构造并传入。当 style_id_map 为空且 pStyle 非空时，
    退化用 HEADING_PSTYLE 判定（即 styleId 值 == str(level)）。
    """
    ppr = p_elem.find(_w("pPr"))
    if ppr is None:
        return False
    # 来源1：pStyle
    ps = ppr.find(_w("pStyle"))
    if ps is not None:
        sid = ps.get(_w("val"))
        if sid is not None:
            if style_id_map and sid in style_id_map:
                if style_id_map[sid] == f"heading {level}":
                    return True
            else:
                # 无 style_id_map：退化用数值映射（HEADING_PSTYLE）
                if HEADING_PSTYLE.get(level) == sid:
                    return True
    # 来源2：outlineLvl
    ol = ppr.find(_w("outlineLvl"))
    if ol is not None:
        val = ol.get(_w("val"))
        if val is not None:
            try:
                if int(val) == level - 1:
                    return True
            except (TypeError, ValueError):
                pass
    return False


def _heading_level_of(p_elem, style_id_map: dict[str, str] | None = None) -> int | None:
    """判定段落是哪一级标题（1~9）；非标题返回 None。
    两种来源都认：pStyle(经 name 翻译)/outlineLvl。
    """
    ppr = p_elem.find(_w("pPr"))
    if ppr is None:
        return None
    # pStyle
    ps = ppr.find(_w("pStyle"))
    if ps is not None:
        sid = ps.get(_w("val"))
        if sid is not None:
            name = (style_id_map or {}).get(sid)
            if name and name.startswith("heading "):
                try:
                    lv = int(name.split(" ", 1)[1])
                    if 1 <= lv <= 9:
                        return lv
                except (ValueError, IndexError):
                    pass
            else:
                # 退化数值映射
                for lv, sidv in HEADING_PSTYLE.items():
                    if sid == sidv:
                        return lv
    # outlineLvl
    ol = ppr.find(_w("outlineLvl"))
    if ol is not None:
        val = ol.get(_w("val"))
        if val is not None:
            try:
                lv = int(val) + 1
                if 1 <= lv <= 9:
                    return lv
            except (TypeError, ValueError):
                pass
    return None


def _body(doc) -> Any:
    """取文档 body 元素。接受 Document 或 <w:body>。"""
    if hasattr(doc, "element"):
        return doc.element.body
    return doc  # 已是 body


def _paragraph_text(p_elem) -> str:
    """拼接段落内所有 <w:r>/<w:t> 文本（含超链接内 run）。"""
    parts = []
    # 顶层 run
    for r in p_elem.findall(_w("r")):
        for t in r.findall(_w("t")):
            parts.append(t.text or "")
    # 超链接内 run
    for hl in p_elem.findall(_w("hyperlink")):
        for r in hl.findall(_w("r")):
            for t in r.findall(_w("t")):
                parts.append(t.text or "")
    return "".join(parts)


def _body_paragraphs(doc) -> list:
    """返回 body 直接子级 <w:p> 列表（不含表格内段落）。"""
    body = _body(doc)
    return [c for c in body if _local(c.tag) == "p"]


def _pstyle_value(p_elem) -> str | None:
    """取段落 pPr/pStyle 的 w:val；无则 None。"""
    ppr = p_elem.find(_w("pPr"))
    if ppr is None:
        return None
    ps = ppr.find(_w("pStyle"))
    return ps.get(_w("val")) if ps is not None else None


class LocateError(Exception):
    """定位失败统一异常。"""


# ============================================================================
# 公共函数 1：locate_by_paragraph_index
# ============================================================================
def locate_by_paragraph_index(doc, index: int,
                              expect_text_contains: str | None = None) -> dict:
    """
    按段落绝对索引定位。

    参数：
        doc: Document 或 body
        index: body 内 <w:p> 的顺序索引（0 基），与阶段0快照索引一致。
        expect_text_contains: 可选校验子串（默认 None，行为不变，向后兼容）。
            传入时，若该段文本不含此子串，抛 LocateError（含实际文本，便于排错）。
            用途：硬编码索引在文档结构变化时会静默填错，此参数把「静默填错」
            挡在定位阶段。

    返回：
        {
          "paragraph_index": int,
          "p_elem": <w:p> 元素,
          "text": str,
          "pStyle": str|None,
          "locator": "paragraph_index"
        }

    依据说明：
        body 直接子级 <w:p> 按出现顺序编号（依据快照段落列表 [0]~[38]）。
    样式保护说明：
        本函数只读不写，不涉及样式。
    边界说明：
        index 越界 -> 抛 LocateError；负索引不支持（避免歧义）。
        expect_text_contains 非空且段落文本不含该子串 -> 抛 LocateError
        （含实际文本，便于定位排错）。
    """
    if index < 0:
        raise LocateError(f"不支持负索引: {index}")
    paras = _body_paragraphs(doc)
    if index >= len(paras):
        raise LocateError(f"段落索引越界: {index}（共 {len(paras)} 段）")
    p = paras[index]
    text = _paragraph_text(p)
    if expect_text_contains is not None and expect_text_contains not in text:
        raise LocateError(
            f"段落 {index} 文本不含 {expect_text_contains!r}（实际文本: {text!r}）")
    return {
        "paragraph_index": index,
        "p_elem": p,
        "text": text,
        "pStyle": _pstyle_value(p),
        "locator": "paragraph_index",
    }


# ============================================================================
# 公共函数 2：locate_by_text
# ============================================================================
def _match_positions(paras, text: str, exact: bool) -> list[dict]:
    """在段落列表中找文本匹配，返回命中位置列表。"""
    hits = []
    for i, p in enumerate(paras):
        ptext = _paragraph_text(p)
        match = (ptext == text) if exact else (text in ptext)
        if match:
            hits.append({"paragraph_index": i, "p_elem": p, "text": ptext,
                         "locator": "text"})
    return hits


def locate_by_text(doc, text: str, occurrence: int = 1,
                   exact: bool = False) -> dict:
    """
    按文本内容定位段落。

    参数：
        text: 要匹配的文本。
        occurrence: 第几次出现（1 基）。默认 1。
        exact: True=段落文本完全相等；False=段落文本包含 text（默认）。

    返回：单条定位结果（同 locate_by_paragraph_index 结构，含 locator="text"）。

    依据说明：
        文本遍历段落内所有 <w:r>/<w:t> 及 <w:hyperlink> 内 run 拼接
        （依据：base.docx 段落12「链接」文本分散在 run[4]/run[5]，且前4个 run 空）。
        因此"多 run 跨度"文本能被正确匹配。
    样式保护说明：
        只读不写。
    边界说明：
        - text 为空串 -> 抛 LocateError（空文本无法唯一定位）。
        - 0 个匹配 -> 抛 LocateError。
        - occurrence 超出匹配数 -> 抛 LocateError。
        - 多个匹配但未指定 occurrence -> 默认取第1个，但结果中带 "match_count"
          供调用方判断是否歧义。
    """
    if not text:
        raise LocateError("text 不能为空")
    paras = _body_paragraphs(doc)
    hits = _match_positions(paras, text, exact)
    if not hits:
        raise LocateError(f"未找到匹配文本: {text!r}（exact={exact}）")
    if occurrence < 1 or occurrence > len(hits):
        raise LocateError(
            f"occurrence={occurrence} 超出匹配数 {len(hits)}（文本 {text!r}）")
    result = dict(hits[occurrence - 1])
    result["match_count"] = len(hits)
    result["occurrence"] = occurrence
    return result


# ============================================================================
# 公共函数 3：locate_by_heading_level
# ============================================================================
def locate_by_heading_level(doc, level: int, occurrence: int = 1) -> dict:
    """
    按标题层级定位（如所有 H1 中的第 N 个）。

    参数：
        level: 1~9。
        occurrence: 同级别下第几次出现（1 基）。

    返回：单条定位结果（含 locator="heading_level"）。

    依据说明：
        base.docx 标题段落 pStyle=1/2/3（heading1/2/3 的 styleId），
        实测无 outlineLvl → 仅按 pStyle 映射判定层级。
        映射表 HEADING_PSTYLE 依据 styles.xml 中 heading1..9 的 styleId 为 1..9。
    样式保护说明：
        只读不写。
    边界说明：
        - level 不在 1~9 -> 抛 LocateError。
        - occurrence 超出该级别匹配数 -> 抛 LocateError。
        - 若文档标题用自定义 pStyle（非 1~9），本函数不识别，需改用
          locate_by_paragraph_index 或 locate_by_text（已在局限中标注）。
    """
    if level not in HEADING_PSTYLE:
        raise LocateError(f"level 必须为 1~9，实得 {level}")
    target_style = HEADING_PSTYLE[level]
    paras = _body_paragraphs(doc)
    hits = []
    for i, p in enumerate(paras):
        if _pstyle_value(p) == target_style:
            hits.append({"paragraph_index": i, "p_elem": p,
                         "text": _paragraph_text(p), "pStyle": target_style,
                         "locator": "heading_level"})
    if not hits:
        raise LocateError(f"未找到 H{level} 段落")
    if occurrence < 1 or occurrence > len(hits):
        raise LocateError(
            f"occurrence={occurrence} 超出 H{level} 匹配数 {len(hits)}")
    result = dict(hits[occurrence - 1])
    result["match_count"] = len(hits)
    return result


# ============================================================================
# 公共函数 4：locate_by_bookmark
# ============================================================================
def locate_by_bookmark(doc, bookmark_name: str) -> dict:
    """
    按书签名定位书签所在的段落。

    参数：
        bookmark_name: 书签名，如 "_Toc234486118"、"_标题3"。

    返回：定位结果（含 locator="bookmark"）。

    依据说明：
        <w:bookmarkStart w:id w:name> 出现在某 <w:p> 内；
        遍历 body 段落，找其包含 bookmarkStart 且 name 匹配的段落。
        样本：<w:bookmarkStart w:id="1" w:name="_Toc234486118"/>。
    样式保护说明：
        只读不写。
    边界说明：
        - bookmark_name 为空 -> 抛 LocateError。
        - 书签不存在 -> 抛 LocateError。
        - 同名书签出现多次（不规范但可能）-> 取第一个，结果带 match_count。
        - bookmarkStart 跨段落的边界情况：bookmarkStart 在 A 段、bookmarkEnd
          在 B 段时，本函数定位到 A（start 所在段），符合"锚定起点"语义。
    """
    if not bookmark_name:
        raise LocateError("bookmark_name 不能为空")
    paras = _body_paragraphs(doc)
    hits = []
    for i, p in enumerate(paras):
        for bm in p.findall(_w("bookmarkStart")):
            if bm.get(_w("name")) == bookmark_name:
                hits.append({"paragraph_index": i, "p_elem": p,
                             "text": _paragraph_text(p),
                             "bookmark_name": bookmark_name,
                             "locator": "bookmark"})
                break
    if not hits:
        raise LocateError(f"未找到书签: {bookmark_name!r}")
    result = dict(hits[0])
    result["match_count"] = len(hits)
    return result


# ============================================================================
# 公共函数 5：locate_table_cell
# ============================================================================
def locate_table_cell(doc, table_index: int, row: int, col: int) -> dict:
    """
    按表格坐标定位单元格。

    参数：
        table_index: body 内 <w:tbl> 的顺序索引（0 基）。
        row: 行索引（0 基）。
        col: 列索引（0 基）。

    返回：
        {
          "table_index": int, "row": int, "col": int,
          "tc_elem": <w:tc> 元素,
          "paragraphs": [ <单元格内各 <w:p>> ],
          "text": str（单元格内所有段落文本拼接）,
          "locator": "table_cell"
        }

    依据说明：
        <w:tbl><w:tr><w:tc>，tc 内是 <w:tcPr> + 一个或多个 <w:p>（实测 tc0 段落数=1）。
        body 直接子级 <w:tbl> 按顺序编号。
    样式保护说明：
        只读不写。
    边界说明：
        - 任一索引越界 -> 抛 LocateError。
        - 单元格合并（vMerge/gridSpan）时，逻辑列号可能与物理 tc 数不对应，
          本函数按物理 tc 顺序编号，不解析合并（局限，待后续扩展）。
        - 空单元格（无 <w:p>）-> paragraphs 为空列表，text 为空串（合法）。
    """
    body = _body(doc)
    tables = [c for c in body if _local(c.tag) == "tbl"]
    if table_index < 0 or table_index >= len(tables):
        raise LocateError(f"表格索引越界: {table_index}（共 {len(tables)} 表）")
    tbl = tables[table_index]
    rows = tbl.findall(_w("tr"))
    if row < 0 or row >= len(rows):
        raise LocateError(f"行索引越界: {row}（共 {len(rows)} 行）")
    cells = rows[row].findall(_w("tc"))
    if col < 0 or col >= len(cells):
        raise LocateError(f"列索引越界: {col}（共 {len(cells)} 列）")
    tc = cells[col]
    ps = tc.findall(_w("p"))
    text = " / ".join(_paragraph_text(p) for p in ps)
    return {
        "table_index": table_index, "row": row, "col": col,
        "tc_elem": tc, "paragraphs": ps, "text": text,
        "locator": "table_cell",
    }


# ============================================================================
# 公共函数 6：locate_by_heading（语义层：按标题文本+大纲层级定位）
# ============================================================================
def locate_by_heading(doc, text=None, level=1, occurrence=1,
                      exact=False) -> dict:
    """
    按「标题文本 + 大纲层级」定位标题段落（语义层）。

    参数：
        doc: Document 或 body
        text: 标题文本。None 时退化为「第 occurrence 个该层级标题」
              （向后兼容 locate_by_heading_level）；非 None 时按文本匹配：
              默认 text in ptext（子串），exact=True 时 ptext.strip()==text。
        level: 大纲层级 1~9。
        occurrence: 第几个匹配（1 基）。
        exact: 是否精确匹配文本（仅 text 非 None 时生效）。

    返回：
        {paragraph_index, p_elem, text, pStyle, outlineLvl,
         locator:"locate_by_heading"}
        text=None 时额外带 match_count。

    依据说明：
        现有 locate_by_heading_level 仅按 pStyle（经 HEADING_PSTYLE 数值映射）
        判定，不认 outlineLvl。但真实招标文档（input/烟草招标.docx）章节标题用
        outlineLvl=0 无 pStyle。故本函数用 _is_heading 同时认两种来源
        （pStyle 经 styles.xml name 翻译为 "heading {level}" 命中，OR
        outlineLvl==level-1 命中）。styleId->name 映射取自文档 styles.xml。
    样式保护说明：
        只读不写，不涉及样式修改。
    边界说明：
        - level 不在 1~9 -> 抛 LocateError。
        - occurrence < 1 -> 抛 ValueError。
        - 未命中抛 LocateError（含已扫描标题数与首个标题文本，便于排错）。
        - base.docx 用 pStyle=1/2/3，烟草招标.docx 用 outlineLvl=0，两者都能命中。
    """
    if level not in HEADING_PSTYLE:
        raise LocateError(f"level 必须为 1~9，实得 {level}")
    if occurrence < 1:
        raise ValueError(f"occurrence 必须 >=1，实得 {occurrence}")

    style_id_map = _style_id_to_name(doc if hasattr(doc, "part") else None)
    paras = _body_paragraphs(doc)
    hits = []
    first_heading_text = None
    for i, p in enumerate(paras):
        if not _is_heading(p, level, style_id_map):
            continue
        ptext = _paragraph_text(p)
        if first_heading_text is None:
            first_heading_text = ptext
        if text is not None:
            ok = (ptext.strip() == text) if exact else (text in ptext)
            if not ok:
                continue
        hits.append({"paragraph_index": i, "p_elem": p, "text": ptext,
                     "pStyle": _pstyle_value(p),
                     "outlineLvl": _outline_level(p),
                     "locator": "locate_by_heading"})
    if not hits:
        scanned = len([p for p in paras
                       if _heading_level_of(p, style_id_map) is not None])
        raise LocateError(
            f"未找到匹配的标题（level={level}, text={text!r}, exact={exact}, "
            f"occurrence={occurrence}）；共扫描 {scanned} 个标题，"
            f"首个标题文本={first_heading_text!r}")
    if occurrence > len(hits):
        raise LocateError(
            f"occurrence={occurrence} 超出匹配数 {len(hits)}")
    result = dict(hits[occurrence - 1])
    if text is None:
        result["match_count"] = len(hits)
    return result


# ============================================================================
# 公共函数 7：locate_in_section（语义层：在章节范围内定位）
# ============================================================================
def locate_in_section(doc, section_text, target_text, level=1,
                      exact_section=False, occurrence=1) -> dict:
    """
    先定位「文本==section_text 且为 level 级标题」的章节，再在该章节范围内
    查找 target_text 段落（语义层）。

    参数：
        doc: Document 或 body
        section_text: 章节标题文本（默认子串匹配；exact_section=True 时精确）。
        target_text: 目标段落文本（子串匹配）。
        level: 章节标题层级 1~9。
        exact_section: 是否精确匹配 section 标题文本。
        occurrence: 在该范围内第几个 target_text（1 基）。

    返回：
        {paragraph_index, p_elem, text,
         section_heading:{index, text, level},
         locator:"locate_in_section"}

    依据说明：
        章节范围界定：从 section 标题段的下一个 body 子元素起，到遇到
        「outlineLvl < level 或 outlineLvl == level 且为另一标题」的段为止
        （即下一同级/更高级标题前，不含末尾 sectPr 段）。范围内只扫段落，
        遇表格不报错（跳过表格，仅扫 <w:p>）。
    样式保护说明：
        只读不写。
    边界说明：
        - level 不在 1~9 -> 抛 LocateError。
        - occurrence < 1 -> 抛 ValueError。
        - section 标题未找到 -> 抛 LocateError。
        - 范围内未命中 target_text -> 抛 LocateError。
        - section 与 target 同一段（section 标题段本身含 target_text）也算命中。
    """
    if level not in HEADING_PSTYLE:
        raise LocateError(f"level 必须为 1~9，实得 {level}")
    if occurrence < 1:
        raise ValueError(f"occurrence 必须 >=1，实得 {occurrence}")

    style_id_map = _style_id_to_name(doc if hasattr(doc, "part") else None)
    # 定位 section 标题段
    sec_loc = locate_by_heading(doc, text=section_text, level=level,
                                occurrence=1, exact=exact_section)
    sec_p = sec_loc["p_elem"]
    sec_idx = sec_loc["paragraph_index"]

    # 在 body 中从 sec_p 本身开始扫描（含标题段，因 section 与 target 同一段也算命中），
    # 直到下一同级/更高级标题前
    body = _body(doc)
    children = list(body)
    try:
        start = children.index(sec_p)
    except ValueError:
        raise LocateError("section 标题段不在 body 中")

    hits = []
    for off, c in enumerate(children[start:]):
        tag = _local(c.tag)
        if tag == "sectPr":
            break
        if tag != "p":
            # 表格等非段落：跳过（范围内包含表格不报错）
            continue
        # section 标题段本身（off==0）是范围起点，参与 target 匹配但不作为终止条件；
        # 其后遇到同级或更高级标题则终止章节范围
        if off > 0:
            hlv = _heading_level_of(c, style_id_map)
            if hlv is not None and hlv <= level:
                break
        ptext = _paragraph_text(c)
        if target_text in ptext:
            hits.append((c, ptext))

    if not hits:
        raise LocateError(
            f"在章节 {section_text!r}（段落{sec_idx}）范围内未找到 {target_text!r}")
    if occurrence > len(hits):
        raise LocateError(
            f"occurrence={occurrence} 超出范围内匹配数 {len(hits)}")
    hit_p, hit_text = hits[occurrence - 1]
    # 计算 body 段落索引
    p_idx = None
    p_counter = 0
    for c in children:
        if _local(c.tag) == "p":
            if c is hit_p:
                p_idx = p_counter
                break
            p_counter += 1

    return {
        "paragraph_index": p_idx,
        "p_elem": hit_p,
        "text": hit_text,
        "section_heading": {
            "index": sec_idx,
            "text": sec_loc["text"],
            "level": level,
        },
        "locator": "locate_in_section",
    }


# ============================================================================
# 公共函数 8：locate_table_by_header（语义层：按表头关键词定位表格）
# ============================================================================
def locate_table_by_header(doc, header_keywords, occurrence=1) -> dict:
    """
    按表头关键词定位表格（语义层）。

    参数：
        doc: Document 或 body
        header_keywords: list[str]，表头首行拼接文本同时包含全部关键词即命中。
        occurrence: 第几个命中的表（1 基）。

    返回：
        {table_index, tbl_elem, header_cells:[str], locator:"locate_table_by_header"}

    依据说明：
        表头取第 0 个 <w:tr> 的各 <w:tc> 文本（lxml iter('w:t') 拼接），
        拼接后同时包含全部 header_keywords 即命中。
    样式保护说明：
        只读不写。
    边界说明：
        - header_keywords 为空 list -> 抛 ValueError。
        - 任一关键词为空串 -> 抛 ValueError。
        - occurrence < 1 -> 抛 ValueError。
        - 未命中 -> 抛 LocateError。
        - 表格无行或无单元格 -> 不参与匹配（跳过）。
    """
    if not header_keywords:
        raise ValueError("header_keywords 不能为空 list")
    if any((kw is None or kw == "") for kw in header_keywords):
        raise ValueError("header_keywords 中含空串")
    if occurrence < 1:
        raise ValueError(f"occurrence 必须 >=1，实得 {occurrence}")

    body = _body(doc)
    tables = [c for c in body if _local(c.tag) == "tbl"]
    hits = []
    for ti, tbl in enumerate(tables):
        rows = tbl.findall(_w("tr"))
        if not rows:
            continue
        cells = rows[0].findall(_w("tc"))
        if not cells:
            continue
        header_cells = []
        for tc in cells:
            parts = []
            for p in tc.findall(_w("p")):
                parts.append(_paragraph_text(p))
            header_cells.append(" / ".join(parts))
        joined = "".join(header_cells)
        if all(kw in joined for kw in header_keywords):
            hits.append({"table_index": ti, "tbl_elem": tbl,
                         "header_cells": header_cells,
                         "locator": "locate_table_by_header"})
    if not hits:
        raise LocateError(
            f"未找到表头含 {header_keywords!r} 的表格")
    if occurrence > len(hits):
        raise LocateError(
            f"occurrence={occurrence} 超出匹配表数 {len(hits)}")
    return dict(hits[occurrence - 1])


# ============================================================================
# 公共函数 10：extract_outline（语义层：大纲提取 P2-10）
# ============================================================================
def extract_outline(doc, *, levels=(1, 2, 3, 4, 5, 6)) -> dict:
    """
    提取文档大纲（带 level 的标题列表）（P2-10）。

    参数：
        doc: Document 对象或 body
        levels: 参与提取的标题层级 tuple（默认 1~6）

    返回：
        {outline:[{level, text, paragraph_index}], count,
         locator:"extract_outline"}

    依据说明：
        遍历 body 段落（_body_paragraphs），用 _heading_level_of 判定标题层级
        （pStyle 经 styles.xml name 翻译 / outlineLvl 两种来源都认）。
        按 levels 过滤，返回文档顺序的标题列表。base.docx 标题用 pStyle=1/2/3，
        烟草招标.docx 用 outlineLvl=0，两者都能命中。
    样式保护说明：
        只读不写，不涉及样式修改。
    边界说明：
        - 无标题 -> count=0，outline=[]，不抛。
        - levels 过滤：不在列表中的标题层级被跳过。
        - 空文档 -> count=0，不抛。
    """
    style_id_map = _style_id_to_name(doc if hasattr(doc, "part") else None)
    paras = _body_paragraphs(doc)
    outline = []
    for i, p in enumerate(paras):
        hlv = _heading_level_of(p, style_id_map)
        if hlv is None:
            continue
        if hlv not in levels:
            continue
        outline.append({
            "level": hlv,
            "text": _paragraph_text(p),
            "paragraph_index": i,
        })
    return {
        "outline": outline,
        "count": len(outline),
        "locator": "extract_outline",
    }


# ============================================================================
# 自测：对 base.docx 验证各类定位
# ============================================================================
def _self_test():
    doc = Document("input/base.docx")

    # 1. 段落索引
    r = locate_by_paragraph_index(doc, 7)
    assert r["text"] == "正文宋体四号", r
    assert r["pStyle"] is None  # 默认正文无 pStyle

    # 2. 文本定位（含多 run 段落）
    r = locate_by_text(doc, "链接")
    assert r["paragraph_index"] == 12, r
    assert r["text"] == "链接", r
    # 多 run 标题也能定位
    r = locate_by_text(doc, "标题2", exact=True)
    assert r["paragraph_index"] == 3, r

    # 3. 标题层级
    r = locate_by_heading_level(doc, 1)
    assert r["paragraph_index"] == 2 and r["text"] == "标题1", r
    r = locate_by_heading_level(doc, 3)
    assert r["paragraph_index"] == 4 and r["text"] == "标题3", r

    # 4. 书签（依据 base.docx 实测：_Toc234486118 在段落1，_标题3 在段落4）
    r = locate_by_bookmark(doc, "_Toc234486118")
    assert r["paragraph_index"] == 1, r  # 标题1前的空段落
    r = locate_by_bookmark(doc, "_标题3")
    assert r["paragraph_index"] == 4, r  # 标题3段落

    # 5. 表格坐标
    r = locate_table_cell(doc, 0, 0, 0)
    assert r["text"] == "C1", r
    r = locate_table_cell(doc, 0, 2, 3)
    assert r["text"] == "8", r

    # 6. 边界：越界与不存在应抛异常
    for fn, args in [
        (lambda: locate_by_paragraph_index(doc, 999), None),
        (lambda: locate_by_text(doc, "不存在的文本xyz"), None),
        (lambda: locate_by_text(doc, ""), None),
        (lambda: locate_by_heading_level(doc, 5), None),  # base 无 H5 内容段落? 实际可能有样式定义但无段落
        (lambda: locate_by_bookmark(doc, "不存在书签"), None),
        (lambda: locate_table_cell(doc, 0, 9, 9), None),
    ]:
        try:
            fn()
            raised = False
        except LocateError:
            raised = True
        # H5 在 base.docx 中是否有段落？快照显示标题1/2/3，无4-9段落 -> 应抛
        assert raised, f"应抛 LocateError: {fn}"

    print("[自测通过] 段落索引定位 -> 段落7 正文宋体四号")
    print("[自测通过] 文本定位（含多run） -> 段落12 链接、段落3 标题2")
    print("[自测通过] 标题层级定位 -> H1=段落2、H3=段落4")
    print("[自测通过] 书签定位 -> _Toc234486118=段落1、_标题3=段落4")
    print("[自测通过] 表格坐标定位 -> (0,0,0)=C1、(0,2,3)=8")
    print("[自测通过] 边界异常 -> 越界/不存在/空文本均抛 LocateError")

    # 7. expect_text_contains 校验
    # 命中：段落7 含「宋体」
    r = locate_by_paragraph_index(doc, 7, expect_text_contains="宋体")
    assert r["text"] == "正文宋体四号", r
    # 不命中：段落7 不含「标题」 -> 抛 LocateError
    try:
        locate_by_paragraph_index(doc, 7, expect_text_contains="标题")
        raised = False
    except LocateError:
        raised = True
    assert raised, "段落7 不含「标题」应抛 LocateError"
    # 默认 None 行为不变：不传参与传 None 等价
    r_none = locate_by_paragraph_index(doc, 7, expect_text_contains=None)
    assert r_none["text"] == "正文宋体四号"
    print("[自测通过] expect_text_contains 校验 -> 命中正常 / 不含子串抛 LocateError")

    # 8. 语义层：locate_by_heading（base.docx 用 pStyle=1/2/3）
    r = locate_by_heading(doc, text="标题1", level=1)
    assert r["paragraph_index"] == 2 and r["text"] == "标题1", r
    assert r["pStyle"] == "1", r
    assert r["outlineLvl"] is None, r
    # text=None 退化为第 occurrence 个该层级标题
    r = locate_by_heading(doc, level=1)
    assert r["paragraph_index"] == 2, r
    assert r.get("match_count") == 1, r
    # level=3 标题3
    r = locate_by_heading(doc, text="标题3", level=3)
    assert r["paragraph_index"] == 4 and r["text"] == "标题3", r
    # 子串匹配：标题
    r = locate_by_heading(doc, text="标题", level=1)
    assert r["paragraph_index"] == 2, r
    # 边界：level 越界
    try:
        locate_by_heading(doc, level=10)
        raised = False
    except LocateError:
        raised = True
    assert raised, "level=10 应抛 LocateError"
    # 边界：occurrence < 1
    try:
        locate_by_heading(doc, level=1, occurrence=0)
        raised = False
    except ValueError:
        raised = True
    assert raised, "occurrence=0 应抛 ValueError"
    # 边界：未命中
    try:
        locate_by_heading(doc, text="不存在的标题", level=1)
        raised = False
    except LocateError:
        raised = True
    assert raised, "未命中应抛 LocateError"
    print("[自测通过] locate_by_heading -> 标题1=段落2(pStyle=1)、标题3=段落4；边界异常 OK")

    # 9. 语义层：locate_in_section
    # base.docx：标题1（段落2）到标题2（段落3）之间只有标题1段本身；
    # section_text="标题1" level=1, target_text="标题1"（同段命中也算）
    r = locate_in_section(doc, section_text="标题1", target_text="标题1",
                          level=1)
    assert r["section_heading"]["index"] == 2, r
    # 章节范围内找正文：标题1 后到标题2 前的段落（P0~P28 范围内标题1后第一段
    # 是空段 P5 等）——用 locate_in_section 找「自定义样式」(P6)，在标题1(level1)
    # 与标题2(level2) 之间
    r = locate_in_section(doc, section_text="标题1", target_text="自定义样式",
                          level=1)
    assert r["paragraph_index"] == 6 and r["text"] == "自定义样式", r
    # 边界：section 未找到
    try:
        locate_in_section(doc, section_text="不存在的章节", target_text="x",
                          level=1)
        raised = False
    except LocateError:
        raised = True
    assert raised, "section 未找到应抛 LocateError"
    # 边界：范围内未命中 target
    try:
        locate_in_section(doc, section_text="标题1", target_text="不存在的文本xyz",
                          level=1)
        raised = False
    except LocateError:
        raised = True
    assert raised, "范围内未命中 target 应抛 LocateError"
    print("[自测通过] locate_in_section -> 标题1章节内找「自定义样式」=段落6；边界异常 OK")

    # 10. 语义层：locate_table_by_header
    r = locate_table_by_header(doc, ["C1", "C2"])
    assert r["table_index"] == 0, r
    assert r["header_cells"] == ["C1", "C2", "C3", "C4"], r
    # 关键词全部匹配
    r = locate_table_by_header(doc, ["C3", "C4"])
    assert r["table_index"] == 0, r
    # 边界：空 list
    try:
        locate_table_by_header(doc, [])
        raised = False
    except ValueError:
        raised = True
    assert raised, "空 list 应抛 ValueError"
    # 边界：未命中
    try:
        locate_table_by_header(doc, ["不存在的表头关键词"])
        raised = False
    except LocateError:
        raised = True
    assert raised, "未命中表应抛 LocateError"
    print("[自测通过] locate_table_by_header -> 表0 表头[C1,C2,C3,C4]；边界异常 OK")

    # 11. outlineLvl 来源测试（构造一个含 outlineLvl 的段落验证两种来源都认）
    # 在标题1段落的 pPr 中临时加 outlineLvl=0（模拟烟草招标文档机制）
    from copy import deepcopy
    doc2 = Document("input/base.docx")
    p2 = doc2.element.body  # placeholder
    # 找段落2 的 pPr，加 outlineLvl=0，移除 pStyle
    paras2 = _body_paragraphs(doc2)
    p_h1 = paras2[2]
    ppr = p_h1.find(_w("pPr"))
    # 移除 pStyle
    ps_el = ppr.find(_w("pStyle"))
    if ps_el is not None:
        ppr.remove(ps_el)
    # 加 outlineLvl val=0
    ol = ppr.makeelement(_w("outlineLvl"), {_w("val"): "0"})
    ppr.append(ol)
    # 此时该段无 pStyle 但有 outlineLvl=0，应被 locate_by_heading(level=1) 命中
    r = locate_by_heading(doc2, level=1)
    assert r["paragraph_index"] == 2, r
    assert r["outlineLvl"] == 0, r
    assert r["pStyle"] is None, r
    print("[自测通过] outlineLvl 来源 -> 移除 pStyle 加 outlineLvl=0 后仍命中 H1")

    # 12. extract_outline（P2-10）
    r = extract_outline(doc)
    assert r["count"] >= 3, f"base.docx outline count 应 >=3，实得 {r['count']}"
    # P2=level1, P3=level2, P4=level3
    entries_by_idx = {e["paragraph_index"]: e for e in r["outline"]}
    assert entries_by_idx[2]["level"] == 1, entries_by_idx[2]
    assert entries_by_idx[3]["level"] == 2, entries_by_idx[3]
    assert entries_by_idx[4]["level"] == 3, entries_by_idx[4]
    assert entries_by_idx[2]["text"] == "标题1", entries_by_idx[2]
    # levels 过滤：只取 level 1
    r2 = extract_outline(doc, levels=(1,))
    assert r2["count"] == 1, f"只取 level1 应 1 条，实得 {r2['count']}"
    # 烟草招标.docx（outlineLvl 标题）
    import os
    tobacco = "input/烟草招标.docx"
    if os.path.exists(tobacco):
        doc_t = Document(tobacco)
        r3 = extract_outline(doc_t)
        assert r3["count"] > 0, f"烟草招标 outline 应 >0，实得 {r3['count']}"
    # 空文档
    r4 = extract_outline(Document())
    assert r4["count"] == 0 and r4["outline"] == [], r4
    print("[自测通过] extract_outline -> base P2/P3/P4 = H1/H2/H3；levels 过滤 OK；烟草招标 OK")


if __name__ == "__main__":
    _self_test()
