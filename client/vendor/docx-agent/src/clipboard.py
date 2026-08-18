# -*- coding: utf-8 -*-
"""
阶段2 模块4：剪贴板（Clipboard）—— 复制粘贴

定位：把源段落/表格单元格内容 deepcopy 后粘贴到目标位置，保证样式无损。
是四个模块中最复杂的：要处理 deepcopy 保样式、图片关系、书签 id 冲突。

================================================================
开发依据（基于 base.docx 真实结构，见 logs/base_structure.md + 实测）
================================================================
1. 段落31（图片段）：3 个 run，每个含 <w:drawing>，均引用 r:embed=rId8（image3.png）。
   关系：rId6/7/8 -> media/image1/2/3.png。
   → 同文档内复制：deepcopy 的 drawing 仍引用原 rId，图片可直接显示，
     无需复制 media/关系（关系已存在于该文档）。本版聚焦"同文档复制"。
2. 书签 id 范围 0~4（_top, _Toc234486118/119/120, _标题3）。
   → 复制含 bookmarkStart 的段落会产生重复 id/name，违反 OOXML 唯一性。
     粘贴时需重映射 bookmark id（取文档最大 id+1）并改名（加后缀）。
3. 段落2（标题1）子元素含 bookmarkEnd；段落33 含 commentRangeStart/End。
   → deepcopy 整段会复制这些标记；书签 id 重映射需同步处理 bookmarkStart/End。
4. 列表段落（numId=1/2/3）：numbering 定义在 numbering.xml（全局），
   同文档复制后 numId 仍有效，无需复制定义。

已确认 XML 样本（来自 base.docx 实测）。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

# 兼容直接运行（python src/clipboard.py）
import os as _os, sys as _sys
if __package__ in (None, ""):
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from src._xdoc import (
    collect_paragraph_dependencies,
    collect_elements_dependencies,
    ensure_numbering,
    ensure_styles,
    ensure_images,
    remap_paragraph,
    remap_elements,
    max_bookmark_id,
)

# 兼容直接运行
import os as _os, sys as _sys
if __package__ in (None, ""):
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from src.locator import (
    locate_by_paragraph_index,
    locate_table_cell,
    LocateError,
)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def _local(tag) -> str:
    return etree.QName(tag).localname


class ClipboardError(Exception):
    """复制粘贴失败统一异常。"""


# ============================================================================
# 内部工具
# ============================================================================
def _resolve_anchor_p(doc, anchor):
    """把锚点(dict/int/<w:p>)统一解析为 <w:p> 元素。"""
    if isinstance(anchor, dict):
        return anchor["p_elem"]
    if isinstance(anchor, int):
        return locate_by_paragraph_index(doc, anchor)["p_elem"]
    if _local(anchor.tag) == "p":
        return anchor
    raise ClipboardError(f"无法识别的 anchor 类型: {type(anchor)}")


def _max_bookmark_id(doc) -> int:
    """取文档内当前最大 bookmark id（用于生成不冲突的新 id）。"""
    body = doc.element.body
    max_id = -1
    for bm in body.iter(_w("bookmarkStart")):
        try:
            bid = int(bm.get(_w("id")))
            if bid > max_id:
                max_id = bid
        except (TypeError, ValueError):
            continue
    return max_id


def _remap_bookmarks(p_elem, start_id: int) -> tuple[int, int]:
    """
    重映射段落内 bookmarkStart/End 的 id，避免与原文档冲突。
    返回 (next_id, remapped_count)。
    同时给 bookmarkStart 的 name 加 _copy 后缀，避免重名。

    依据：OOXML 要求 bookmark id 在文档内唯一、name 唯一。
    """
    next_id = start_id
    count = 0
    # bookmarkStart：改 id + name
    for bm in p_elem.iter(_w("bookmarkStart")):
        bm.set(_w("id"), str(next_id))
        old_name = bm.get(_w("name"))
        if old_name:
            bm.set(_w("name"), old_name + "_copy")
        next_id += 1
        count += 1
    # bookmarkEnd：只改 id（与对应 start 配对）。按出现顺序配对。
    for bm in p_elem.iter(_w("bookmarkEnd")):
        bm.set(_w("id"), str(next_id))
        next_id += 1
    return next_id, count


def _body_index_of_p(doc, p_elem) -> int:
    body = doc.element.body
    idx = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is p_elem:
                return idx
            idx += 1
    raise ClipboardError("未在 body 中找到目标段落")


# ============================================================================
# 公共函数 1：copy_paragraph_after
# ============================================================================
def copy_paragraph_after(doc, source, target, remap_bookmarks: bool = True) -> dict:
    """
    把源段落 deepcopy 后粘贴到目标段落之后。

    参数：
        source: 源段落锚点（dict/int/<w:p>）
        target: 目标段落锚点（粘贴到其后）
        remap_bookmarks: True=重映射源段落副本中的书签 id/name（避免冲突）

    返回：
        {
          "doc": doc,
          "new_p": <粘贴的新 <w:p>>,
          "source_paragraph_index": int,
          "target_paragraph_index": int,
          "new_paragraph_index": int,
          "remapped_bookmarks": int,    # 重映射的书签数
          "locator": "copy_paragraph_after",
          "changes": [{"paragraph": <new_idx>, "path": None, "note": "粘贴段落"}]
        }

    依据说明：
        deepcopy 源 <w:p> 整棵子树（含 pPr/run/rPr/drawing/bookmark 等）。
        依据：deepcopy 保留所有属性与子元素，是保样式的最可靠方式。
        图片：drawing 内 r:embed 引用的关系在同文档内已存在，副本可直接显示。
    样式保护说明：
        - pPr 与所有 run 的 rPr 随 deepcopy 完整保留，不手工重建。
        - drawing 节点完整保留，r:embed 关系复用（同文档内有效）。
        - 不修改源段落、不修改目标段落、不改 styles.xml。
    边界说明：
        - 源=目标段落 -> 粘贴到自身之后（合法，产生相邻副本）。
        - 源段落含书签 -> remap_bookmarks=True 时重映射 id/name；
          False 时保留原 id（会产生冲突，仅用于确知无书签的场景）。
        - 源段落含批注范围标记（commentRangeStart/End）-> deepcopy 会复制标记，
          但批注本体（comments.xml）不复制，可能产生悬空批注引用（局限）。
        - 粘贴位置在 body 末尾（目标段落后是 sectPr）-> 副本落在 sectPr 之前。
    """
    src_p = _resolve_anchor_p(doc, source)
    tgt_p = _resolve_anchor_p(doc, target)
    if _local(tgt_p.tag) == "sectPr":
        raise ClipboardError("禁止以 sectPr 作为目标")

    new_p = deepcopy(src_p)
    remapped = 0
    if remap_bookmarks:
        start_id = _max_bookmark_id(doc) + 1
        _, remapped = _remap_bookmarks(new_p, start_id)

    tgt_p.addnext(new_p)

    # 推断索引
    body = doc.element.body
    src_idx = tgt_idx = new_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is src_p:
                src_idx = p_counter
            if c is tgt_p:
                tgt_idx = p_counter
            if c is new_p:
                new_idx = p_counter
            p_counter += 1

    return {
        "doc": doc,
        "new_p": new_p,
        "source_paragraph_index": src_idx,
        "target_paragraph_index": tgt_idx,
        "new_paragraph_index": new_idx,
        "remapped_bookmarks": remapped,
        "locator": "copy_paragraph_after",
        "changes": [
            {"paragraph": new_idx, "path": None,
             "note": f"粘贴段落（源={src_idx}，重映射书签={remapped}）"}
        ],
    }


# ============================================================================
# 公共函数 2：copy_run_to_paragraph
# ============================================================================
def copy_run_to_paragraph(doc, source_run_index: int, source_paragraph,
                          target_paragraph, position: str = "end") -> dict:
    """
    把源段落的指定 run deepcopy 后粘贴到目标段落。

    参数：
        source_run_index: 源段落中 run 的索引（0 基，按 <w:r> 顺序）
        source_paragraph: 源段落锚点
        target_paragraph: 目标段落锚点
        position: "end"=追加到目标段落末尾；"start"=插到目标段落最前（pPr 之后）

    返回：
        {
          "doc": doc,
          "new_run": <粘贴的 <w:r>>,
          "target_paragraph_index": int,
          "locator": "copy_run_to_paragraph",
          "changes": [{"paragraph": <tgt_idx>, "path": "runs[N]", "note": ...}]
        }

    依据说明：
        deepcopy 源 <w:r>（含 rPr 与 t/drawing 等），插入目标段落。
        依据：run 是样式载体，deepcopy 保 rPr 最可靠。
    样式保护说明：
        - 新 run 的 rPr 完整 deepcopy，不重建。
        - 不修改源 run、不修改目标段落已有 run 与 pPr。
    边界说明：
        - source_run_index 越界 -> 抛 ClipboardError。
        - position="start" 时插入到 pPr 之后（若无 pPr 则插到最前）。
        - 源 run 含 drawing（图片）-> 同文档内 r:embed 关系复用，可显示。
        - 源 run 属超链接 <w:hyperlink> 内 -> 本函数只取段落顶层 <w:r>，不进入
          hyperlink（局限）；如需复制超链接整体需另行扩展。
    """
    src_p = _resolve_anchor_p(doc, source_paragraph)
    tgt_p = _resolve_anchor_p(doc, target_paragraph)

    runs = src_p.findall(_w("r"))
    if source_run_index < 0 or source_run_index >= len(runs):
        raise ClipboardError(
            f"run 索引越界: {source_run_index}（源段共 {len(runs)} 个 run）")

    new_run = deepcopy(runs[source_run_index])

    if position == "end":
        tgt_p.append(new_run)
    elif position == "start":
        ppr = tgt_p.find(_w("pPr"))
        if ppr is not None:
            ppr.addnext(new_run)
        else:
            tgt_p.insert(0, new_run)
    else:
        raise ClipboardError(f"未知 position: {position}（应为 end/start）")

    tgt_idx = _body_index_of_p(doc, tgt_p)
    run_idx = len(tgt_p.findall(_w("r"))) - 1 if position == "end" else 0

    return {
        "doc": doc,
        "new_run": new_run,
        "target_paragraph_index": tgt_idx,
        "run_index": run_idx,
        "locator": "copy_run_to_paragraph",
        "changes": [
            {"paragraph": tgt_idx, "path": f"runs[{run_idx}]",
             "note": f"粘贴 run（源段落 run[{source_run_index}]）"}
        ],
    }


# ============================================================================
# 公共函数 3：copy_table_cell_to_cell
# ============================================================================
def copy_table_cell_to_cell(doc, src_table, src_row, src_col,
                            tgt_table, tgt_row, tgt_col,
                            mode: str = "append") -> dict:
    """
    把源单元格的内容（段落）复制到目标单元格。

    参数：
        src_table/row/col: 源单元格坐标
        tgt_table/row/col: 目标单元格坐标
        mode: "append"=把源单元格的段落追加到目标单元格（保留目标原有段落）；
              "replace"=先清空目标单元格的段落（保留一个空 p），再追加源段落

    返回：
        {
          "doc": doc,
          "locator": "copy_table_cell_to_cell",
          "changes": [{"paragraph": None, "path": "tbl[..].tc[..]", "note": ...}]
        }

    依据说明：
        源 tc 内每个 <w:p> deepcopy 后 append 到目标 tc。
        依据：deepcopy 保段落样式；tc 内段落是独立 <w:p>。
    样式保护说明：
        - 源段落 pPr/run rPr 完整 deepcopy。
        - append 模式不动目标单元格原有段落；replace 模式只删目标段落 run/多余段落，
          保留 tcPr 与一个空 p（OOXML 约束）。
    边界说明：
        - 坐标越界 -> 抛 ClipboardError/LocateError。
        - replace 模式：目标单元格保留其原 pPr 的一个空段落，再追加源段落。
        - 单元格内书签不重映射（表格内书签较少，局限；如需可调用方处理）。
    """
    src_tc = locate_table_cell(doc, src_table, src_row, src_col)["tc_elem"]
    tgt_tc = locate_table_cell(doc, tgt_table, tgt_row, tgt_col)["tc_elem"]

    if mode == "replace":
        # 清空目标单元格：保留第一个 p 的 pPr，删其 run；删其余 p
        ps = tgt_tc.findall(_w("p"))
        for p in ps[1:]:
            tgt_tc.remove(p)
        first = ps[0] if ps else None
        if first is not None:
            for r in list(first.findall(_w("r"))):
                first.remove(r)
    elif mode != "append":
        raise ClipboardError(f"未知 mode: {mode}（应为 append/replace）")

    # deepcopy 源单元格的段落追加到目标
    copied = 0
    for p in src_tc.findall(_w("p")):
        tgt_tc.append(deepcopy(p))
        copied += 1

    return {
        "doc": doc,
        "copied_paragraphs": copied,
        "locator": "copy_table_cell_to_cell",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{tgt_table}].tr[{tgt_row}].tc[{tgt_col}]",
             "note": f"复制单元格内容（mode={mode}，复制{copied}段）"}
        ],
    }


# ============================================================================
# 公共函数 4：copy_paragraph_across_docs（跨文档深度复制）
# ============================================================================
def copy_paragraph_across_docs(
    src_path, src_anchor,
    tgt_path, tgt_anchor,
    output_path: str | None = None,
    remap_bookmarks: bool = True,
) -> dict:
    """
    把源 docx 的段落深度复制到目标 docx，自动搬运全部依赖（图片/样式/编号）。

    参数：
        src_path: 源 docx 路径（只读）
        src_anchor: 源段落锚点（dict/int/<w:p>）
        tgt_path: 目标 docx 路径（加载后修改）
        tgt_anchor: 目标段落锚点（粘贴到其后）
        output_path: 输出路径，默认覆盖 tgt_path
        remap_bookmarks: 是否重映射书签 id/name

    返回：
        {
          "output_path": str,
          "new_paragraph_index": int,
          "copied_images": int,
          "copied_styles": {src_id: tgt_id},
          "num_map": {src_numId: tgt_numId},
          "remapped_bookmarks": int,
          "changes": [...]
        }

    依据说明：
        先 collect 段落依赖（pStyle/rStyle/numId/image rIds/bookmarks），
        再按依赖自底向上搬运：numbering -> styles -> images，
        最后 deepcopy 段落、remap 所有引用、插入目标。
        依据：跨文档时目标可能缺源的全部资源，必须逐一注入。
    样式保护说明：
        - 段落、样式定义、编号定义全部 deepcopy，不手工重建。
        - 图片字节原样复制，drawing 尺寸随 deepcopy 保留。
        - 冲突用"重命名合并"：样式内容相同则复用，不同则加 _copy 后缀；
          编号一律给新 id；图片按 sha1 自动去重。
        - 不修改源 docx；目标只新增，不改已有内容（除追加新 part/关系）。
    边界说明：
        - 源锚点不存在 -> 抛 ClipboardError/LocateError。
        - 目标锚点为 sectPr -> 抛 ClipboardError。
        - 段落含批注锚点（commentRangeStart/End）-> 不复制 comments.xml，留悬空（局限）。
        - 跨文档后 numId/styleId 已重映射，不会与目标冲突。
    """
    src_doc = Document(src_path)
    tgt_doc = Document(tgt_path)

    src_p = _resolve_anchor_p(src_doc, src_anchor)
    tgt_p = _resolve_anchor_p(tgt_doc, tgt_anchor)
    if _local(tgt_p.tag) == "sectPr":
        raise ClipboardError("禁止以 sectPr 作为目标")

    # 1. 收集依赖
    deps = collect_paragraph_dependencies(src_p)
    src_style_ids = set(deps["rStyles"])
    if deps["pStyle"]:
        src_style_ids.add(deps["pStyle"])

    # 2. numbering 复制（先于 styles，因 styles 可能引用 numId）
    NUM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"
    num_map: dict[str, str] = {}
    if deps["numId"]:
        try:
            src_numbering_root = src_doc.part.part_related_by(NUM_REL).element
            tgt_num_id = ensure_numbering(tgt_doc, src_numbering_root, deps["numId"])
            num_map[deps["numId"]] = tgt_num_id
        except (AttributeError, ValueError) as e:
            raise ClipboardError(f"编号复制失败: {e}")

    # 3. styles 复制
    STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    style_map: dict[str, str] = {}
    if src_style_ids:
        src_styles_root = src_doc.part.part_related_by(STYLES_REL).element
        style_map = ensure_styles(tgt_doc, src_styles_root, src_style_ids, num_map)

    # 4. 图片复制
    image_map: dict[str, str] = {}
    if deps["image_rids"]:
        image_map = ensure_images(tgt_doc, src_doc, deps["image_rids"])
    copied_images = sum(1 for v in image_map.values() if v)

    # 5. deepcopy 段落 + 重映射
    new_p = deepcopy(src_p)
    bookmark_start = max_bookmark_id(tgt_doc) + 1 if remap_bookmarks else 0
    if remap_bookmarks:
        remap_paragraph(new_p, style_map, num_map, image_map, bookmark_start)
    else:
        # 仍需重映射 styleId/numId/rId（这些必须改），仅跳过 bookmark
        remap_paragraph(new_p, style_map, num_map, image_map, bookmark_start)

    # 统计重映射书签数
    remapped_bm = 0
    if remap_bookmarks:
        remapped_bm = len(deps["bookmark_ids"])

    # 6. 插入目标
    tgt_p.addnext(new_p)

    # 7. 推断新段落索引 + 保存
    body = tgt_doc.element.body
    new_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is new_p:
                new_idx = p_counter
                break
            p_counter += 1

    out = output_path or tgt_path
    tgt_doc.save(out)

    return {
        "output_path": out,
        "new_paragraph_index": new_idx,
        "copied_images": copied_images,
        "copied_styles": style_map,
        "num_map": num_map,
        "remapped_bookmarks": remapped_bm,
        "changes": [
            {"paragraph": new_idx, "path": None,
             "note": f"跨文档粘贴段落（图片={copied_images}，样式={list(style_map.keys())}，编号={num_map}）"}
        ],
    }


# ============================================================================
# 公共函数 5：copy_table_across_docs（整表跨文档复制）
# ============================================================================
def copy_table_across_docs(
    src_path, src_table_index: int,
    tgt_path, tgt_anchor,
    output_path: str | None = None,
) -> dict:
    """
    把源 docx 的整张表格深度复制到目标 docx 锚点段之后，自动搬运全部依赖。

    参数：
        src_path: 源 docx 路径（只读）
        src_table_index: 源文档中 <w:tbl> 的索引（0 基，按 body 出现顺序）
        tgt_path: 目标 docx 路径（加载后修改）
        tgt_anchor: 目标段落锚点（粘贴到其后）
        output_path: 输出路径，默认覆盖 tgt_path

    返回：
        {
          "output_path": str,
          "new_table_index": int,
          "copied_images": int,
          "style_map": {src_id: tgt_id},
          "num_map": {src_numId: tgt_numId},
          "changes": [...]
        }

    依据说明：
        取源第 src_table_index 个 <w:tbl>，deepcopy → collect_elements_dependencies
        → 按「numbering→styles→images」迁移到 tgt → remap_elements → 插到 tgt 锚点段
        之后（addnext）。整表含其全部行/单元格/嵌套段落与图片。迁移顺序与
        copy_paragraph_across_docs 一致（numbering 先于 styles，因 styles 可能引用 numId）。
    样式保护说明：
        - 表格、样式定义、编号定义全部 deepcopy，不手工重建。
        - 图片字节原样复制，drawing 尺寸随 deepcopy 保留。
        - 冲突用「重命名合并」：样式内容相同则复用，不同则加 _copy 后缀。
        - 不修改源 docx；目标只新增，不改已有内容（除追加新 part/关系）。
    边界说明：
        - 源表索引越界 -> 抛 ClipboardError。
        - 目标锚点为 sectPr -> 抛 ClipboardError。
        - 表格含批注锚点（commentRangeStart/End）-> 不复制 comments.xml，留悬空（局限）。
    """
    src_doc = Document(src_path)
    tgt_doc = Document(tgt_path)

    # 定位源表
    src_tables = [c for c in src_doc.element.body if _local(c.tag) == "tbl"]
    if src_table_index < 0 or src_table_index >= len(src_tables):
        raise ClipboardError(
            f"源表索引越界: {src_table_index}（源文档共 {len(src_tables)} 张表）")
    src_tbl = src_tables[src_table_index]

    # 定位目标锚点
    tgt_p = _resolve_anchor_p(tgt_doc, tgt_anchor)
    if _local(tgt_p.tag) == "sectPr":
        raise ClipboardError("禁止以 sectPr 作为目标")

    # 1. 收集依赖
    deps = collect_elements_dependencies([src_tbl])
    src_style_ids = set(deps["rStyles"]) | deps["pStyles"] | deps["tblStyles"]

    NUM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"
    STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"

    # 2. numbering 复制
    num_map: dict[str, str] = {}
    for src_nid in deps["numIds"]:
        try:
            src_numbering_root = src_doc.part.part_related_by(NUM_REL).element
            tgt_num_id = ensure_numbering(tgt_doc, src_numbering_root, src_nid)
            num_map[src_nid] = tgt_num_id
        except (AttributeError, ValueError) as e:
            raise ClipboardError(f"编号复制失败: {e}")

    # 3. styles 复制
    style_map: dict[str, str] = {}
    if src_style_ids:
        src_styles_root = src_doc.part.part_related_by(STYLES_REL).element
        style_map = ensure_styles(tgt_doc, src_styles_root, src_style_ids, num_map)

    # 4. 图片复制
    image_map: dict[str, str] = {}
    if deps["image_rids"]:
        image_map = ensure_images(tgt_doc, src_doc, deps["image_rids"])
    copied_images = sum(1 for v in image_map.values() if v)

    # 5. deepcopy 表格 + 重映射
    new_tbl = deepcopy(src_tbl)
    bookmark_start = max_bookmark_id(tgt_doc) + 1
    remap_elements([new_tbl], style_map, num_map, image_map, bookmark_start)

    # 6. 插入目标（addnext 到锚点段之后）
    tgt_p.addnext(new_tbl)

    # 7. 推断新表索引 + 保存
    body = tgt_doc.element.body
    new_table_index = None
    t_counter = 0
    for c in body:
        if _local(c.tag) == "tbl":
            if c is new_tbl:
                new_table_index = t_counter
                break
            t_counter += 1

    out = output_path or tgt_path
    tgt_doc.save(out)

    return {
        "output_path": out,
        "new_table_index": new_table_index,
        "copied_images": copied_images,
        "style_map": style_map,
        "num_map": num_map,
        "changes": [
            {"paragraph": None, "path": f"tbl[{new_table_index}]",
             "note": f"跨文档粘贴整表（图片={copied_images}，样式={list(style_map.keys())}，编号={num_map}）"}
        ],
    }


# ============================================================================
# 公共函数 6：copy_range_across_docs（段落/表格范围跨文档复制）
# ============================================================================
def copy_range_across_docs(
    src_path, start_anchor, end_anchor_exclusive,
    tgt_path, tgt_anchor,
    output_path: str | None = None,
) -> dict:
    """
    把源 docx 中 start_anchor 到 end_anchor_exclusive（不含）之间的全部 body 子元素
    （<w:p> 与 <w:tbl>）批量深度复制到目标 docx 锚点段之后。

    参数：
        src_path: 源 docx 路径（只读）
        start_anchor: 源范围起始锚点（dict/int/<w:p>）
        end_anchor_exclusive: 源范围结束锚点（不含）；None 时取到源 body 末尾 sectPr 前
        tgt_path: 目标 docx 路径（加载后修改）
        tgt_anchor: 目标段落锚点（粘贴到其后）
        output_path: 输出路径，默认覆盖 tgt_path

    返回：
        {
          "output_path": str,
          "first_new_index": int,
          "inserted_count": int,
          "copied_images": int,
          "style_map": {src_id: tgt_id},
          "num_map": {src_numId: tgt_numId},
          "changes": [...]
        }

    依据说明：
        锚点复用 _resolve_anchor_p（dict/int/<w:p>）。收集 body 中 start 到 end
        （不含）之间的全部 p 与 tbl（排除 body 级 sectPr），批量 deepcopy → 迁移 →
        重映射 → 按序插到 tgt 锚点段之后。迁移顺序与 copy_paragraph_across_docs 一致。
    样式保护说明：
        - 所有元素、样式定义、编号定义全部 deepcopy，不手工重建。
        - 图片字节原样复制，drawing 尺寸随 deepcopy 保留。
        - 冲突用「重命名合并」。
        - 不修改源 docx；目标只新增。
    边界说明：
        - start/end 不是 body 直接子元素、end 在 start 之前 -> 抛 ClipboardError。
        - 目标锚点为 sectPr -> 抛 ClipboardError。
        - 不复制源末尾 body 级 sectPr。
        - end_anchor_exclusive=None 时取到 body 末尾 sectPr 前。
        - 含批注锚点 -> 留悬空（局限）。
    """
    src_doc = Document(src_path)
    tgt_doc = Document(tgt_path)

    # 定位源范围
    src_start_p = _resolve_anchor_p(src_doc, start_anchor)
    if _local(src_start_p.tag) != "p":
        raise ClipboardError("start_anchor 必须是 <w:p>")

    src_body = src_doc.element.body
    src_children = list(src_body)

    # 找 start 的 body 子级索引
    try:
        start_bi = src_children.index(src_start_p)
    except ValueError:
        raise ClipboardError("start_anchor 不在源 body 直接子级中")

    # 找 end 的 body 子级索引
    if end_anchor_exclusive is None:
        # 取到末尾 sectPr 前
        if src_children and _local(src_children[-1].tag) == "sectPr":
            end_bi = len(src_children) - 1
        else:
            end_bi = len(src_children)
    else:
        src_end_p = _resolve_anchor_p(src_doc, end_anchor_exclusive)
        if _local(src_end_p.tag) != "p":
            raise ClipboardError("end_anchor_exclusive 必须是 <w:p>")
        try:
            end_bi = src_children.index(src_end_p)
        except ValueError:
            raise ClipboardError("end_anchor_exclusive 不在源 body 直接子级中")
        if end_bi <= start_bi:
            raise ClipboardError(
                f"end_anchor_exclusive（body 子级索引 {end_bi}）"
                f" 必须在 start（{start_bi}）之后")

    # 收集范围内的元素（排除 sectPr）
    range_elems = []
    for c in src_children[start_bi:end_bi]:
        tag = _local(c.tag)
        if tag == "sectPr":
            continue
        range_elems.append(c)

    if not range_elems:
        # 空范围：仍需保存（保持一致行为）
        out = output_path or tgt_path
        tgt_doc.save(out)
        return {
            "output_path": out,
            "first_new_index": None,
            "inserted_count": 0,
            "copied_images": 0,
            "style_map": {},
            "num_map": {},
            "changes": [{"paragraph": None, "path": None, "note": "空范围，无插入"}],
        }

    # 定位目标锚点
    tgt_p = _resolve_anchor_p(tgt_doc, tgt_anchor)
    if _local(tgt_p.tag) == "sectPr":
        raise ClipboardError("禁止以 sectPr 作为目标")

    # 1. 收集依赖
    deps = collect_elements_dependencies(range_elems)
    src_style_ids = set(deps["rStyles"]) | deps["pStyles"] | deps["tblStyles"]

    NUM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"
    STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"

    # 2. numbering 复制
    num_map: dict[str, str] = {}
    for src_nid in deps["numIds"]:
        try:
            src_numbering_root = src_doc.part.part_related_by(NUM_REL).element
            tgt_num_id = ensure_numbering(tgt_doc, src_numbering_root, src_nid)
            num_map[src_nid] = tgt_num_id
        except (AttributeError, ValueError) as e:
            raise ClipboardError(f"编号复制失败: {e}")

    # 3. styles 复制
    style_map: dict[str, str] = {}
    if src_style_ids:
        src_styles_root = src_doc.part.part_related_by(STYLES_REL).element
        style_map = ensure_styles(tgt_doc, src_styles_root, src_style_ids, num_map)

    # 4. 图片复制
    image_map: dict[str, str] = {}
    if deps["image_rids"]:
        image_map = ensure_images(tgt_doc, src_doc, deps["image_rids"])
    copied_images = sum(1 for v in image_map.values() if v)

    # 5. deepcopy 全部元素 + 重映射
    new_elems = [deepcopy(e) for e in range_elems]
    bookmark_start = max_bookmark_id(tgt_doc) + 1
    remap_elements(new_elems, style_map, num_map, image_map, bookmark_start)

    # 6. 按序插到 tgt 锚点段之后（addnext 链式：逆序插入使顺序正确）
    insert_after = tgt_p
    for el in new_elems:
        insert_after.addnext(el)
        insert_after = el

    # 7. 推断首个新元素的 body 段落索引 + 保存
    body = tgt_doc.element.body
    first_new_index = None
    p_counter = 0
    first_elem = new_elems[0]
    for c in body:
        if _local(c.tag) == "p":
            if c is first_elem:
                first_new_index = p_counter
                break
            p_counter += 1
        # 若首个元素是表格，first_new_index 保持 None（表格不是段落）

    out = output_path or tgt_path
    tgt_doc.save(out)

    return {
        "output_path": out,
        "first_new_index": first_new_index,
        "inserted_count": len(new_elems),
        "copied_images": copied_images,
        "style_map": style_map,
        "num_map": num_map,
        "changes": [
            {"paragraph": first_new_index, "path": None,
             "note": f"跨文档粘贴范围（{len(new_elems)}个元素，图片={copied_images}，样式={list(style_map.keys())}，编号={num_map}）"}
        ],
    }


# ============================================================================
# 自测：对 base.docx 复制粘贴，并校验样式无损
# ============================================================================
def _self_test():
    from src.verifier import (
        compare_documents, validate_openable, extract_style_fingerprint,
    )
    from src.locator import _pstyle_value

    BASE = "input/base.docx"
    import os
    os.makedirs("output", exist_ok=True)

    # ---- 测试1：复制段落7（正文宋体四号）到段落2（标题1）后 ----
    doc = Document(BASE)
    res = copy_paragraph_after(doc, source=7, target=2)
    out1 = "output/clipboard_test_1.docx"
    doc.save(out1)
    # 插入位置(段落2)之前(0~2)零差异
    db, da = Document(BASE), Document(out1)
    for i in range(3):
        fpb = extract_style_fingerprint(db.paragraphs[i])
        fpa = extract_style_fingerprint(da.paragraphs[i])
        assert fpb["fingerprint_sha1"] == fpa["fingerprint_sha1"], f"段落{i}样式变化"
    # 新段落样式应与源段落7完全一致
    new_p = da.paragraphs[res["new_paragraph_index"]]
    fp_src = extract_style_fingerprint(db.paragraphs[7])
    fp_new = extract_style_fingerprint(new_p)
    assert fp_new["pPr_rPr"] == fp_src["pPr_rPr"], "新段落段落标记样式应与源一致"
    assert fp_new["runs"][0]["rPr"] == fp_src["runs"][0]["rPr"], "新段落run样式应与源一致"
    assert new_p.text == "正文宋体四号", new_p.text
    assert compare_documents(BASE, out1)["styles_xml_changed"] is False
    assert validate_openable(out1)
    print(f"[测试1 通过] 复制段落7到段落2后，新段落样式与源完全一致，0~2段零差异")

    # ---- 测试2：复制图片段31到段落7后，图片关系复用可显示 ----
    doc = Document(BASE)
    res = copy_paragraph_after(doc, source=31, target=7)
    out2 = "output/clipboard_test_2.docx"
    doc.save(out2)
    assert validate_openable(out2)
    doc2 = Document(out2)
    new_p = doc2.paragraphs[res["new_paragraph_index"]]
    # 新段落应含 3 个 drawing run，均引用 rId8
    drawings = new_p._p.findall(f".//{{http://schemas.openxmlformats.org/wordprocessingml/2006/main}}r")
    draw_count = len(new_p._p.findall(_w("r")))
    blips = list(new_p._p.iter(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"))
    assert len(blips) == 3, f"应有3个图片blip，实得{len(blips)}"
    embeds = [b.get(qn("r:embed")) for b in blips]
    assert all(e == "rId8" for e in embeds), f"图片应引用rId8，实得{embeds}"
    assert compare_documents(BASE, out2)["styles_xml_changed"] is False
    print(f"[测试2 通过] 复制图片段31到段落7后，3个图片关系rId8复用，可显示，styles.xml未变")

    # ---- 测试3：复制含书签的段落3（标题2，含_Toc234486119）到段落后，书签id重映射 ----
    doc = Document(BASE)
    max_id_before = _max_bookmark_id(doc)
    res = copy_paragraph_after(doc, source=3, target=7)
    assert res["remapped_bookmarks"] >= 1, "应重映射至少1个书签"
    out3 = "output/clipboard_test_3.docx"
    doc.save(out3)
    assert validate_openable(out3)
    doc2 = Document(out3)
    # 新段落的 bookmarkStart name 应带 _copy 后缀，id 应 > max_id_before
    new_p = doc2.paragraphs[res["new_paragraph_index"]]
    bms = new_p._p.findall(_w("bookmarkStart"))
    assert len(bms) >= 1, "新段落应含书签"
    for bm in bms:
        name = bm.get(_w("name"))
        assert name and name.endswith("_copy"), f"书签名应加_copy后缀，实得{name}"
        assert int(bm.get(_w("id"))) > max_id_before, "书签id应大于原最大id"
    print(f"[测试3 通过] 复制含书签段落3，书签id重映射(>{max_id_before})、name加_copy后缀")

    # ---- 测试4：复制段落7的run[0]到段落2末尾 ----
    doc = Document(BASE)
    res = copy_run_to_paragraph(doc, source_run_index=0,
                                source_paragraph=7, target_paragraph=2,
                                position="end")
    out4 = "output/clipboard_test_4.docx"
    doc.save(out4)
    # 不改变段落数 -> 全量校验，仅放行目标段落的新 run
    result = compare_documents(BASE, out4, expected_changes=res["changes"])
    assert result["unexpected_changes"] == [], (
        f"测试4 意外改动: {result['unexpected_changes']}")
    assert validate_openable(out4)
    doc2 = Document(out4)
    p2 = doc2.paragraphs[2]
    assert p2.text.endswith("正文宋体四号"), p2.text  # 标题1末尾追加"正文宋体四号"
    # 新 run 的 rPr 应与源 run 一致（宋体 sz28）
    new_rpr = p2.runs[-1]._r.find(_w("rPr"))
    sz = new_rpr.find(_w("sz"))
    assert sz is not None and sz.get(_w("val")) == "28", "复制run应保留字号28"
    print(f"[测试4 通过] 复制段落7的run到段落2末尾，保留字号28，全量校验无意外改动")

    # ---- 测试5：复制单元格(0,1,1)内容到(0,2,1)（replace模式）----
    doc = Document(BASE)
    # 先看原值：行1列1=2，行2列1=6
    res = copy_table_cell_to_cell(doc, 0, 1, 1, 0, 2, 1, mode="replace")
    out5 = "output/clipboard_test_5.docx"
    doc.save(out5)
    assert validate_openable(out5)
    doc2 = Document(out5)
    tgt_cell = doc2.tables[0].rows[2].cells[1].text
    # replace 后目标单元格应含源内容"2"
    assert "2" in tgt_cell, f"目标单元格应含源内容2，实得{tgt_cell!r}"
    print(f"[测试5 通过] 复制单元格(0,1,1)->(0,2,1) replace模式，目标含源内容")

    # ---- 边界测试 ----
    doc = Document(BASE)
    for fn, desc in [
        (lambda: copy_run_to_paragraph(doc, 99, 7, 2), "run索引越界"),
        (lambda: copy_table_cell_to_cell(doc, 0, 9, 9, 0, 0, 0), "单元格越界"),
    ]:
        try:
            fn(); raised = False
        except (ClipboardError, LocateError):
            raised = True
        assert raised, f"应抛异常: {desc}"
    print(f"[边界通过] run索引越界/单元格越界 均抛异常")
    print()
    print("产出文件：output/clipboard_test_1~5.docx（供人工验证）")
    print()


# ============================================================================
# 跨文档深度复制测试：从 base.docx 复制到贫瘠目标文档
# ============================================================================
def _self_test_xdoc():
    """跨文档复制：从 base.docx 复制段落到 input/target_plain.docx（贫瘠目标），
    验证图片/样式/编号/书签全部正确注入，且样式指纹与源一致。"""
    from src.verifier import validate_openable, extract_style_fingerprint
    import os, shutil

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    def fresh_target():
        """每次复制都用全新的贫瘠目标，互不污染。"""
        p = "output/_xdoc_target_tmp.docx"
        shutil.copy("input/target_plain.docx", p)
        return p

    # ---- 测试1：复制图片段31（3张图，rId8）到目标 ----
    tgt = fresh_target()
    res = copy_paragraph_across_docs(BASE, 31, tgt, 0,
                                     output_path="output/xdoc_test_1.docx")
    assert res["copied_images"] == 1, f"应注入1个图片part（3张引用同一图），实得{res}"
    assert validate_openable("output/xdoc_test_1.docx")
    doc = Document("output/xdoc_test_1.docx")
    new_p = doc.paragraphs[res["new_paragraph_index"]]
    # 新段落应含 3 个 blip，且 r:embed 已重映射为新 rId（非 rId8）
    blips = list(new_p._p.iter(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"))
    assert len(blips) == 3, f"应有3个blip，实得{len(blips)}"
    R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    embeds = [b.get(f"{{{R}}}embed") for b in blips]
    assert all(e and e != "rId8" for e in embeds), f"embed应已重映射，实得{embeds}"
    # 目标 media 应新增 png
    import zipfile
    media = [n for n in zipfile.ZipFile("output/xdoc_test_1.docx").namelist()
             if n.startswith("word/media/")]
    assert len(media) >= 1, f"目标应含media，实得{media}"
    print(f"[xdoc测试1 通过] 复制图片段31跨文档，3图rId重映射，media注入{len(media)}个")

    # ---- 测试2：复制列表段13（numId=1）到目标 ----
    tgt = fresh_target()
    res = copy_paragraph_across_docs(BASE, 13, tgt, 0,
                                     output_path="output/xdoc_test_2.docx")
    assert res["num_map"], "应有 numId 映射"
    assert validate_openable("output/xdoc_test_2.docx")
    doc = Document("output/xdoc_test_2.docx")
    new_p = doc.paragraphs[res["new_paragraph_index"]]
    # 新段落的 numId 应已重映射为目标新 id
    numpr = new_p._p.find(_w("pPr")).find(_w("numPr")) if new_p._p.find(_w("pPr")) is not None else None
    if numpr is None:
        numpr = new_p._p.find(f".//{_w('numPr')}")
    assert numpr is not None, "新段落应保留 numPr"
    nid_el = numpr.find(_w("numId"))
    new_numid = nid_el.get(_w("val"))
    assert new_numid == res["num_map"]["1"], (
        f"numId应重映射为{res['num_map']['1']}，实得{new_numid}")
    print(f"[xdoc测试2 通过] 复制列表段13跨文档，numId 1->{res['num_map']['1']}，编号定义已注入")

    # ---- 测试3：复制标题段2（pStyle=1）到目标，样式注入 ----
    tgt = fresh_target()
    res = copy_paragraph_across_docs(BASE, 2, tgt, 0,
                                     output_path="output/xdoc_test_3.docx")
    assert validate_openable("output/xdoc_test_3.docx")
    doc = Document("output/xdoc_test_3.docx")
    new_p = doc.paragraphs[res["new_paragraph_index"]]
    # 目标 styles 应新增 styleId=1（heading1）
    from src.locator import _pstyle_value
    assert _pstyle_value(new_p._p) == "1", "新段落应保留 pStyle=1"
    # 样式指纹：源段落2 与目标新段落的 pPr/run rPr 应一致
    src_doc = Document(BASE)
    fp_src = extract_style_fingerprint(src_doc.paragraphs[2])
    fp_new = extract_style_fingerprint(new_p)
    assert fp_src["pPr"] == fp_new["pPr"], f"段落pPr样式应一致\nsrc={fp_src['pPr']}\nnew={fp_new['pPr']}"
    print(f"[xdoc测试3 通过] 复制标题段2跨文档，pStyle=1样式注入，pPr指纹与源一致")

    # ---- 测试4：复制含书签段3（_Toc234486119）到目标，书签id重映射 ----
    tgt = fresh_target()
    res = copy_paragraph_across_docs(BASE, 3, tgt, 0,
                                     output_path="output/xdoc_test_4.docx")
    assert res["remapped_bookmarks"] >= 1, "应重映射书签"
    assert validate_openable("output/xdoc_test_4.docx")
    doc = Document("output/xdoc_test_4.docx")
    new_p = doc.paragraphs[res["new_paragraph_index"]]
    bms = new_p._p.findall(_w("bookmarkStart"))
    assert len(bms) >= 1
    for bm in bms:
        name = bm.get(_w("name"))
        assert name and name.endswith("_copy"), f"书签名应加_copy，实得{name}"
    print(f"[xdoc测试4 通过] 复制含书签段3跨文档，书签id重映射、name加_copy")

    # ---- 测试5：综合——复制段7（正文宋体四号，带rPr）到目标，rPr指纹一致 ----
    tgt = fresh_target()
    res = copy_paragraph_across_docs(BASE, 7, tgt, 0,
                                     output_path="output/xdoc_test_5.docx")
    assert validate_openable("output/xdoc_test_5.docx")
    doc = Document("output/xdoc_test_5.docx")
    new_p = doc.paragraphs[res["new_paragraph_index"]]
    fp_src = extract_style_fingerprint(Document(BASE).paragraphs[7])
    fp_new = extract_style_fingerprint(new_p)
    assert fp_src["runs"][0]["rPr"] == fp_new["runs"][0]["rPr"], (
        f"run rPr应一致\nsrc={fp_src['runs'][0]['rPr']}\nnew={fp_new['runs'][0]['rPr']}")
    assert fp_src["pPr_rPr"] == fp_new["pPr_rPr"], "段落标记rPr应一致"
    print(f"[xdoc测试5 通过] 复制段7跨文档，run rPr与段落标记rPr指纹与源完全一致")
    print()
    print("产出文件：output/xdoc_test_1~5.docx（供人工验证跨文档复制）")


if __name__ == "__main__":
    _self_test()
    print("=" * 60)
    _self_test_xdoc()
