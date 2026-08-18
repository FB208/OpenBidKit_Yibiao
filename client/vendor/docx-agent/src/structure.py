# -*- coding: utf-8 -*-
"""
阶段3 语义层模块：结构（Structure）

定位：承载「结构性」操作——分页、分节符、范围删除、目录域。
依赖 src.locator（定位）与 src.writer._resolve_anchor（锚点解析）。

================================================================
开发依据（基于 base.docx 真实结构 + 规格 SEMANTIC_LAYER_SPEC.md §3）
================================================================
1. body 末尾是 <w:sectPr>（body 级分节符）；段落 pPr 内也可能含 <w:sectPr>
   （内嵌分节符，烟草招标.docx P754/P897 有）。remove_section_break 处理后者。
2. pageBreakBefore：<w:pPr><w:pageBreakBefore/></w:pPr>，使段落从新页开始。
3. 分页符 run：<w:r><w:br w:type="page"/></w:r>，封面标题继承时会产生空白首页。
4. TOC 域结构：fldChar(begin) → instrText('TOC \\o "1-3" \\h \\z \\u') →
   fldChar(separate) → 占位文本 → fldChar(end)。一个 <w:p> 内可串这 5 个 run。
5. base.docx 无内嵌分节符/TOC 域/outlineLvl 标题 → 结构类测试需先用 writer
   构造场景（插含占位符段、插含 <w:br type=page> 段、插内嵌 sectPr 段）。
"""

from __future__ import annotations

import os as _os
import re
import sys as _sys
from copy import deepcopy
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

# 兼容直接运行（python src/structure.py）：把项目根加入路径以导入 src 包
if __package__ in (None, ""):
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from src.locator import (
    LocateError,
    locate_by_heading,
    _body_paragraphs,
    _paragraph_text,
    _pstyle_value,
    _outline_level,
    _heading_level_of,
    _style_id_to_name,
    _local,
)
from src.writer import _resolve_anchor, WriterError

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


class StructureError(Exception):
    """结构性操作失败统一异常。"""


# ============================================================================
# 内部工具
# ============================================================================
def _ensure_ppr(p_elem):
    """取或建段落 pPr（建则插到段首）。返回 pPr 元素。"""
    ppr = p_elem.find(_w("pPr"))
    if ppr is None:
        ppr = p_elem.makeelement(_w("pPr"), {})
        # pPr 必须是 <w:p> 第一个子元素（OOXML 顺序）
        p_elem.insert(0, ppr)
    return ppr


def _body_index_of_p(doc, p_elem) -> int:
    """取 <w:p> 在 body 段落序列中的索引。"""
    body = doc.element.body
    idx = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is p_elem:
                return idx
            idx += 1
    raise StructureError("未在 body 中找到目标段落")


def _body_child_index(doc, elem) -> int:
    """取元素在 body 直接子级中的索引（含表格/sectPr）。"""
    body = doc.element.body
    for i, c in enumerate(body):
        if c is elem:
            return i
    raise StructureError("元素不在 body 直接子级中")


# ============================================================================
# 公共函数 1：add_page_break_before
# ============================================================================
def add_page_break_before(doc, anchor) -> dict:
    """
    给锚点段落 pPr 插入 <w:pageBreakBefore/>，使其从新页开始（语义层）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义（dict / int / <w:p>）

    返回：
        {doc, paragraph_index, added:bool, locator:"add_page_break_before",
         changes:[...]}

    依据说明：
        pPr 不存在则新建并插到段首；pageBreakBefore 已存在则幂等不重复插。
        插到 pPr 最前（Word 容忍顺序，pPr 子元素顺序规范中 pageBreakBefore
        靠前）。
    样式保护说明：
        - 只在 pPr 内加 <w:pageBreakBefore/>，不改其它样式子元素、不改 run。
        - 幂等：已存在时不重复插入。
    边界说明：
        - anchor 无法识别 -> 抛 WriterError（由 _resolve_anchor 抛）。
        - added=True 表示本次新增；False 表示已存在（幂等）。
    """
    p_elem = _resolve_anchor(doc, anchor)
    ppr = _ensure_ppr(p_elem)
    existing = ppr.find(_w("pageBreakBefore"))
    added = False
    if existing is None:
        pbb = ppr.makeelement(_w("pageBreakBefore"), {})
        # 插到 pPr 最前
        ppr.insert(0, pbb)
        added = True
    p_idx = _body_index_of_p(doc, p_elem)
    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "added": added,
        "locator": "add_page_break_before",
        "changes": [
            {"paragraph": p_idx, "path": "pPr.pageBreakBefore",
             "note": "新增 pageBreakBefore" if added else "pageBreakBefore 已存在（幂等）"}
        ],
    }


# ============================================================================
# 公共函数 2：remove_page_break
# ============================================================================
def remove_page_break(doc, anchor) -> dict:
    """
    移除锚点段落的分页：删 pPr 内 <w:pageBreakBefore/>，并删段内 run 里的
    <w:br w:type="page"/>（含承载该 br 且仅含 br 的空 run）（语义层）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义

    返回：
        {doc, paragraph_index, removed_pbb:bool, removed_br:bool,
         locator:"remove_page_break", changes:[...]}

    依据说明：
        实战中封面标题继承的 <w:br type="page"/> 会产生空白首页，必须一并清理。
        pPr/pageBreakBefore 直接 remove；段内 run 含 <w:br w:type="page"/> 的，
        若该 run 仅含 br（无 <w:t> 文本）则整个 run 删除，否则只删 br 元素。
    样式保护说明：
        - 只删 pageBreakBefore 与 type=page 的 <w:br>，不改其它样式/文本。
        - 承载 br 的空 run（仅含 br 无文本）整 run 删除；含文本的 run 只删 br。
    边界说明：
        - 无 pageBreakBefore 也无 br 时返回 removed_pbb=False, removed_br=False（不抛）。
        - anchor 无法识别 -> 抛 WriterError。
    """
    p_elem = _resolve_anchor(doc, anchor)
    removed_pbb = False
    removed_br = False

    ppr = p_elem.find(_w("pPr"))
    if ppr is not None:
        pbb = ppr.find(_w("pageBreakBefore"))
        if pbb is not None:
            ppr.remove(pbb)
            removed_pbb = True

    # 扫描段内 run 的 <w:br w:type="page">
    runs_to_remove = []
    for r in p_elem.findall(_w("r")):
        brs = [br for br in r.findall(_w("br"))
               if br.get(_w("type")) == "page"]
        if not brs:
            continue
        # 判断该 run 是否仅含 br（无 <w:t> 文本）
        has_text = any(t.text for t in r.findall(_w("t")))
        for br in brs:
            r.remove(br)
            removed_br = True
        if not has_text:
            # run 仅含 br（可能还有 rPr），整 run 删除
            runs_to_remove.append(r)
    for r in runs_to_remove:
        p_elem.remove(r)

    p_idx = _body_index_of_p(doc, p_elem)
    notes = []
    if removed_pbb:
        notes.append("删 pageBreakBefore")
    if removed_br:
        notes.append("删 br type=page")
    if not notes:
        notes.append("无分页可删（幂等）")
    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "removed_pbb": removed_pbb,
        "removed_br": removed_br,
        "locator": "remove_page_break",
        "changes": [
            {"paragraph": p_idx, "path": "pPr.pageBreakBefore/runs[].br",
             "note": "；".join(notes)}
        ],
    }


# ============================================================================
# 公共函数 3：remove_section_break
# ============================================================================
def remove_section_break(doc, anchor=None, all_inline=False) -> dict:
    """
    移除内嵌分节符（段落 pPr 内的 <w:sectPr>）（语义层）。

    参数：
        doc: Document 对象
        anchor: 非 None 时移该段的内嵌 sectPr。
        all_inline: True 时移除 body 中所有段落的内嵌 sectPr
                    （统一由末尾 body 级 sectPr 控制页面）。
        两者至少传一。

    返回：
        {doc, removed_count, removed:[{paragraph_index}],
         locator:"remove_section_break", changes:[...]}

    依据说明：
        移除内嵌 sectPr 后，其 headerReference/footerReference 关系成为孤儿
        （无害，Word 容忍）——属预期行为，不清理 rels。
    样式保护说明：
        - 只删 pPr 内的 <w:sectPr>，不动 pPr 其它子元素、不动 run。
        - 不删 body 末尾的 body 级 <w:sectPr>（始终保留）。
    边界说明：
        - anchor 与 all_inline 都未传 -> 抛 ValueError。
        - 指定段无内嵌 sectPr -> 不计入 removed（该段跳过）。
        - 孤儿 headerReference/footerReference 不清理（无害）。
    """
    if anchor is None and not all_inline:
        raise ValueError("anchor 与 all_inline 至少传一")

    removed = []
    if all_inline:
        paras = _body_paragraphs(doc)
        targets = paras
    else:
        p_elem = _resolve_anchor(doc, anchor)
        targets = [p_elem]

    for p in targets:
        ppr = p.find(_w("pPr"))
        if ppr is None:
            continue
        sect = ppr.find(_w("sectPr"))
        if sect is None:
            continue
        ppr.remove(sect)
        try:
            p_idx = _body_index_of_p(doc, p)
        except StructureError:
            p_idx = None
        removed.append({"paragraph_index": p_idx})

    changes = [{"paragraph": r["paragraph_index"], "path": "pPr.sectPr",
                "note": "移除内嵌 sectPr"} for r in removed]
    return {
        "doc": doc,
        "removed_count": len(removed),
        "removed": removed,
        "locator": "remove_section_break",
        "changes": changes,
    }


# ============================================================================
# 公共函数 4：delete_range
# ============================================================================
def delete_range(doc, start_anchor, end_anchor_exclusive=None, *,
                 delete_start=True) -> dict:
    """
    删除 body 中从 start_anchor 到 end_anchor_exclusive（不含）之间的所有
    子元素（p 与 tbl）（语义层）。

    参数：
        doc: Document 对象
        start_anchor: 锚点（dict/int/<w:p>）。delete_start=True 时连 start 段一起删；
                      False 时保留 start 段，从其下一个兄弟删起。
        end_anchor_exclusive: 锚点或 None。None 时删到 body 末尾 sectPr 前。
        delete_start: 是否连 start 段一起删（关键字参数，默认 True）。

    返回：
        {doc, deleted_count, deleted_paragraphs:int, deleted_tables:int,
         locator:"delete_range", changes:[...]}

    依据说明：
        锚点复用 _resolve_anchor（dict/int/<w:p>）。end 也同理。删除范围是
        body 直接子级序列上的区间（含表格）。
    样式保护说明：
        - 只删指定区间内的 body 子元素，不动区间外内容。
        - 不删 body 末尾 <w:sectPr>（始终保留）。
    边界说明：
        - start/end 不是 body 直接子元素 -> 抛 StructureError。
        - end 在 start 之前 -> 抛 StructureError。
        - end_anchor_exclusive 自身不删（exclusive 语义）。
        - 不删 body 末尾 <w:sectPr>（始终保留）。
    """
    body = doc.element.body
    start_p = _resolve_anchor(doc, start_anchor)
    if _local(start_p.tag) != "p":
        raise StructureError("start_anchor 必须是 <w:p>")
    start_bi = _body_child_index(doc, start_p)

    if end_anchor_exclusive is None:
        # 删到 body 末尾 sectPr 前
        end_bi = len(list(body))  # 越过末尾（sectPr 不删）
        # 找 sectPr 位置
        children = list(body)
        if children and _local(children[-1].tag) == "sectPr":
            end_bi = len(children) - 1
    else:
        end_p = _resolve_anchor(doc, end_anchor_exclusive)
        if _local(end_p.tag) != "p":
            raise StructureError("end_anchor_exclusive 必须是 <w:p>")
        end_bi = _body_child_index(doc, end_p)
        if end_bi <= start_bi:
            raise StructureError(
                f"end_anchor_exclusive（body 子级索引 {end_bi}）"
                f" 必须在 start（{start_bi}）之后")

    # 确定删除区间 [del_start, del_end)
    del_start = start_bi if delete_start else start_bi + 1
    del_end = end_bi
    if del_start >= del_end:
        # 空区间（如 delete_start=False 且 start 紧邻 end）
        return {
            "doc": doc, "deleted_count": 0, "deleted_paragraphs": 0,
            "deleted_tables": 0, "locator": "delete_range",
            "changes": [{"paragraph": None, "path": None,
                         "note": "空区间，无删除"}],
        }

    children = list(body)
    to_delete = children[del_start:del_end]
    # 保护：绝不删 sectPr
    if any(_local(c.tag) == "sectPr" for c in to_delete):
        raise StructureError("删除范围包含 sectPr（禁止删除 body 末尾 sectPr）")

    deleted_p = 0
    deleted_t = 0
    for c in to_delete:
        tag = _local(c.tag)
        if tag == "p":
            deleted_p += 1
        elif tag == "tbl":
            deleted_t += 1
        body.remove(c)

    return {
        "doc": doc,
        "deleted_count": len(to_delete),
        "deleted_paragraphs": deleted_p,
        "deleted_tables": deleted_t,
        "locator": "delete_range",
        "changes": [
            {"paragraph": None, "path": f"body[{del_start}:{del_end}]",
             "note": f"删除 {deleted_p} 段 + {deleted_t} 表"}
        ],
    }


# ============================================================================
# 公共函数 5：delete_section
# ============================================================================
def delete_section(doc, section_text, level=1, *,
                   delete_heading=True) -> dict:
    """
    删除某 H 标题章节的全部内容（标题到下一同级/更高级标题前）（语义层）。

    参数：
        doc: Document 对象
        section_text: 章节标题文本（子串匹配）。
        level: 章节标题层级 1~9。
        delete_heading: True 连标题段一起删；False 保留标题，删标题后到下一标题前。

    返回：
        {doc, section_heading:{index, text}, deleted_count,
         locator:"delete_section", changes:[...]}

    依据说明：
        复用 locate_by_heading 定位章节标题，再在 body 子级序列上确定下一
        同级/更高级标题的位置作为 end_anchor_exclusive，调用 delete_range。
    样式保护说明：
        - 只删章节范围内的 body 子元素，不动区间外内容。
        - 不删 body 末尾 <w:sectPr>。
    边界说明：
        - 章节未找到 -> 抛 LocateError（由 locate_by_heading 抛）。
        - 章节是文档最后一个标题（无下一标题）-> 删到 body 末尾 sectPr 前。
    """
    style_id_map = _style_id_to_name(doc if hasattr(doc, "part") else None)
    sec_loc = locate_by_heading(doc, text=section_text, level=level)
    sec_p = sec_loc["p_elem"]
    sec_idx = sec_loc["paragraph_index"]

    # 找下一同级/更高级标题作为 end
    body = doc.element.body
    children = list(body)
    try:
        start_bi = children.index(sec_p)
    except ValueError:
        raise StructureError("section 标题段不在 body 中")

    end_p = None
    for c in children[start_bi + 1:]:
        tag = _local(c.tag)
        if tag == "sectPr":
            break
        if tag != "p":
            continue
        hlv = _heading_level_of(c, style_id_map)
        if hlv is not None and hlv <= level:
            end_p = c
            break

    res = delete_range(doc, sec_p, end_p, delete_start=delete_heading)
    return {
        "doc": doc,
        "section_heading": {"index": sec_idx, "text": sec_loc["text"]},
        "deleted_count": res["deleted_count"],
        "locator": "delete_section",
        "changes": res["changes"],
    }


# ============================================================================
# 公共函数 6：insert_toc_field
# ============================================================================
def insert_toc_field(doc, anchor, toc_level="1-3", title="目  录",
                     page_break=True, update_prompt=True) -> dict:
    """
    在锚点段后插入「目录标题段 + 标准 TOC 域」（语义层）。

    参数：
        doc: Document 对象
        anchor: 锚点（dict/int/<w:p>），TOC 内容插到该段之后。
        toc_level: TOC 大纲层级范围，如 "1-3"。写入 instrText: TOC \\o "{toc_level}" \\h \\z \\u。
        title: 目录标题段文本。None 则不插标题段，只插 TOC 域段。
        page_break: True 时给标题段加 pageBreakBefore（目录独占一页）。
        update_prompt: True 时在 separate 后插灰色占位文本提示更新域。

    返回：
        {doc, anchor_paragraph_index, title_paragraph_index,
         toc_field_paragraph_index, locator:"insert_toc_field", changes:[...]}

    依据说明：
        TOC 域结构：fldChar(begin) → instrText('TOC \\o "1-3" \\h \\z \\u') →
        fldChar(separate) → 占位文本 → fldChar(end)。一个 <w:p> 内串这 5 个 run。
        title 段为普通段落（可带 pageBreakBefore）。新段插到锚点段之后
        （_insert_paragraph_after 的 addnext 语义，anchor 是 body 末尾段时
        落在 sectPr 前）。
    样式保护说明：
        - 新段无 pPr/rPr（走文档默认样式），不继承锚点样式（避免污染）。
        - 仅 page_break=True 时给标题段加 pageBreakBefore。
        - 不修改锚点段。
    边界说明：
        - anchor 是 body 末尾段（其后是 sectPr）时，新段插到 sectPr 前。
        - title=None 时 title_paragraph_index=None。
        - toc_level 字符串原样写入 instrText（调用方负责格式合法）。
    """
    anchor_p = _resolve_anchor(doc, anchor)
    anchor_idx = _body_index_of_p(doc, anchor_p)

    # 用 addnext 链式插入：从 anchor_p 之后依次插 title_p（可选）、toc_p
    insert_after = anchor_p
    title_p_idx = None
    toc_p_idx = None

    # 计算插入后各段的 body 段落索引（插入操作会改变索引，最后统一算）
    if title is not None:
        title_p = anchor_p.makeelement(_w("p"), {})
        if page_break:
            ppr = title_p.makeelement(_w("pPr"), {})
            pbb = ppr.makeelement(_w("pageBreakBefore"), {})
            ppr.append(pbb)
            title_p.append(ppr)
        # 标题文本 run
        r = title_p.makeelement(_w("r"), {})
        t = title_p.makeelement(_w("t"), {})
        t.text = title
        r.append(t)
        title_p.append(r)
        insert_after.addnext(title_p)
        insert_after = title_p

    # TOC 域段
    toc_p = anchor_p.makeelement(_w("p"), {})
    # 构造 5 个 run：begin / instrText / separate / 占位文本 / end
    # run1: fldChar begin
    r1 = toc_p.makeelement(_w("r"), {})
    fc1 = toc_p.makeelement(_w("fldChar"), {_w("fldCharType"): "begin"})
    r1.append(fc1)
    toc_p.append(r1)
    # run2: instrText
    r2 = toc_p.makeelement(_w("r"), {})
    instr = toc_p.makeelement(_w("instrText"), {qn("xml:space"): "preserve"})
    instr.text = f' TOC \\o "{toc_level}" \\h \\z \\u '
    r2.append(instr)
    toc_p.append(r2)
    # run3: fldChar separate
    r3 = toc_p.makeelement(_w("r"), {})
    fc3 = toc_p.makeelement(_w("fldChar"), {_w("fldCharType"): "separate"})
    r3.append(fc3)
    toc_p.append(r3)
    # run4: 占位文本（更新提示）
    r4 = toc_p.makeelement(_w("r"), {})
    if update_prompt:
        rpr4 = toc_p.makeelement(_w("rPr"), {})
        color = toc_p.makeelement(_w("color"), {_w("val"): "808080"})
        rpr4.append(color)
        r4.append(rpr4)
        t4 = toc_p.makeelement(_w("t"), {})
        t4.text = '（请在 Word 中右键此处选择"更新域"以生成带页码的目录）'
        r4.append(t4)
    toc_p.append(r4)
    # run5: fldChar end
    r5 = toc_p.makeelement(_w("r"), {})
    fc5 = toc_p.makeelement(_w("fldChar"), {_w("fldCharType"): "end"})
    r5.append(fc5)
    toc_p.append(r5)

    insert_after.addnext(toc_p)

    # 重新计算索引
    body = doc.element.body
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                anchor_idx = p_counter
            elif title is not None and c is title_p:
                title_p_idx = p_counter
            elif c is toc_p:
                toc_p_idx = p_counter
            p_counter += 1

    changes = []
    if title is not None:
        changes.append({"paragraph": title_p_idx, "path": None,
                        "note": f"插入目录标题段 {title!r}（pageBreakBefore={page_break}）"})
    changes.append({"paragraph": toc_p_idx, "path": None,
                    "note": f"插入 TOC 域段（level={toc_level}）"})

    return {
        "doc": doc,
        "anchor_paragraph_index": anchor_idx,
        "title_paragraph_index": title_p_idx,
        "toc_field_paragraph_index": toc_p_idx,
        "locator": "insert_toc_field",
        "changes": changes,
    }


# ============================================================================
# 公共函数 7：renumber_list —— 排序列表编号快速重排序
# ============================================================================
# 默认段首编号文本匹配模式：覆盖常见「手动文本编号」形态。
#   "4." "4、" "4)" "(4)" "4.1." 等 —— 一串数字 + 可选点号/顿号/右括号，
#   或被括号包裹。仅匹配段首（re.match），不动段中其它数字。
# 三个捕获组：
#   group(1) lparen：可选左括号 "("（括号包裹形态，如 "(4)"）
#   group(2) digits：编号数字本体（含多级，如 "4.1.2"）
#   group(3) sep：结尾分隔符 "." / "、" / ")"
_MANUAL_NUM_RE = re.compile(
    r"\s*"
    r"(?P<lparen>\()?"        # 可选左括号
    r"(?P<digits>\d+(?:\.\d+)*)"  # 编号数字本体（含多级）
    r"\s*"
    r"(?P<sep>[.、\)])"        # 结尾分隔符：点 / 顿号 / 右括号
)


def _format_manual_number(rank: int, match) -> str:
    """
    按原编号的形态，把 1-based 的 rank 渲染成新编号文本。
    match 是 _MANUAL_NUM_RE 的匹配对象：括号形态 -> "(rank)"；
    多级编号只替换首级（如 "4.1." -> "1.1."），其余层级原样保留；
    单级则用原分隔符拼 rank。
    """
    digits = match.group("digits")
    lparen = match.group("lparen")
    sep = match.group("sep")
    # 多级编号（含 "."）：只替换第一级数字，后续层级保留
    if "." in digits:
        parts = digits.split(".")
        parts[0] = str(rank)
        new_digits = ".".join(parts)
    else:
        new_digits = str(rank)
    if lparen:
        return f"({new_digits})"   # 括号形态：右括号已由 sep 给出
    return f"{new_digits}{sep}"


def _get_numpr(p_elem):
    """取段落 pPr 内的 <w:numPr>；无则 None。"""
    ppr = p_elem.find(_w("pPr"))
    if ppr is None:
        return None
    return ppr.find(_w("numPr"))


def _numpr_id(numpr):
    """取 numPr 的 (numId, ilvl)，缺失值记为 None。"""
    numid_el = numpr.find(_w("numId"))
    ilvl_el = numpr.find(_w("ilvl"))
    numid = numid_el.get(_w("val")) if numid_el is not None else None
    ilvl = ilvl_el.get(_w("val")) if ilvl_el is not None else "0"
    return numid, ilvl


def _clone_num_definition(doc, src_numid: str) -> str:
    """
    克隆一个 numId（连同其 abstractNum 定义），返回新 numId（字符串）。
    用于「自动编号续号」场景：给一组段落分配全新独立的列表定义，
    使其从 1 起号，与原 numId 的其它列表互不干扰。

    实现：
      - 读 numbering part；deepcopy 源 numId 指向的 abstractNum，换新 id；
      - deepcopy 源 <w:num> 节点，换新 numId 并指向新 abstractNumId；
      - 新 abstractNum 不带 lvlOverride/lvlRestart 显式覆盖，按 ilvl 顺序
        自然从 1 起号（OOXML 同一 numId 下同 ilvl 的段落按出现顺序递增）。
    无 numbering part 时抛 StructureError。
    """
    pkg = doc.part.package
    numbering_part = None
    for part in pkg.iter_parts():
        if part.partname.endswith("/numbering.xml"):
            numbering_part = part
            break
    if numbering_part is None:
        raise StructureError("文档无 numbering part，无法处理自动编号列表")

    nroot = numbering_part._element  # <w:numbering>
    # 找源 num -> abstractNumId
    src_num = None
    for n in nroot.findall(_w("num")):
        if n.get(_w("numId")) == src_numid:
            src_num = n
            break
    if src_num is None:
        raise StructureError(f"numbering.xml 中找不到 numId={src_numid}")
    src_absid = src_num.find(_w("abstractNumId")).get(_w("val"))

    # 找源 abstractNum
    src_abs = None
    for an in nroot.findall(_w("abstractNum")):
        if an.get(_w("abstractNumId")) == src_absid:
            src_abs = an
            break
    if src_abs is None:
        raise StructureError(f"numbering.xml 中找不到 abstractNumId={src_absid}")

    # 分配新 id（取现有最大值 +1）
    existing_abs = [int(an.get(_w("abstractNumId"))) for an in nroot.findall(_w("abstractNum"))]
    existing_num = [int(n.get(_w("numId"))) for n in nroot.findall(_w("num"))]
    new_absid = str(max(existing_abs + [0]) + 1)
    new_numid = str(max(existing_num + [0]) + 1)

    # 克隆 abstractNum（换 id），插到 <w:numbering> 中 abstractNum 区（靠前）
    new_abs = deepcopy(src_abs)
    new_abs.set(_w("abstractNumId"), new_absid)
    # 插到第一个 abstractNum 之前（abstractNum 必须在 num 之前，OOXML 顺序）
    first_abs = nroot.find(_w("abstractNum"))
    if first_abs is not None:
        first_abs.addprevious(new_abs)
    else:
        nroot.insert(0, new_abs)

    # 克隆 num（换 numId 与 abstractNumId 引用）
    new_num = deepcopy(src_num)
    new_num.set(_w("numId"), new_numid)
    new_num.find(_w("abstractNumId")).set(_w("val"), new_absid)
    nroot.append(new_num)

    return new_numid


def renumber_list(doc, anchors, *, mode="auto", start: int = 1) -> dict:
    """
    排序列表编号快速重排序：把一组列表段落的编号从「错乱的 4、5、6」
    重排为「连续的 1、2、3」（语义层）。

    自动检测两种成因并分别处理：

    A. 自动编号（numPr）：段落带 <w:numPr><w:numId/></w:numPr>，编号文本不在
       段落里、由 Word 渲染时算出。常见「4、5、6」成因是多个本该独立的列表
       复用了同一个 numId 导致续号。修法：给这组段落克隆出一个全新独立的
       numId（连带克隆其 abstractNum 定义），使其从 `start` 起号。

    B. 手动文本编号：段落开头是「4.」「4、」「(4)」「4)」等纯文本字符，
       无 numPr。修法：按段落在组内的位置 rank（从 start 起），把段首
       编号文本替换为「1.」「2.」「3.」…（沿用原分隔符形态）。

    参数：
        doc: Document 对象
        anchors: 列表段落的锚点序列（list/tuple），每个元素复用 _resolve_anchor
                语义（dict / int / <w:p>）。顺序即重排后的编号顺序。
        mode: "auto"（默认，自动检测）/ "numpr"（仅处理自动编号段，手动段报错）
              / "text"（仅处理手动文本编号段，自动编号段报错）。
        start: 起始编号，默认 1。

    返回：
        {doc, mode_detected:"numpr"|"text"|"mixed", start:int, count:int,
         renumbered:[{paragraph_index, rank, old, new, kind}], locator,
         changes:[...]}

    依据说明：
        - mode="auto" 时按首个段落的成因判定整组走哪条路径（numPr 优先）。
          组内成因不一致（既有 numPr 又有纯文本）记 mode_detected="mixed"，
          但仍按首个成因统一处理并逐项标注 kind。
        - 自动编号：克隆 numId 后，将组内每个段落的 numId 改为新值；ilvl 不变
          （多级列表只重排命中段所在的层级序列）。同一新 numId 下，组内同 ilvl
          段按文档顺序递增，故首个段即 start。组外引用同 numId 的段落保持原样
          （仍用旧 numId，不受影响）。
        - 手动文本：用 _MANUAL_NUM_RE 匹配段首，未命中抛 StructureError（避免
          把无编号段误当列表项）。替换时复用首个有 rPr 的 run 作模板（保样式），
          仅改段首编号文本，段中正文不动。
    样式保护说明：
        - 自动编号：只改 numId 值与新增 numbering 定义，不动段落 pPr 其它子元素、
          不动 run、不动旧 numId/abstractNum（旧定义保留供其它列表继续使用）。
        - 手动文本：只替换段首编号 run 的文本，正文 run 与 pPr/rPr 全部保留。
    边界说明：
        - anchors 为空 -> 抛 ValueError。
        - mode="auto" 下，组内任一段既无 numPr 又无段首编号文本 -> 抛
          StructureError（无法判定为列表项）。
        - mode="numpr"/"text" 下遇到不匹配成因的段 -> 抛 StructureError。
        - 自动编号模式下若文档无 numbering part -> 抛 StructureError。
        - 仅处理 anchors 显式给出的段落；不会顺带重排它们之间的其它列表段。
    """
    if not anchors:
        raise ValueError("anchors 不能为空")
    if start < 0:
        raise ValueError("start 必须 >= 0")
    if mode not in ("auto", "numpr", "text"):
        raise ValueError(f"mode 必须是 auto/numpr/text，实得 {mode!r}")

    p_elems = [_resolve_anchor(doc, a) for a in anchors]

    # 探测每段成因
    kinds = []
    for p in p_elems:
        numpr = _get_numpr(p)
        if numpr is not None and numpr.find(_w("numId")) is not None:
            kinds.append("numpr")
        else:
            kinds.append("text")
    has_numpr = "numpr" in kinds
    has_text = "text" in kinds
    detected = "mixed" if (has_numpr and has_text) else ("numpr" if has_numpr else "text")

    # 按 mode 选定处理路径
    if mode == "numpr":
        path = "numpr"
        if has_text:
            raise StructureError(
                f"mode=numpr 但组内存在无 numPr 的段落（索引位 "
                f"{[i for i,k in enumerate(kinds) if k=='text']}）")
    elif mode == "text":
        path = "text"
        if has_numpr:
            raise StructureError(
                f"mode=text 但组内存在带 numPr 的段落（索引位 "
                f"{[i for i,k in enumerate(kinds) if k=='numpr']}）")
    else:  # auto
        path = "numpr" if has_numpr else "text"

    renumbered = []

    if path == "numpr":
        # 取首个 numPr 段的 numId 作为克隆源（统一克隆一次，组内共用新 numId）
        src_numid = None
        for p, k in zip(p_elems, kinds):
            if k == "numpr":
                src_numid, _ = _numpr_id(_get_numpr(p))
                break
        new_numid = _clone_num_definition(doc, src_numid)
        for rank0, (p, k) in enumerate(zip(p_elems, kinds)):
            rank = start + rank0
            if k == "numpr":
                numpr = _get_numpr(p)
                old_numid, ilvl = _numpr_id(numpr)
                # 改 numId 指向新定义
                numid_el = numpr.find(_w("numId"))
                numid_el.set(_w("val"), new_numid)
                renumbered.append({
                    "paragraph_index": _body_index_of_p(doc, p),
                    "rank": rank, "old": f"numId={old_numid}",
                    "new": f"numId={new_numid}", "kind": "numpr",
                })
            else:
                # mixed 组里的 text 段：按文本路径单独处理其段首编号
                rank_info = _renumber_text_head(p, rank)
                rank_info["paragraph_index"] = _body_index_of_p(doc, p)
                rank_info["kind"] = "text"
                renumbered.append(rank_info)
    else:
        for rank0, p in enumerate(p_elems):
            rank = start + rank0
            info = _renumber_text_head(p, rank)
            info["paragraph_index"] = _body_index_of_p(doc, p)
            info["kind"] = "text"
            renumbered.append(info)

    changes = [{
        "paragraph": r["paragraph_index"], "path": None,
        "note": f"#{r['rank']} ({r['kind']}): {r['old']} -> {r['new']}"
    } for r in renumbered]

    return {
        "doc": doc,
        "mode_detected": detected,
        "start": start,
        "count": len(renumbered),
        "renumbered": renumbered,
        "locator": "renumber_list",
        "changes": changes,
    }


def _renumber_text_head(p_elem, rank: int) -> dict:
    """
    替换段落段首的「手动文本编号」为 rank（沿用原分隔符形态）。
    未命中编号模式 -> 抛 StructureError。返回 {rank, old, new}。
    """
    # 取首个含 <w:t> 的 run 文本（编号通常就在第一个文本 run）
    first_run = None
    for r in p_elem.findall(_w("r")):
        if r.findall(_w("t")):
            first_run = r
            break
    if first_run is None:
        raise StructureError("段落无文本 run，无法识别手动编号")
    # 拼接该 run 内全部 <w:t> 文本做匹配（编号可能跨多个 t）
    t_els = first_run.findall(_w("t"))
    run_text = "".join((t.text or "") for t in t_els)
    m = _MANUAL_NUM_RE.match(run_text)
    if not m:
        raise StructureError(
            f"段首未识别为列表编号（手动文本模式）：{run_text[:20]!r}")
    old_head = m.group(0).strip()
    new_head = _format_manual_number(rank, m)
    # 替换：把匹配到的段首部分换成 new_head，余下文本保留
    rest = run_text[m.end():]
    new_text = new_head + rest
    # 写回：首个 <w:t> 承载新文本，其余 <w:t> 清空（保 run 结构与 rPr）
    t_els[0].text = new_text
    t_els[0].set(qn("xml:space"), "preserve")
    for t in t_els[1:]:
        t.text = ""
    return {"rank": rank, "old": old_head, "new": new_head.strip()}


# ============================================================================
# 公共函数 8：merge_documents —— 文档合并
# ============================================================================
def merge_documents(
    master_path: str,
    part_paths: list[str],
    output_path: str | None = None,
    *,
    insert_page_break: bool = False,
    strip_source_heading_numbers: bool = False,
) -> dict:
    """
    把多个 part docx 的 body 子元素（除末尾 sectPr）依次追加到 master 末尾 sectPr 前，
    自动迁移 styles/images/numbering 依赖并重映射引用。

    参数：
        master_path: 主文档路径（合并基准）
        part_paths: 要合并的子文档路径列表（按顺序追加）
        output_path: 输出路径，默认覆盖 master_path
        insert_page_break: True 时每个 part 的首个元素前插一个含 <w:br type=page>
                          的分页段。
        strip_source_heading_numbers: True 时对每个 part 的标题段剥除段首编号
                                     （复用 _MANUAL_NUM_RE），避免合并后编号重复。

    返回：
        {
          "output_path": str,
          "merged_parts": int,
          "total_inserted": int,
          "style_map": dict,
          "num_map": dict,
          "image_map": dict,
          "changes": [...]
        }

    依据说明：
        加载 master doc；对每个 part：取其 body 全部子元素（排除末尾 body 级
        <w:sectPr>），deepcopy → collect_elements_dependencies → 按「numbering→styles
        →images」迁移到 master → remap_elements → 插入到 master body 末尾 sectPr 之前。
        迁移顺序与 _xdoc.py / ai-bid-v3 一致。
    样式保护说明：
        - 所有元素 deepcopy；样式/编号/图片定义 deepcopy 注入，不手工重建。
        - 冲突加后缀去重（ensure_styles 已处理）。
        - 保留 master 末尾 sectPr（页面设置不丢）。
        - part 的内嵌 sectPr（段落 pPr 内的）随段 deepcopy 保留。
    边界说明：
        - master 或任一 part 不可打开 -> 抛 StructureError（含路径）。
        - part_paths 为空 -> 抛 ValueError。
        - part 无 body -> 抛 StructureError。
        - strip_source_heading_numbers 只剥段首编号文本（不删 numPr），未匹配编号的标题段跳过。
    """
    if not part_paths:
        raise ValueError("part_paths 不能为空")

    from src._xdoc import (
        collect_elements_dependencies, remap_elements,
        ensure_numbering, ensure_styles, ensure_images, max_bookmark_id,
    )

    NUM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"
    STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"

    try:
        master_doc = Document(master_path)
    except Exception as e:
        raise StructureError(f"主文档无法打开: {master_path} ({e})")

    master_body = master_doc.element.body
    # 找 master body 末尾 sectPr（插入点在其之前）
    master_sectpr = None
    master_children = list(master_body)
    if master_children and _local(master_children[-1].tag) == "sectPr":
        master_sectpr = master_children[-1]

    total_style_map: dict[str, str] = {}
    total_num_map: dict[str, str] = {}
    total_image_map: dict[str, str] = {}
    total_inserted = 0
    changes = []

    for part_idx, part_path in enumerate(part_paths):
        try:
            part_doc = Document(part_path)
        except Exception as e:
            raise StructureError(f"子文档无法打开: {part_path} ({e})")

        part_body = part_doc.element.body
        part_children = list(part_body)
        # 排除末尾 body 级 sectPr
        part_elems = []
        for c in part_children:
            if _local(c.tag) == "sectPr":
                continue
            part_elems.append(c)

        if not part_elems:
            raise StructureError(f"子文档无 body 子元素: {part_path}")

        # deepcopy 全部元素
        new_elems = [deepcopy(e) for e in part_elems]

        # strip_source_heading_numbers：剥除标题段段首编号文本
        if strip_source_heading_numbers:
            for el in new_elems:
                if _local(el.tag) != "p":
                    continue
                _strip_heading_number(el)

        # 收集依赖
        deps = collect_elements_dependencies(new_elems)
        src_style_ids = set(deps["rStyles"]) | deps["pStyles"] | deps["tblStyles"]

        # numbering 复制
        for src_nid in deps["numIds"]:
            try:
                src_numbering_root = part_doc.part.part_related_by(NUM_REL).element
                tgt_num_id = ensure_numbering(master_doc, src_numbering_root, src_nid)
                total_num_map[src_nid] = tgt_num_id
            except (AttributeError, ValueError) as e:
                raise StructureError(f"编号复制失败（part={part_path}, numId={src_nid}）: {e}")

        # styles 复制
        if src_style_ids:
            src_styles_root = part_doc.part.part_related_by(STYLES_REL).element
            smap = ensure_styles(master_doc, src_styles_root, src_style_ids, total_num_map)
            total_style_map.update(smap)

        # 图片复制
        if deps["image_rids"]:
            imap = ensure_images(master_doc, part_doc, deps["image_rids"])
            total_image_map.update(imap)

        # 重映射
        bookmark_start = max_bookmark_id(master_doc) + 1
        remap_elements(new_elems, total_style_map, total_num_map, total_image_map,
                       bookmark_start)

        # insert_page_break：在首个元素前插分页段
        if insert_page_break:
            pb_p = master_body.makeelement(_w("p"), {})
            pb_r = master_body.makeelement(_w("r"), {})
            pb_br = master_body.makeelement(_w("br"), {_w("type"): "page"})
            pb_r.append(pb_br)
            pb_p.append(pb_r)
            new_elems.insert(0, pb_p)

        # 插入到 master body 末尾 sectPr 之前
        for el in new_elems:
            if master_sectpr is not None:
                master_sectpr.addprevious(el)
            else:
                master_body.append(el)

        total_inserted += len(new_elems)
        copied_imgs = sum(1 for v in (total_image_map.values()) if v)
        changes.append({
            "paragraph": None, "path": None,
            "note": f"合并 part[{part_idx}]={part_path}（插入{len(new_elems)}元素）"
        })

    out = output_path or master_path
    master_doc.save(out)

    copied_imgs = sum(1 for v in total_image_map.values() if v)
    return {
        "output_path": out,
        "merged_parts": len(part_paths),
        "total_inserted": total_inserted,
        "style_map": total_style_map,
        "num_map": total_num_map,
        "image_map": total_image_map,
        "copied_images": copied_imgs,
        "changes": changes,
    }


def _strip_heading_number(p_elem):
    """
    剥除标题段落段首的手动文本编号（用 _MANUAL_NUM_RE 匹配）。
    仅改首个含 <w:t> 的 run 的文本，不删 numPr。未匹配则跳过。
    """
    first_run = None
    for r in p_elem.findall(_w("r")):
        if r.findall(_w("t")):
            first_run = r
            break
    if first_run is None:
        return
    t_els = first_run.findall(_w("t"))
    run_text = "".join((t.text or "") for t in t_els)
    m = _MANUAL_NUM_RE.match(run_text)
    if not m:
        return
    rest = run_text[m.end():]
    t_els[0].text = rest
    t_els[0].set(qn("xml:space"), "preserve")
    for t in t_els[1:]:
        t.text = ""


# ============================================================================
# 公共函数 9：renumber_headings —— 标题编号注入（P0-4）
# ============================================================================
_CN_UNITS = "一二三四五六七八九"


def _to_chinese_ordinal(n: int) -> str:
    """将正整数转换为中文序号字符串（一/二/…/十/十一/…/九十九）。
    参考 ai-bid-v3 assembler.py::_to_chinese_ordinal。"""
    if n <= 0:
        return str(n)
    if n <= 9:
        return _CN_UNITS[n - 1]
    if n == 10:
        return "十"
    if n <= 19:
        return "十" + _CN_UNITS[n - 11]
    tens, ones = divmod(n, 10)
    result = _CN_UNITS[tens - 1] + "十"
    if ones:
        result += _CN_UNITS[ones - 1]
    return result


# 标题段首编号前缀匹配（剥除用）。覆盖：
#   - 中文数字 + 强制分隔符：一、 / 第一章 / (一) / （一）
#   - 阿拉伯数字（含多级）：1. / 1.1 / 1.1.1 / 1、 / (1)
# 参考 ai-bid-v3 block_numbering.py::_VISIBLE_NUMBER_RE，扩展「第X章」形态。
_HEADING_NUM_PREFIX_RE = re.compile(
    r"^\s*"
    r"(?:"
    r"第[一二三四五六七八九十百零〇0-9]+[章节篇部]"   # 第一章 / 第二节
    r"|[一二三四五六七八九十百]+[、．.：:]"            # 一、 二．
    r"|[（(][一二三四五六七八九十百]+[)）]"            # (一) （一）
    r"|[（(]\d+(?:[.．]\d+)*[)）]"                     # (1) （1.1）
    r"|\d+(?:[.．、]\d+)*[.．、]?"                     # 1. / 1.1 / 1、 / 1.1.
    r")"
    r"\s*"
)


def _strip_heading_number_prefix(text: str) -> str:
    """剥除标题文本段首的手动编号前缀，保留标题正文。
    覆盖「第X章/一、/1./1.1/(一)」等形态。未匹配则原样返回。"""
    m = _HEADING_NUM_PREFIX_RE.match(text)
    if not m:
        return text
    return text[m.end():].lstrip()


def _replace_heading_text(p_elem, new_text: str):
    """替换标题段全部文本为 new_text，保留首个有 rPr 的 run 作模板（deepcopy），
    删旧 <w:r>/<w:hyperlink>，建单 run。参考 ai-bid-v3 _replace_paragraph_text。"""
    # 取首个有 rPr 的 run 作模板（参考 writer.set_paragraph_text 逻辑）
    rpr_template = None
    for r in p_elem.findall(_w("r")):
        rpr = r.find(_w("rPr"))
        if rpr is not None and len(rpr) > 0:
            rpr_template = rpr
            break
    if rpr_template is None:
        # 退而求其次：首个有文本 run 的 rPr
        for r in p_elem.findall(_w("r")):
            if r.findall(_w("t")):
                rpr_template = r.find(_w("rPr"))
                break

    # 删段落内所有 <w:r> 与 <w:hyperlink>（保留 pPr、bookmarkStart/End 等）
    for r in list(p_elem.findall(_w("r"))):
        p_elem.remove(r)
    for hl in list(p_elem.findall(_w("hyperlink"))):
        p_elem.remove(hl)

    # 建单 run（rPr deepcopy + <w:t>）
    new_r = p_elem.makeelement(_w("r"), {})
    if rpr_template is not None:
        new_r.append(deepcopy(rpr_template))
    t = new_r.makeelement(_w("t"), {qn("xml:space"): "preserve"})
    t.text = new_text
    new_r.append(t)
    p_elem.append(new_r)


def renumber_headings(doc, *, levels=(1, 2, 3), skip_titles=None,
                      h1_style="chinese", h2_style="decimal") -> dict:
    """
    扫描全文标题段，剥除原编号后按层级重写：H1→中文序号「一、二、…」，
    H2/H3→十进制「1.1 / 1.1.1」（语义层 / P0-4）。

    参数：
        doc: Document 对象
        levels: 参与重编号的标题层级元组（默认 (1,2,3)）。不在列表中的层级标题
               不重编号（但仍参与计数器重置判定）。
        skip_titles: list[str]，标题正文（strip 后）子串匹配则跳过不编号
                    （如「目录」「附件」）。None 不跳过。
        h1_style: H1 编号风格 "chinese"（一、二）或 "decimal"（1. 2.）。
        h2_style: H2+ 编号风格（当前仅 "decimal"）。

    返回：
        {renumbered:[{paragraph_index, level, old, new}], count:int,
         locator:"renumber_headings", changes:[...]}

    依据说明：
        遍历 body 段落，用 locator._heading_level_of(p)（已认 pStyle+outlineLvl
        两种来源）判定标题层级。计数器数组 counters[level-1]，遇某级标题：该级+1，
        更深层级清零（参考 ai-bid-v3 _renumber_headings）。先剥除标题段原有编号
        前缀（_strip_heading_number_prefix），再按风格拼新编号：
          - H1 chinese → _to_chinese_ordinal(counters[0])+"、"+title
          - H1 decimal → str(counters[0])+"."+title
          - H2+ decimal → ".".join(counters[:level])+" "+title
        替换段落文本保留首个 run 的 rPr（_replace_heading_text，参考
        ai-bid-v3 _replace_paragraph_text）。
    样式保护说明：
        - 仅改标题段文本（保留 pPr 与首个 run 的 rPr），不改 pPr/样式。
        - 非 levels 内的标题段不改文本（但仍参与计数器重置，使层级连续）。
        - skip_titles 命中的标题段不改文本、不递增计数器（跳过）。
    边界说明：
        - 无标题段 -> 返回 count=0，不抛。
        - 标题段无文本（strip 后空）-> 跳过不编号。
        - skip_titles 子串匹配（非精确），标题正文 strip 后包含任一关键词即跳过。
    """
    levels = tuple(levels)
    max_level = max(levels) if levels else 9
    counters = [0] * max_level
    skip_set = list(skip_titles) if skip_titles else []

    style_id_map = _style_id_to_name(doc if hasattr(doc, "part") else None)
    paras = _body_paragraphs(doc)
    renumbered = []
    changes = []

    for p in paras:
        hlv = _heading_level_of(p, style_id_map)
        if hlv is None:
            continue
        if hlv > max_level:
            # 超出处理范围：不影响计数器（保持原状）
            continue
        old_text = _paragraph_text(p).strip()
        if not old_text:
            # 空标题段：不编号但计数器仍需处理（维持层级连续）
            # 此处按 ai-bid-v3 逻辑：空文本跳过
            continue

        title = _strip_heading_number_prefix(old_text)
        # skip_titles 子串匹配
        if any(kw in title for kw in skip_set):
            continue

        if hlv not in levels:
            # 不在重编号范围：仅重置更深层级计数器，不改文本
            counters[hlv - 1] += 1
            for ri in range(hlv, max_level):
                counters[ri] = 0
            continue

        # 递增计数器，更深层级清零
        counters[hlv - 1] += 1
        for ri in range(hlv, max_level):
            counters[ri] = 0

        # 拼新编号
        if hlv == 1:
            if h1_style == "chinese":
                new_text = f"{_to_chinese_ordinal(counters[0])}、{title}"
            else:  # decimal
                new_text = f"{counters[0]}.{title}"
        else:
            # H2+ decimal：补齐父级（若父级计数器为 0 则视为 1）
            parts = list(counters[:hlv])
            for i in range(hlv - 1):
                if parts[i] == 0:
                    parts[i] = 1
            number = ".".join(str(x) for x in parts)
            new_text = f"{number} {title}"

        _replace_heading_text(p, new_text)
        p_idx = _body_index_of_p(doc, p)
        renumbered.append({
            "paragraph_index": p_idx, "level": hlv,
            "old": old_text, "new": new_text,
        })
        changes.append({
            "paragraph": p_idx, "path": None,
            "note": f"L{hlv}: {old_text!r} -> {new_text!r}"
        })

    return {
        "renumbered": renumbered,
        "count": len(renumbered),
        "locator": "renumber_headings",
        "changes": changes,
    }


# ============================================================================
# 公共函数 11：update_toc_field —— TOC 域更新填充（P1-7）
# ============================================================================
def update_toc_field(docx_path, *, soffice_path=None, output_path=None) -> dict:
    """
    通过 LibreOffice headless 转换触发 TOC 域更新，生成实际条目+页码
    （语义层 / P1-7）。

    参数：
        docx_path: docx 文件路径
        soffice_path: LibreOffice 可执行路径；None 时探测（复用 verifier
                      _probe_soffice）。
        output_path: 输出路径；None 时覆盖输入。

    返回：
        {output_path, soffice_path, toc_updated:bool, entry_count:int,
         locator:"update_toc_field", changes:[...]}

    依据说明：
        LibreOffice headless 转 docx→docx（MS Word 2007 XML 过滤器）时会更新
        dirty 域（TOC 域 begin 标 dirty=true）。复用 verifier._probe_soffice
        探测 LibreOffice（与 render_to_pdf_and_check 一致）。转换后输出 docx
        的 TOC 域被填充为实际条目+页码。entry_count 统计 TOC 域后含页码的
        条目段数。
    样式保护说明：
        - LibreOffice 转换是黑盒：它会规范化文档（可能微调 XML），但 TOC 域
          与正文样式语义不变。本函数不手工改 XML，仅依赖 LibreOffice 渲染。
    边界说明：
        - LibreOffice 探测不到 -> 抛 VerifierError（附安装提示，与
          render_to_pdf_and_check 一致）。
        - 文档无 TOC 域 -> toc_updated=False，不抛（但仍执行转换，输出可打开）。
        - 转换失败 -> 抛 VerifierError（含 stderr）。
        - 输入文件不存在 -> 抛 VerifierError。
    """
    import os as _os
    import shutil as _shutil
    import subprocess as _subprocess
    import tempfile as _tempfile

    from src.verifier import _probe_soffice, VerifierError

    # 探测 soffice
    soffice = soffice_path
    if soffice is None:
        soffice = _probe_soffice()
    if soffice is None or not _os.path.exists(soffice):
        raise VerifierError(
            "未找到 LibreOffice（soffice）。请安装 LibreOffice 或通过 soffice_path "
            "参数指定路径。探测位置：shutil.which('soffice'/'libreoffice') + "
            r"C:\Program Files\LibreOffice\program\soffice.exe")

    docx_path = _os.path.abspath(docx_path)
    if not _os.path.exists(docx_path):
        raise VerifierError(f"docx 文件不存在: {docx_path}")

    out = _os.path.abspath(output_path) if output_path else docx_path

    # 先检测输入是否含 TOC 域
    has_toc_input = _docx_has_toc_field(docx_path)

    # LibreOffice headless 转 docx->docx（更新 dirty 域）
    with _tempfile.TemporaryDirectory(prefix="toc_update_") as tmpdir:
        cmd = [soffice, "--headless", "--convert-to",
               "docx:MS Word 2007 XML", "--outdir", tmpdir, docx_path]
        proc = _subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=180)
        if proc.returncode != 0:
            raise VerifierError(
                f"LibreOffice 转换失败（returncode={proc.returncode}）：\n"
                f"stderr: {proc.stderr}\nstdout: {proc.stdout}")
        converted = _os.path.join(
            tmpdir, _os.path.splitext(_os.path.basename(docx_path))[0] + ".docx")
        if not _os.path.exists(converted):
            raise VerifierError(f"转换后 docx 未生成: {converted}")
        # 移动到目标输出
        _shutil.move(converted, out)

    # 统计输出 docx 的 TOC 条目数（域后含页码的段）
    entry_count = _count_toc_entries(out)
    # toc_updated：输入有 TOC 域 即视为已更新（LibreOffice 会填充）
    toc_updated = has_toc_input

    return {
        "output_path": out,
        "soffice_path": soffice,
        "toc_updated": toc_updated,
        "entry_count": entry_count,
        "locator": "update_toc_field",
        "changes": [{
            "paragraph": None, "path": None,
            "note": f"LibreOffice 转换更新 TOC 域（has_toc={has_toc_input}，"
                    f"entries={entry_count}）"
        }],
    }


def _docx_has_toc_field(docx_path) -> bool:
    """检测 docx 的 body 是否含 instrText 含 'TOC' 的域。"""
    import zipfile as _zf
    try:
        with _zf.ZipFile(docx_path) as zf:
            data = zf.read("word/document.xml")
    except (KeyError, _zf.BadZipFile):
        return False
    try:
        tree = etree.fromstring(data)
    except etree.XMLSyntaxError:
        return False
    for it in tree.iter(_w("instrText")):
        if it.text and "TOC" in it.text:
            return True
    return False


def _count_toc_entries(docx_path) -> int:
    """统计 docx 中 TOC 域后含页码的条目段数（启发式：段落含 <w:hyperlink>
    且其 anchor 以 _Toc 开头，或段落含制表符+数字页码形态）。"""
    import zipfile as _zf
    try:
        with _zf.ZipFile(docx_path) as zf:
            data = zf.read("word/document.xml")
    except (KeyError, _zf.BadZipFile):
        return 0
    try:
        tree = etree.fromstring(data)
    except etree.XMLSyntaxError:
        return 0
    body = tree.find(_w("body"))
    if body is None:
        return 0
    # 找 TOC 域起始（instrText 含 TOC）
    toc_started = False
    count = 0
    for p in body.iter(_w("p")):
        if not toc_started:
            for it in p.iter(_w("instrText")):
                if it.text and "TOC" in it.text:
                    toc_started = True
                    break
            if not toc_started:
                continue
        # toc_started 后：统计含 _Toc 书签超链接的条目段（TOC 条目典型形态）
        for hl in p.iter(_w("hyperlink")):
            anchor = hl.get(_w("anchor")) or ""
            if anchor.startswith("_Toc"):
                count += 1
                break
    return count


# ============================================================================
# 页眉页脚文本写入（P0-3 配套：文本级写入）
# ============================================================================
# which(对外 API) -> python-docx Section 上的代理属性名
_HF_WHICH_TO_PROXY = {
    ("header", "default"): "header",
    ("header", "first_page"): "first_page_header",
    ("header", "even_page"): "even_page_header",
    ("footer", "default"): "footer",
    ("footer", "first_page"): "first_page_footer",
    ("footer", "even_page"): "even_page_footer",
}

_HF_VALID_WHICH = ("default", "first_page", "even_page")


def _hf_validate_which(which: str) -> str:
    if which not in _HF_VALID_WHICH:
        raise ValueError(
            f"which 必须为 default/first_page/even_page，实得 {which!r}")
    return which


def _hf_target_paragraph(doc, section_index: int, kind: str, which: str):
    """取目标 header/footer 的首个 <w:p>，必要时创建自有 part。

    用 python-docx 代理：先取代理（getattr 不 mutate），若 is_linked_to_previous
    为 True 则设为 False 触发自有 part 创建（part 创建仪式交给 python-docx，确保
    headerReference/footerReference、rels、[Content_Types] 正确）。
    然后通过代理 .paragraphs 取首段 <w:p>（此时已有自有 part，.paragraphs 安全）。
    section_index 越界 -> 抛 StructureError。
    """
    sections = doc.sections
    if section_index < 0 or section_index >= len(sections):
        raise StructureError(
            f"section_index 越界：{section_index}（共 {len(sections)} 个 section）")
    section = sections[section_index]
    proxy = getattr(section, _HF_WHICH_TO_PROXY[(kind, which)])
    if proxy.is_linked_to_previous:
        proxy.is_linked_to_previous = False  # 创建自有 part（mutate，写入预期）
    paras = proxy.paragraphs
    if not paras:
        # part 无段落 -> 加一个空段（python-docx BlockItemContainer.add_paragraph）
        proxy.add_paragraph()
        paras = proxy.paragraphs
    return paras[0]._p, section


def _hf_set_paragraph_text(p_elem, text: str, *, align=None,
                           inherit_style: bool = True):
    """把 header/footer 首段文本替换为 text（复用 writer 的 rPr 模板逻辑）。

    - 取 rPr 模板：首个有非空 rPr 的 run（inherit_style=True），否则 None。
    - 删段内所有 <w:r> 与 <w:hyperlink>（保留 pPr、bookmarkStart/End）。
    - 加单个值 run（rPr=模板 deepcopy）；text="" -> 清空，不加 run。
    - align: None 不动 jc；left/center/right 设 pPr/jc（覆盖已有 jc）。
    返回 (run_index|None, align_set|None)。
    """
    from src.writer import _make_value_run

    # rPr 模板
    rpr_template = None
    if inherit_style:
        for r in p_elem.findall(_w("r")):
            rpr = r.find(_w("rPr"))
            if rpr is not None and len(rpr) > 0:
                rpr_template = rpr
                break
        if rpr_template is None:
            for r in p_elem.findall(_w("r")):
                if r.findall(_w("t")):
                    rpr_template = r.find(_w("rPr"))
                    break

    # 删旧 run/hyperlink（保留 pPr、bookmark）
    for r in list(p_elem.findall(_w("r"))):
        p_elem.remove(r)
    for hl in list(p_elem.findall(_w("hyperlink"))):
        p_elem.remove(hl)

    # align：设 pPr/jc
    align_set = None
    if align is not None:
        ppr = p_elem.find(_w("pPr"))
        if ppr is None:
            ppr = p_elem.makeelement(_w("pPr"), {})
            p_elem.insert(0, ppr)
        # 删旧 jc 再加（覆盖）
        old_jc = ppr.find(_w("jc"))
        if old_jc is not None:
            ppr.remove(old_jc)
        jc = ppr.makeelement(_w("jc"), {_w("val"): align})
        ppr.append(jc)
        align_set = align

    new_run_index = None
    if text:
        new_r = _make_value_run(rpr_template, text, None)
        p_elem.append(new_r)
        new_run_index = list(p_elem).index(new_r)
    return new_run_index, align_set


def _set_hf_text(doc, text, *, section_index, which, kind, align,
                 inherit_style):
    """set_header_text / set_footer_text 的共用实现。"""
    _hf_validate_which(which)
    if align is not None and align not in ("left", "center", "right"):
        raise ValueError(f"align 必须为 left/center/right/None，实得 {align!r}")
    p_elem, section = _hf_target_paragraph(doc, section_index, kind, which)
    run_index, align_set = _hf_set_paragraph_text(
        p_elem, text, align=align, inherit_style=inherit_style)
    locator = "set_header_text" if kind == "header" else "set_footer_text"
    kind_cn = "页眉" if kind == "header" else "页脚"
    # part 现已存在，.paragraphs 安全；取段落数供返回
    proxy = getattr(section, _HF_WHICH_TO_PROXY[(kind, which)])
    para_count = len(proxy.paragraphs)
    return {
        "doc": doc,
        "section_index": section_index,
        "which": which,
        "paragraph_count": para_count,
        "run_index": run_index,
        "align": align_set,
        "locator": locator,
        "changes": [
            {"paragraph": None,
             "path": f"sections[{section_index}].{kind}.{which}.paragraphs[0]",
             "note": f"{kind_cn}文本设为 {text!r}" + (
                 f"（对齐 {align_set}）" if align_set else "")}
        ],
    }


def set_header_text(doc, text, *, section_index: int = 0,
                    which: str = "default", align=None,
                    inherit_style: bool = True) -> dict:
    """
    设置页眉文本（P0-3 配套：文本级写入）。

    参数：
        doc: Document 对象
        text: 新页眉文本。"" -> 清空该页眉首段全部 run（保留 pPr），不抛。
        section_index: section 索引（0 基），默认 0
        which: default / first_page / even_page（首页页眉需 sectPr 含 titlePg，
               偶数页页眉需 evenAndOddHeaders；写入仍会建对应 part）
        align: None 不动对齐；left/center/right 设首段 pPr/jc
        inherit_style: True=取该页眉首段首个有 rPr 的 run 作模板（保留字体）；
                       False=新 run 无 rPr

    返回：
        {doc, section_index, which, paragraph_count, run_index, align,
         locator:"set_header_text", changes:[...]}

    依据说明：
        通过 python-docx 代理确保目标 header 有自有 part（linked 则设
        is_linked_to_previous=False 触发 part 创建，由 python-docx 完成
        headerReference/rels/Content_Types 仪式），取首段 <w:p>，清空其
        <w:r>/<w:hyperlink>（保留 pPr/bookmark），加单个值 run。
        rPr 模板复用 writer.set_paragraph_text 同款逻辑（首个有非空 rPr 的 run，
        退化到首个有文本 run 的 rPr）。
    样式保护说明：
        - 只改目标 header 首段的 run 与（align 非空时）pPr/jc，不动其它段落、
          不动 sectPr 除 headerReference 外的属性、不动 styles.xml。
        - pPr 保留；run 的 rPr 来自模板（inherit_style=True）或无（False）。
        - text="" -> 清空首段 run，保留 pPr，不抛。
    边界说明：
        - section_index 越界 -> 抛 StructureError。
        - which 非法 -> 抛 ValueError。
        - align 非 left/center/right/None -> 抛 ValueError。
        - base.docx 无 header part -> 写入时自动创建（改 rels/Content_Types，
          属预期，不属 styles.xml 回归）。
    """
    return _set_hf_text(doc, text, section_index=section_index, which=which,
                        kind="header", align=align, inherit_style=inherit_style)


def set_footer_text(doc, text, *, section_index: int = 0,
                    which: str = "default", align=None,
                    inherit_style: bool = True) -> dict:
    """
    设置页脚文本（P0-3 配套：文本级写入）。语义同 set_header_text，kind=footer。

    参数：
        doc: Document 对象
        text: 新页脚文本。"" -> 清空该页脚首段全部 run（保留 pPr），不抛。
        section_index: section 索引（0 基），默认 0
        which: default / first_page / even_page
        align: None 不动对齐；left/center/right 设首段 pPr/jc
        inherit_style: True=取该页脚首段首个有 rPr 的 run 作模板；False=无 rPr

    返回：
        {doc, section_index, which, paragraph_count, run_index, align,
         locator:"set_footer_text", changes:[...]}

    依据说明：
        同 set_header_text，区别仅 kind=footer（footer 代理 / footerReference）。
    样式保护说明：
        - 只改目标 footer 首段的 run 与（align 非空时）pPr/jc，不动其它段落、
          不动 sectPr 除 footerReference 外的属性、不动 styles.xml。
        - pPr 保留；run 的 rPr 来自模板或无。
    边界说明：
        - section_index 越界 -> 抛 StructureError。
        - which 非法 -> 抛 ValueError。
        - align 非法 -> 抛 ValueError。
        - base.docx 无 footer part -> 写入时自动创建。
    """
    return _set_hf_text(doc, text, section_index=section_index, which=which,
                        kind="footer", align=align, inherit_style=inherit_style)


# ============================================================================
# 自测
# ============================================================================
def _self_test():
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from src.writer import insert_paragraph_after, _make_run_with_rpr
    from src.verifier import validate_openable, extract_style_fingerprint
    from src.locator import locate_by_heading

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    # ---- 测试1：add_page_break_before ----
    doc = Document(BASE)
    res = add_page_break_before(doc, 7)  # 段落7 正文宋体四号
    out1 = "output/structure_test_1.docx"
    doc.save(out1)
    assert res["added"] is True, res
    doc2 = Document(out1)
    ppr = doc2.paragraphs[7]._p.find(_w("pPr"))
    assert ppr is not None and ppr.find(_w("pageBreakBefore")) is not None, "应有 pageBreakBefore"
    # 幂等：再调一次 added=False
    res2 = add_page_break_before(doc2, 7)
    assert res2["added"] is False, "已存在应幂等"
    assert validate_openable(out1)
    print(f"[测试1 通过] add_page_break_before 段落7，added=True；幂等 added=False")

    # ---- 测试2：remove_page_break 删 pageBreakBefore ----
    doc = Document(BASE)
    add_page_break_before(doc, 7)
    res = remove_page_break(doc, 7)
    out2 = "output/structure_test_2.docx"
    doc.save(out2)
    assert res["removed_pbb"] is True, res
    doc2 = Document(out2)
    ppr = doc2.paragraphs[7]._p.find(_w("pPr"))
    assert ppr is None or ppr.find(_w("pageBreakBefore")) is None, "pageBreakBefore 应已删"
    assert validate_openable(out2)
    print(f"[测试2 通过] remove_page_break 删 pageBreakBefore，removed_pbb=True")

    # ---- 测试3：remove_page_break 删 br type=page（含空 run）----
    doc = Document(BASE)
    # 在段落7后插一个含 <w:br type=page> 的空 run 段落
    insert_paragraph_after(doc, 7, "", inherit_style=True)
    p8 = doc.paragraphs[8]._p
    r_br = p8.makeelement(_w("r"), {})
    br = p8.makeelement(_w("br"), {_w("type"): "page"})
    r_br.append(br)
    p8.append(r_br)
    res = remove_page_break(doc, 8)
    out3 = "output/structure_test_3.docx"
    doc.save(out3)
    assert res["removed_br"] is True, res
    doc2 = Document(out3)
    p8_after = doc2.paragraphs[8]._p
    # 不应再有 br type=page
    brs = [br for r in p8_after.findall(_w("r")) for br in r.findall(_w("br"))
           if br.get(_w("type")) == "page"]
    assert not brs, "br type=page 应已删"
    assert validate_openable(out3)
    print(f"[测试3 通过] remove_page_break 删 br type=page 及空 run")

    # ---- 测试4：remove_section_break 移除指定段内嵌 sectPr ----
    doc = Document(BASE)
    # 在段落7后插一个含内嵌 sectPr 的段落
    insert_paragraph_after(doc, 7, "带分节符的段落", inherit_style=True)
    p8 = doc.paragraphs[8]._p
    ppr = p8.find(_w("pPr"))
    if ppr is None:
        ppr = p8.makeelement(_w("pPr"), {})
        p8.insert(0, ppr)
    sect = ppr.makeelement(_w("sectPr"), {})
    sect.append(ppr.makeelement(_w("pgSz"), {_w("w"): "11906", _w("h"): "16838"}))
    ppr.append(sect)
    res = remove_section_break(doc, anchor=8)
    out4 = "output/structure_test_4.docx"
    doc.save(out4)
    assert res["removed_count"] == 1, res
    doc2 = Document(out4)
    ppr2 = doc2.paragraphs[8]._p.find(_w("pPr"))
    assert ppr2 is None or ppr2.find(_w("sectPr")) is None, "内嵌 sectPr 应已删"
    # body 末尾 sectPr 应保留
    body = doc2.element.body
    assert _local(body[-1].tag) == "sectPr", "body 末尾 sectPr 应保留"
    assert validate_openable(out4)
    print(f"[测试4 通过] remove_section_break 移除指定段内嵌 sectPr，body 末尾 sectPr 保留")

    # ---- 测试5：remove_section_break all_inline=True ----
    doc = Document(BASE)
    # 在段落7、段落8 后各插一个含内嵌 sectPr 的段落
    insert_paragraph_after(doc, 7, "分节段1", inherit_style=True)
    p8 = doc.paragraphs[8]._p
    ppr8 = p8.find(_w("pPr"))
    if ppr8 is None:
        ppr8 = p8.makeelement(_w("pPr"), {})
        p8.insert(0, ppr8)
    ppr8.append(ppr8.makeelement(_w("sectPr"), {}))
    res = remove_section_break(doc, all_inline=True)
    out5 = "output/structure_test_5.docx"
    doc.save(out5)
    assert res["removed_count"] >= 1, res
    doc2 = Document(out5)
    # 全文无内嵌 sectPr（body 直接子级 p 的 pPr 内）
    inline_sects = 0
    for c in doc2.element.body:
        if _local(c.tag) == "p":
            pp = c.find(_w("pPr"))
            if pp is not None and pp.find(_w("sectPr")) is not None:
                inline_sects += 1
    assert inline_sects == 0, f"应无内嵌 sectPr，实得 {inline_sects}"
    assert validate_openable(out5)
    print(f"[测试5 通过] remove_section_break all_inline=True，移除 {res['removed_count']} 个内嵌 sectPr")

    # ---- 测试6：remove_section_break 两者都未传抛 ValueError ----
    doc = Document(BASE)
    try:
        remove_section_break(doc)
        raised = False
    except ValueError:
        raised = True
    assert raised, "两者都未传应抛 ValueError"
    print(f"[测试6 通过] remove_section_break 两者都未传 -> 抛 ValueError")

    # ---- 测试7：delete_range 删区间（保留 start）----
    doc = Document(BASE)
    # 删段落8~段落11（不含 start=7）
    res = delete_range(doc, 7, 12, delete_start=False)
    out7 = "output/structure_test_7.docx"
    doc.save(out7)
    assert res["deleted_count"] == 4, res  # 段落 8,9,10,11（delete_start=False，保留 start=7）
    # 段落7 应保留
    doc2 = Document(out7)
    assert doc2.paragraphs[7].text == "正文宋体四号", "段落7 应保留"
    # 原段落8（宋体四号加粗）应已被删，现在段落8 是原段落12（链接）
    assert doc2.paragraphs[8].text == "链接", f"删后段落8 应为链接，实得 {doc2.paragraphs[8].text!r}"
    assert validate_openable(out7)
    print(f"[测试7 通过] delete_range 删段落8~11（保留 start=7），deleted_count={res['deleted_count']}")

    # ---- 测试8：delete_range end 在 start 之前抛 StructureError ----
    doc = Document(BASE)
    try:
        delete_range(doc, 10, 5)
        raised = False
    except StructureError:
        raised = True
    assert raised, "end 在 start 之前应抛 StructureError"
    print(f"[测试8 通过] delete_range end 在 start 之前 -> 抛 StructureError")

    # ---- 测试9：delete_section 删章节 ----
    doc = Document(BASE)
    # base.docx 标题层级嵌套：标题1(P2,L1) 标题2(P3,L2) 标题3(P4,L3)
    # 标题1章节延展到文档末尾（无后续同级/更高级标题）。
    # 用 delete_heading=False 删标题1章节内容（保留标题1段），验证删了标题1后的内容
    # （P5 等会被删到末尾，但保留 P2 标题1）
    res = delete_section(doc, "标题1", level=1, delete_heading=False)
    out9 = "output/structure_test_9.docx"
    doc.save(out9)
    assert res["section_heading"]["index"] == 2, res
    assert res["deleted_count"] >= 1, res
    doc2 = Document(out9)
    # 标题1 段保留，其后内容被删到末尾（仅剩 P0,P1,P2 + sectPr 前的空段）
    assert doc2.paragraphs[2].text == "标题1", f"标题1 应保留，实得 {doc2.paragraphs[2].text!r}"
    # 删了大量内容，段落数应大幅减少
    assert len(doc2.paragraphs) < len(Document(BASE).paragraphs), "段落数应减少"
    assert validate_openable(out9)
    print(f"[测试9 通过] delete_section 删「标题1」章节内容（保留标题），deleted_count={res['deleted_count']}")

    # ---- 测试10：delete_section 连标题一起删 ----
    doc = Document(BASE)
    res = delete_section(doc, "标题1", level=1, delete_heading=True)
    out10 = "output/structure_test_10.docx"
    doc.save(out10)
    doc2 = Document(out10)
    # 标题1 段应已删
    texts = [p.text for p in doc2.paragraphs]
    assert "标题1" not in texts, f"标题1 应已删，实得 {texts[:5]}"
    assert validate_openable(out10)
    print(f"[测试10 通过] delete_section 连标题一起删「标题1」")

    # ---- 测试11：insert_toc_field 标准 TOC 域 ----
    doc = Document(BASE)
    res = insert_toc_field(doc, 7, toc_level="1-3", title="目  录",
                           page_break=True, update_prompt=True)
    out11 = "output/structure_test_11.docx"
    doc.save(out11)
    assert res["title_paragraph_index"] is not None, res
    assert res["toc_field_paragraph_index"] is not None, res
    doc2 = Document(out11)
    title_p = doc2.paragraphs[res["title_paragraph_index"]]
    assert title_p.text == "目  录", f"标题段应为「目  录」，实得 {title_p.text!r}"
    # 标题段应有 pageBreakBefore
    ppr = title_p._p.find(_w("pPr"))
    assert ppr is not None and ppr.find(_w("pageBreakBefore")) is not None, "标题段应有 pageBreakBefore"
    # TOC 域段应含 instrText 含 "TOC"
    toc_p = doc2.paragraphs[res["toc_field_paragraph_index"]]
    instr_texts = [it.text or "" for it in toc_p._p.iter(_w("instrText"))]
    assert any("TOC" in s for s in instr_texts), f"TOC 域应含 instrText 含 TOC：{instr_texts}"
    # 应含 fldChar begin/separate/end
    fc_types = [fc.get(_w("fldCharType")) for fc in toc_p._p.iter(_w("fldChar"))]
    assert "begin" in fc_types and "separate" in fc_types and "end" in fc_types, f"应含 begin/separate/end：{fc_types}"
    assert validate_openable(out11)
    print(f"[测试11 通过] insert_toc_field 标题「目  录」+ 标准 TOC 域（begin/instr/separate/end）")

    # ---- 测试12：insert_toc_field title=None 只插 TOC 域段 ----
    doc = Document(BASE)
    res = insert_toc_field(doc, 7, toc_level="1-3", title=None,
                           page_break=False, update_prompt=False)
    out12 = "output/structure_test_12.docx"
    doc.save(out12)
    assert res["title_paragraph_index"] is None, res
    doc2 = Document(out12)
    toc_p = doc2.paragraphs[res["toc_field_paragraph_index"]]
    instr_texts = [it.text or "" for it in toc_p._p.iter(_w("instrText"))]
    assert any("TOC" in s for s in instr_texts), "应含 TOC instrText"
    assert validate_openable(out12)
    print(f"[测试12 通过] insert_toc_field title=None 只插 TOC 域段，无标题段")

    # ---- 测试13：insert_toc_field anchor 是 body 末尾段 ----
    doc = Document(BASE)
    # base.docx 末尾段落38，其后是 sectPr
    res = insert_toc_field(doc, 38, toc_level="1-3", title="目录")
    out13 = "output/structure_test_13.docx"
    doc.save(out13)
    doc2 = Document(out13)
    body = doc2.element.body
    # sectPr 应仍是 body 末尾
    assert _local(body[-1].tag) == "sectPr", "sectPr 应仍是 body 末尾"
    # 新段应在 sectPr 之前
    assert _local(body[-2].tag) == "p", "新段应在 sectPr 之前"
    assert validate_openable(out13)
    print(f"[测试13 通过] insert_toc_field anchor=末尾段，新段落在 sectPr 之前")

    # ====================================================================
    # renumber_list 测试（编号快速重排序）
    # ====================================================================
    # 注：renumber_list / _MANUAL_NUM_RE / _format_manual_number / StructureError
    # 均为本模块顶层定义，直接用本模块作用域引用（勿 from src.structure import，
    # 否则直接运行 python src/structure.py 时会导入第二份模块实例，异常类不一致）。

    # ---- 测试14：自动编号(numPr) 重排 —— 克隆新 numId 使其独立起号 ----
    # base.docx P13~P15 是 numId=1 的 decimal 列表（原 1/2/3）。先在它们前面
    # 「占位」造出续号效果不易，这里直接验证：重排后这组段拿到独立新 numId，
    # 且旧 numId 定义仍存在（不影响其它列表）。
    doc = Document(BASE)
    res = renumber_list(doc, [13, 14, 15])
    out14 = "output/structure_test_14.docx"
    doc.save(out14)
    assert res["mode_detected"] == "numpr", res
    assert res["count"] == 3, res
    new_numid = res["renumbered"][0]["new"]  # 形如 "numId=4"
    assert new_numid.startswith("numId="), res
    # 三段应都指向同一个新 numId
    assert all(r["new"] == new_numid for r in res["renumbered"]), res
    # rank 应为 1/2/3
    assert [r["rank"] for r in res["renumbered"]] == [1, 2, 3], res
    doc2 = Document(out14)
    for i, rank in zip([13, 14, 15], [1, 2, 3]):
        numpr = doc2.paragraphs[i]._p.find(_w("pPr")).find(_w("numPr"))
        assert numpr.find(_w("numId")).get(_w("val")) == new_numid.split("=")[1]
    # 旧 numId=1 的定义应仍存在（P17~ 等其它列表不受影响）
    z = __import__("zipfile").ZipFile(out14)
    nroot = etree.fromstring(z.read("word/numbering.xml"))
    old_num_ids = [n.get(_w("numId")) for n in nroot.findall(_w("num"))]
    assert "1" in old_num_ids, "旧 numId=1 应保留"
    assert new_numid.split("=")[1] in old_num_ids, "新 numId 应存在"
    assert validate_openable(out14)
    print(f"[测试14 通过] renumber_list 自动编号组 -> 独立新 numId={new_numid}（旧定义保留）")

    # ---- 测试15：手动文本编号 重排（4./5./6. -> 1./2./3.）----
    doc = Document(BASE)
    # 在段落7后插三段手动编号文本「4. 甲」「5. 乙」「6. 丙」
    insert_paragraph_after(doc, 7, "4. 甲", inherit_style=True)
    insert_paragraph_after(doc, 8, "5. 乙", inherit_style=True)
    insert_paragraph_after(doc, 9, "6. 丙", inherit_style=True)
    res = renumber_list(doc, [8, 9, 10])  # 插入后原 8/9/10 即这三段
    out15 = "output/structure_test_15.docx"
    doc.save(out15)
    assert res["mode_detected"] == "text", res
    assert [r["rank"] for r in res["renumbered"]] == [1, 2, 3], res
    assert [r["old"] for r in res["renumbered"]] == ["4.", "5.", "6."], res
    assert [r["new"] for r in res["renumbered"]] == ["1.", "2.", "3."], res
    doc2 = Document(out15)
    assert doc2.paragraphs[8].text == "1. 甲", doc2.paragraphs[8].text
    assert doc2.paragraphs[9].text == "2. 乙", doc2.paragraphs[9].text
    assert doc2.paragraphs[10].text == "3. 丙", doc2.paragraphs[10].text
    assert validate_openable(out15)
    print(f"[测试15 通过] renumber_list 手动文本「4.5.6.」-> 「1.2.3.」")

    # ---- 测试16：手动编号 start=4 偏移 + 顿号/括号形态 ----
    # 先验证 _format_manual_number 对各形态的渲染（含多级只换首级）
    assert _format_manual_number(1, _MANUAL_NUM_RE.match("4.")) == "1."
    assert _format_manual_number(2, _MANUAL_NUM_RE.match("5、")) == "2、"
    assert _format_manual_number(3, _MANUAL_NUM_RE.match("6)")) == "3)"
    assert _format_manual_number(1, _MANUAL_NUM_RE.match("(4)")) == "(1)"
    assert _format_manual_number(1, _MANUAL_NUM_RE.match("4.1.")) == "1.1."
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "10、 第一", inherit_style=True)
    insert_paragraph_after(doc, 8, "(11) 第二", inherit_style=True)
    res = renumber_list(doc, [8, 9], start=4)
    out16 = "output/structure_test_16.docx"
    doc.save(out16)
    assert [r["rank"] for r in res["renumbered"]] == [4, 5], res
    assert [r["new"] for r in res["renumbered"]] == ["4、", "(5)"], res
    doc2 = Document(out16)
    assert doc2.paragraphs[8].text == "4、 第一", doc2.paragraphs[8].text
    assert doc2.paragraphs[9].text == "(5) 第二", doc2.paragraphs[9].text
    assert validate_openable(out16)
    print(f"[测试16 通过] renumber_list start=4 偏移 + 顿号/括号形态保留")

    # ---- 测试17：空 anchors 抛 ValueError ----
    doc = Document(BASE)
    try:
        renumber_list(doc, [])
        raised = False
    except ValueError:
        raised = True
    assert raised, "空 anchors 应抛 ValueError"
    print(f"[测试17 通过] renumber_list 空 anchors -> ValueError")

    # ---- 测试18：mode=text 遇 numPr 段抛 StructureError ----
    doc = Document(BASE)
    try:
        renumber_list(doc, [13], mode="text")  # P13 是 numPr 段
        raised = False
    except StructureError:
        raised = True
    assert raised, "mode=text 遇 numPr 段应抛 StructureError"
    print(f"[测试18 通过] renumber_list mode=text 遇 numPr -> StructureError")

    # ---- 测试19：手动模式下段首无可识别编号抛 StructureError ----
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "这段没有编号前缀", inherit_style=True)
    try:
        renumber_list(doc, [8], mode="text")
        raised = False
    except StructureError:
        raised = True
    assert raised, "无编号前缀应抛 StructureError"
    print(f"[测试19 通过] renumber_list 无编号前缀 -> StructureError")

    # ====================================================================
    # 页眉页脚文本写入测试（set_header_text / set_footer_text）
    # ====================================================================
    # ---- 测试20：set_footer_text default + align ----
    doc = Document(BASE)
    res = set_footer_text(doc, "机密文档", align="center")
    out20 = "output/structure_test_20.docx"
    doc.save(out20)
    assert res["align"] == "center", res
    assert res["which"] == "default", res
    # 读回验证（用 reader.get_footer_text，非 mutate）
    from src.reader import get_footer_text
    rf = get_footer_text(Document(out20))
    assert rf["text"] == "机密文档", f"页脚应=机密文档，实得 {rf['text']!r}"
    assert rf["has_part"] is True, rf
    # jc 应为 center
    ftr_root = Document(out20).sections[0].footer._element
    jc = ftr_root.find(_w("p")).find(_w("pPr")).find(_w("jc"))
    assert jc is not None and jc.get(_w("val")) == "center", "jc 应 center"
    assert validate_openable(out20)
    print(f"[测试20 通过] set_footer_text 机密文档(center)，读回 has_part=True jc=center")

    # ---- 测试21：set_header_text which=first_page 独立 part ----
    doc = Document(BASE)
    set_header_text(doc, "首页页眉", which="first_page")
    set_header_text(doc, "常规页眉", which="default")
    out21 = "output/structure_test_21.docx"
    doc.save(out21)
    from src.reader import get_header_text
    d2 = Document(out21)
    assert get_header_text(d2, which="first_page")["text"] == "首页页眉"
    assert get_header_text(d2, which="default")["text"] == "常规页眉"
    # first_page 与 default 是不同 part
    assert get_header_text(d2, which="first_page")["has_part"] is True
    assert get_header_text(d2, which="default")["has_part"] is True
    assert validate_openable(out21)
    print(f"[测试21 通过] set_header_text first_page/default 各自独立 part，读回正确")

    # ---- 测试22：set_footer_text 幂等（同文本再写不重复）----
    doc = Document(BASE)
    set_footer_text(doc, "页脚A")
    res2 = set_footer_text(doc, "页脚A")  # 再写一次相同文本
    out22 = "output/structure_test_22.docx"
    doc.save(out22)
    rf = get_footer_text(Document(out22))
    assert rf["text"] == "页脚A", rf
    # 段内应只有 1 个含文本 run（不重复堆叠）
    ftr_p = Document(out22).sections[0].footer._element.find(_w("p"))
    text_runs = [r for r in ftr_p.findall(_w("r")) if r.findall(_w("t"))]
    assert len(text_runs) == 1, f"幂等后应仅 1 个文本 run，实得 {len(text_runs)}"
    assert validate_openable(out22)
    print(f"[测试22 通过] set_footer_text 幂等：重复写同文本仅 1 个文本 run")

    # ---- 测试23：set_footer_text text="" 清空 ----
    doc = Document(BASE)
    set_footer_text(doc, "待清除")
    set_footer_text(doc, "")  # 清空
    out23 = "output/structure_test_23.docx"
    doc.save(out23)
    rf = get_footer_text(Document(out23))
    assert rf["text"] == "", f"清空后应空，实得 {rf['text']!r}"
    assert rf["has_part"] is True, "清空后 part 应仍存在"
    assert validate_openable(out23)
    print(f"[测试23 通过] set_footer_text text='' 清空首段 run，part 保留")

    # ---- 测试24：边界异常 ----
    doc = Document(BASE)
    try:
        set_footer_text(doc, "x", which="bogus")
        raised = False
    except ValueError:
        raised = True
    assert raised, "which 非法应抛 ValueError"
    try:
        set_footer_text(doc, "x", align="middle")
        raised = False
    except ValueError:
        raised = True
    assert raised, "align 非法应抛 ValueError"
    try:
        set_header_text(doc, "x", section_index=99)
        raised = False
    except StructureError:
        raised = True
    assert raised, "section_index 越界应抛 StructureError"
    print(f"[测试24 通过] 边界：which/align 非法抛 ValueError；section_index 越界抛 StructureError")

    print()
    print("产出文件：output/structure_test_1~24.docx（供人工验证）")

    # ====================================================================
    # renumber_headings / update_toc_field 测试
    # ====================================================================
    _self_test_renumber_toc()

    # ====================================================================
    # merge_documents 测试（P0-1 文档合并）
    # ====================================================================
    _self_test_merge()


def _self_test_renumber_toc():
    """renumber_headings / update_toc_field 自测。
    update_toc_field 依赖 LibreOffice，若不可用则跳过（属预期）。"""
    import os, shutil
    from src.verifier import validate_openable, _probe_soffice
    from src.locator import _heading_level_of, _style_id_to_name, _paragraph_text

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    # ---- 测试5：renumber_headings base.docx（P2=H1, P3=H2, P4=H3）----
    doc = Document(BASE)
    res = renumber_headings(doc, levels=(1, 2, 3), h1_style="chinese")
    out5 = "output/structure_test_renumber1.docx"
    doc.save(out5)
    assert res["count"] == 3, f"应重编号 3 个标题，实得 {res['count']}"
    doc2 = Document(out5)
    p2_text = _paragraph_text(doc2.paragraphs[2]._p)
    p3_text = _paragraph_text(doc2.paragraphs[3]._p)
    p4_text = _paragraph_text(doc2.paragraphs[4]._p)
    assert p2_text.startswith("一、"), f"P2 应以「一、」开头，实得 {p2_text!r}"
    assert p3_text.startswith("1.1 "), f"P3 应以「1.1 」开头，实得 {p3_text!r}"
    assert p4_text.startswith("1.1.1 "), f"P4 应以「1.1.1 」开头，实得 {p4_text!r}"
    assert validate_openable(out5)
    print(f"[renumber测试1 通过] base.docx: P2='一、', P3='1.1 ', P4='1.1.1 '")

    # ---- 测试6：renumber_headings 剥除原编号前缀 ----
    doc = Document(BASE)
    # 给标题2 加手动编号前缀「第二章 标题2」
    p3 = doc.paragraphs[3]._p
    first_t = None
    for r in p3.findall(_w("r")):
        for t in r.findall(_w("t")):
            first_t = t
            break
        if first_t is not None:
            break
    if first_t is not None:
        first_t.text = "第二章 " + (first_t.text or "")
    res = renumber_headings(doc, levels=(1, 2, 3), h1_style="chinese")
    out6 = "output/structure_test_renumber2.docx"
    doc.save(out6)
    doc2 = Document(out6)
    p3_text = _paragraph_text(doc2.paragraphs[3]._p)
    assert p3_text.startswith("1.1 "), f"剥除「第二章」后应以「1.1 」开头，实得 {p3_text!r}"
    assert "第二章" not in p3_text, f"应剥除「第二章」前缀，实得 {p3_text!r}"
    assert "标题2" in p3_text, f"应保留标题正文，实得 {p3_text!r}"
    assert validate_openable(out6)
    print(f"[renumber测试2 通过] 剥除「第二章」前缀后重编号: {p3_text!r}")

    # ---- 测试7：skip_titles 跳过匹配标题 ----
    doc = Document(BASE)
    # 把标题3 改名为「目录」（用 set_paragraph_text 整段替换，避免多 run 残留）
    from src.writer import set_paragraph_text
    set_paragraph_text(doc, 4, "目录", inherit_style=True)
    res = renumber_headings(doc, levels=(1, 2, 3), skip_titles=["目录"],
                            h1_style="chinese")
    out7 = "output/structure_test_renumber3.docx"
    doc.save(out7)
    assert res["count"] == 2, f"跳过「目录」后应重编号 2 个，实得 {res['count']}"
    doc2 = Document(out7)
    p4_text = _paragraph_text(doc2.paragraphs[4]._p)
    assert p4_text == "目录", f"「目录」应跳过不改，实得 {p4_text!r}"
    assert validate_openable(out7)
    print(f"[renumber测试3 通过] skip_titles=['目录'] 跳过，count=2")

    # ---- 测试8：renumber_headings 烟草招标.docx（outlineLvl 标题）----
    tobacco = "input/烟草招标.docx"
    if os.path.exists(tobacco):
        doc = Document(tobacco)
        res = renumber_headings(doc, levels=(1, 2, 3), h1_style="chinese")
        out8 = "output/structure_test_renumber4.docx"
        doc.save(out8)
        assert res["count"] > 0, f"烟草招标应有标题，实得 count={res['count']}"
        first_new = res["renumbered"][0]["new"]
        assert first_new.startswith("一、"), f"首个标题应以「一、」开头，实得 {first_new!r}"
        assert validate_openable(out8)
        print(f"[renumber测试4 通过] 烟草招标.docx: count={res['count']}，首标题={first_new[:20]!r}")

    # ---- 测试9：无标题文档 count=0 不抛 ----
    doc = Document(BASE)
    # 删掉所有标题段（P2/P3/P4）
    from src.deleter import delete_paragraph
    for _ in range(3):
        delete_paragraph(doc, 2)  # 反复删 P2
    res = renumber_headings(doc, levels=(1, 2, 3), h1_style="chinese")
    assert res["count"] == 0, f"无标题应 count=0，实得 {res['count']}"
    print(f"[renumber测试5 通过] 无标题文档 count=0 不抛")

    # ---- 测试10：_to_chinese_ordinal 单元测试 ----
    assert _to_chinese_ordinal(1) == "一"
    assert _to_chinese_ordinal(10) == "十"
    assert _to_chinese_ordinal(11) == "十一"
    assert _to_chinese_ordinal(20) == "二十"
    assert _to_chinese_ordinal(21) == "二十一"
    assert _to_chinese_ordinal(9) == "九"
    print(f"[renumber测试6 通过] _to_chinese_ordinal: 1=一, 10=十, 11=十一, 20=二十, 21=二十一")

    # ---- 测试11：_strip_heading_number_prefix 单元测试 ----
    assert _strip_heading_number_prefix("第一章 总论") == "总论"
    assert _strip_heading_number_prefix("一、概述") == "概述"
    assert _strip_heading_number_prefix("1. 项目背景") == "项目背景"
    assert _strip_heading_number_prefix("1.1 子项") == "子项"
    assert _strip_heading_number_prefix("(一) 总则") == "总则"
    assert _strip_heading_number_prefix("标题无编号") == "标题无编号"
    print(f"[renumber测试7 通过] _strip_heading_number_prefix 各形态正确剥除")

    # ---- 测试12：update_toc_field（依赖 LibreOffice）----
    soffice = _probe_soffice()
    if soffice and os.path.exists(soffice):
        # 先构造一个含 TOC 域的 docx
        doc = Document(BASE)
        insert_toc_field(doc, 7, toc_level="1-3", title="目录",
                         page_break=False, update_prompt=True)
        toc_docx = "output/structure_test_toc_input.docx"
        doc.save(toc_docx)
        assert validate_openable(toc_docx), "TOC 输入文档应可打开"

        # 调 update_toc_field
        out_toc = "output/structure_test_toc_updated.docx"
        res = update_toc_field(toc_docx, output_path=out_toc)
        assert res["toc_updated"] is True, f"应 toc_updated=True，实得 {res}"
        assert res["soffice_path"] == soffice, res
        assert validate_openable(out_toc), "更新后的 docx 应可打开"
        print(f"[toc测试1 通过] update_toc_field: toc_updated=True, entry_count={res['entry_count']}")

        # 测试无 TOC 域的文档（target_plain.docx 无 TOC 域）
        plain_docx = "input/target_plain.docx"
        res2 = update_toc_field(plain_docx, output_path="output/structure_test_toc_plain_out.docx")
        assert res2["toc_updated"] is False, f"无 TOC 域应 toc_updated=False，实得 {res2}"
        print(f"[toc测试2 通过] 无 TOC 域文档: toc_updated=False")
    else:
        print("[toc测试 跳过] 未找到 LibreOffice，update_toc_field 自测跳过（属预期，外部依赖）")

    print()


def _self_test_merge():
    """merge_documents 自测：合并两份 docx，验证段落数、图片迁移、sectPr 保留、
    分页段插入、空 parts 抛异常。参照 clipboard._self_test_xdoc 风格。"""
    import os, shutil
    from src.verifier import validate_openable

    BASE = "input/base.docx"
    PLAIN = "input/target_plain.docx"
    os.makedirs("output", exist_ok=True)

    # ---- 测试1：合并 base.docx 到 target_plain ----
    master = "output/merge_st_master1.docx"
    shutil.copy(PLAIN, master)
    res = merge_documents(master, [BASE], output_path="output/merge_st_1.docx")
    assert res["merged_parts"] == 1, res
    assert res["total_inserted"] > 0, res
    assert validate_openable("output/merge_st_1.docx")
    doc = Document("output/merge_st_1.docx")
    body = doc.element.body
    # master 末尾 sectPr 应保留
    assert _local(body[-1].tag) == "sectPr", "合并后末尾应为 sectPr"
    # 段落数应 = master 段 + part 段
    n_master = len(Document(PLAIN).paragraphs)
    n_part = len(Document(BASE).paragraphs)
    assert len(doc.paragraphs) == n_master + n_part, (
        f"段落数应={n_master + n_part}，实得={len(doc.paragraphs)}")
    print(f"[合并测试1 通过] 合并 base 到 target_plain，total_inserted={res['total_inserted']}，sectPr 保留")

    # ---- 测试2：合并含图片的 part，验证图片迁移 ----
    master = "output/merge_st_master2.docx"
    shutil.copy(PLAIN, master)
    res = merge_documents(master, [BASE], output_path="output/merge_st_2.docx")
    assert res["copied_images"] >= 1, f"应有图片迁移，实得{res}"
    doc = Document("output/merge_st_2.docx")
    blips = list(doc.element.body.iter(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"))
    assert len(blips) >= 3, f"应有图片 blip，实得{len(blips)}"
    assert validate_openable("output/merge_st_2.docx")
    print(f"[合并测试2 通过] 合并含图片 part，图片迁移{res['copied_images']}个，blip={len(blips)}")

    # ---- 测试3：insert_page_break=True 首个 part 前插分页段 ----
    master = "output/merge_st_master3.docx"
    shutil.copy(PLAIN, master)
    res = merge_documents(master, [BASE], output_path="output/merge_st_3.docx",
                          insert_page_break=True)
    assert res["total_inserted"] > 0, res
    doc = Document("output/merge_st_3.docx")
    brs = [br for br in doc.element.body.iter(_w("br"))
           if br.get(_w("type")) == "page"]
    assert len(brs) >= 1, "应有分页 br"
    assert validate_openable("output/merge_st_3.docx")
    print(f"[合并测试3 通过] insert_page_break=True，分页 br 数={len(brs)}")

    # ---- 测试4：strip_source_heading_numbers=True 剥标题编号 ----
    # 先构造一个带标题编号的 part
    part_doc = Document(BASE)
    # 给 P7 加手动编号前缀「1. 正文」
    p7 = part_doc.paragraphs[7]._p
    first_t = None
    for r in p7.findall(_w("r")):
        for t in r.findall(_w("t")):
            first_t = t
            break
        if first_t is not None:
            break
    if first_t is not None:
        first_t.text = "1. " + (first_t.text or "")
    part_path = "output/merge_st_part4.docx"
    part_doc.save(part_path)
    master = "output/merge_st_master4.docx"
    shutil.copy(PLAIN, master)
    res = merge_documents(master, [part_path], output_path="output/merge_st_4.docx",
                          strip_source_heading_numbers=True)
    assert validate_openable("output/merge_st_4.docx")
    doc = Document("output/merge_st_4.docx")
    # 合并后的段中应不含「1. 正文宋体四号」的编号前缀（被剥除）
    texts = [_paragraph_text(p._p) for p in doc.paragraphs]
    # P7 原文是「1. 正文宋体四号」，strip 后应为「正文宋体四号」
    assert any("正文宋体四号" in t for t in texts), f"应含正文文本，texts={texts[-5:]}"
    assert not any(t.startswith("1. 正文宋体四号") for t in texts), \
        "strip 后不应有编号前缀"
    print(f"[合并测试4 通过] strip_source_heading_numbers 剥除标题编号前缀")

    # ---- 测试5：空 part_paths 抛 ValueError ----
    master = "output/merge_st_master5.docx"
    shutil.copy(PLAIN, master)
    try:
        merge_documents(master, [], output_path="output/merge_st_5.docx")
        raised = False
    except ValueError:
        raised = True
    assert raised, "空 part_paths 应抛 ValueError"
    print(f"[合并测试5 通过] 空 part_paths -> ValueError")

    # ---- 测试6：合并多个 part ----
    master = "output/merge_st_master6.docx"
    shutil.copy(PLAIN, master)
    res = merge_documents(master, [BASE, BASE],
                          output_path="output/merge_st_6.docx")
    assert res["merged_parts"] == 2, res
    assert validate_openable("output/merge_st_6.docx")
    doc = Document("output/merge_st_6.docx")
    # 段落数 = master + 2 * part
    n_master = len(Document(PLAIN).paragraphs)
    n_part = len(Document(BASE).paragraphs)
    assert len(doc.paragraphs) == n_master + 2 * n_part, (
        f"段落数应={n_master + 2 * n_part}，实得={len(doc.paragraphs)}")
    print(f"[合并测试6 通过] 合并 2 个 part，段落数={len(doc.paragraphs)}")

    print()
    print("产出文件：output/merge_st_1~6.docx（供人工验证合并）")


if __name__ == "__main__":
    _self_test()
