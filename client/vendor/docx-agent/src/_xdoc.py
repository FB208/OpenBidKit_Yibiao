# -*- coding: utf-8 -*-
"""
跨文档深度复制内部工具（_xdoc）

隔离跨文档复制的复杂依赖处理：numbering / styles / images / bookmark 重映射。
供 clipboard.copy_paragraph_across_docs 调用。

================================================================
技术依据（全部来自 base.docx 实测 + python-docx 源码，见 logs/dev_log.md）
================================================================
1. 图片：drawing 内 r:embed=rIdN → 关系 → media/imageN.png。
   get_or_add_image_part(BytesIO(blob)) 内部按 sha1 去重，自动复用目标已存在相同图片；
   doc.part.relate_to(image_part, RT.IMAGE) 返回新 rId。
2. numbering：numId(段落引用) → abstractNumId(定义本体)，两套独立 id 空间。
   OOXML 要求 abstractNum 元素排在 num 之前。
3. styles：pStyle/rStyle 引用 styleId；styles.xml 含 numPr 可反向引用 numId；
   docDefaults 经 asciiTheme 等引用 theme1.xml 字体方案。
4. 书签：bookmarkStart/End 的 id 需在目标内唯一。
"""

from __future__ import annotations

import io
from copy import deepcopy
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def _r(name: str) -> str:
    return f"{{{R_NS}}}{name}"


def _local(tag) -> str:
    return etree.QName(tag).localname


# ============================================================================
# 1. 依赖收集：扫描段落，列出它引用的所有外部依赖
# ============================================================================
def collect_paragraph_dependencies(p_elem) -> dict:
    """
    扫描一个 <w:p>，返回它依赖的全部外部资源 id。

    返回：
        {
          "pStyle": str|None,              # 段落样式 styleId
          "rStyles": set[str],             # run 字符样式 styleId 集合
          "numId": str|None,               # 列表编号 numId
          "image_rids": set[str],          # drawing 引用的 r:embed
          "bookmark_ids": set[str],        # bookmarkStart/End 的 id
        }

    依据说明：
        - pStyle 在 pPr/pStyle；rStyle 在各 run 的 rPr/rStyle；
        - numId 在 pPr/numPr/numId；
        - 图片 r:embed 在 run/drawing//a:blip（或 VML pict 的 r:id）；
        - bookmark id 在 bookmarkStart/End 的 w:id。
    """
    pStyle = None
    rStyles: set[str] = set()
    numId = None
    image_rids: set[str] = set()
    bookmark_ids: set[str] = set()

    ppr = p_elem.find(_w("pPr"))
    if ppr is not None:
        ps = ppr.find(_w("pStyle"))
        if ps is not None:
            pStyle = ps.get(_w("val"))
        numpr = ppr.find(_w("numPr"))
        if numpr is not None:
            nid_el = numpr.find(_w("numId"))
            if nid_el is not None:
                numId = nid_el.get(_w("val"))

    # run 级：rStyle + 图片
    for r in p_elem.iter(_w("r")):
        rpr = r.find(_w("rPr"))
        if rpr is not None:
            rs = rpr.find(_w("rStyle"))
            if rs is not None:
                rval = rs.get(_w("val"))
                if rval:
                    rStyles.add(rval)
        # drawing 内 blip 的 r:embed
        for blip in r.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
            embed = blip.get(_r("embed"))
            if embed:
                image_rids.add(embed)
        # VML pict 的 r:id（imagedata）
        for imgdata in r.iter("{urn:schemas-microsoft-com:vml:office}imagedata"):
            rid = imgdata.get(_r("id"))
            if rid:
                image_rids.add(rid)

    # 书签 id
    for bm in p_elem.iter(_w("bookmarkStart")):
        bid = bm.get(_w("id"))
        if bid is not None:
            bookmark_ids.add(bid)
    for bm in p_elem.iter(_w("bookmarkEnd")):
        bid = bm.get(_w("id"))
        if bid is not None:
            bookmark_ids.add(bid)

    return {
        "pStyle": pStyle,
        "rStyles": rStyles,
        "numId": numId,
        "image_rids": image_rids,
        "bookmark_ids": bookmark_ids,
    }


# ============================================================================
# 1b. 多元素依赖收集：collect_paragraph_dependencies 的多元素推广版
# ============================================================================
def collect_elements_dependencies(elems) -> dict:
    """
    扫描一组 body 元素（段落与表格），合并去重返回它们依赖的全部外部资源 id。

    返回（与 collect_paragraph_dependencies 同 shape，但聚合）：
        {
          "pStyle": None,                 # 多元素时恒为 None（多段可能有不同 pStyle）
          "rStyles": set[str],            # 所有 run 字符样式 styleId 集合
          "numId": None,                  # 多元素时恒为 None（多段可能有不同 numId）
          "image_rids": set[str],         # 所有 drawing 引用的 r:embed
          "bookmark_ids": set[str],       # 所有 bookmarkStart/End 的 id
          "pStyles": set[str],            # 所有段落样式 styleId 集合（pStyle）
          "tblStyles": set[str],          # 所有表格样式 styleId 集合（tblStyle）
          "numIds": set[str],             # 所有 numId 集合
        }

    依据说明：
        - pStyle 在 pPr/pStyle；tblStyle 在 tblPr/tblStyle；rStyle 在各 run 的 rPr/rStyle；
        - numId 在 pPr/numPr/numId；
        - 图片 r:embed 在 run/drawing//a:blip（或 VML pict 的 r:id）；
        - bookmark id 在 bookmarkStart/End 的 w:id。
    样式保护说明：
        - 纯扫描收集，不改任何元素；调用方负责 deepcopy 后再 remap。
    边界说明：
        - elems 为空 -> 返回全空集合。
        - elems 中含非 p/tbl 元素 -> 仍扫描其子树（安全，不会报错）。
    """
    rStyles: set[str] = set()
    image_rids: set[str] = set()
    bookmark_ids: set[str] = set()
    pStyles: set[str] = set()
    tblStyles: set[str] = set()
    numIds: set[str] = set()

    for el in elems:
        # pStyle
        for ps in el.iter(_w("pStyle")):
            val = ps.get(_w("val"))
            if val:
                pStyles.add(val)
        # tblStyle
        for ts in el.iter(_w("tblStyle")):
            val = ts.get(_w("val"))
            if val:
                tblStyles.add(val)
        # rStyle
        for rs in el.iter(_w("rStyle")):
            val = rs.get(_w("val"))
            if val:
                rStyles.add(val)
        # numId（排除 0）
        for nid in el.iter(_w("numId")):
            val = nid.get(_w("val"))
            if val and val != "0":
                numIds.add(val)
        # drawing 内 blip 的 r:embed
        for blip in el.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
            embed = blip.get(_r("embed"))
            if embed:
                image_rids.add(embed)
        # VML pict 的 r:id（imagedata）
        for imgdata in el.iter("{urn:schemas-microsoft-com:vml:office}imagedata"):
            rid = imgdata.get(_r("id"))
            if rid:
                image_rids.add(rid)
        # 书签 id
        for bm in el.iter(_w("bookmarkStart")):
            bid = bm.get(_w("id"))
            if bid is not None:
                bookmark_ids.add(bid)
        for bm in el.iter(_w("bookmarkEnd")):
            bid = bm.get(_w("id"))
            if bid is not None:
                bookmark_ids.add(bid)

    return {
        "pStyle": None,
        "rStyles": rStyles,
        "numId": None,
        "image_rids": image_rids,
        "bookmark_ids": bookmark_ids,
        "pStyles": pStyles,
        "tblStyles": tblStyles,
        "numIds": numIds,
    }


# ============================================================================
# 2. numbering 复制：把源 numId 的定义搬到目标，返回 numId 映射
# ============================================================================
def _max_num_id(numbering_root, attr: str) -> int:
    """取 numbering 中所有 num 或 abstractNum 的最大 id。attr='numId'或'abstractNumId'。"""
    tag = "num" if attr == "numId" else "abstractNum"
    max_id = -1
    for el in numbering_root.findall(_w(tag)):
        try:
            v = int(el.get(_w(attr)))
            if v > max_id:
                max_id = v
        except (TypeError, ValueError):
            continue
    return max_id


def ensure_numbering(tgt_doc, src_numbering_root, src_num_id: str) -> str:
    """
    把源 numId 对应的编号定义复制到目标 numbering.xml，返回目标新 numId。

    依据说明：
        源 numId -> abstractNumId -> abstractNum 定义。
        在目标 deepcopy abstractNum（改新 abstractNumId）+ deepcopy num（改新 numId，
        abstractNumId 引用改为新值）。OOXML 要求 abstractNum 在 num 之前，
        故 abstractNum 插到目标 numbering 首个 num 之前（或末尾）。
    样式保护说明：
        deepcopy 整个 abstractNum（含所有 lvl 的 numFmt/lvlText/start 等），不手工重建。
    边界说明：
        - 源无 numbering part -> 抛异常。
        - src_num_id 在源不存在 -> 抛异常。
        - 目标无 numbering part -> python-docx 的 Document 默认有 numbering part
          （即使空），用 doc.part.numbering_part.element 获取；若仍无则新建。
    """
    # 源：找 numId -> abstractNumId
    src_num_el = None
    for num in src_numbering_root.findall(_w("num")):
        if num.get(_w("numId")) == src_num_id:
            src_num_el = num
            break
    if src_num_el is None:
        raise ValueError(f"源 numbering 无 numId={src_num_id}")
    src_anid_el = src_num_el.find(_w("abstractNumId"))
    src_abstract_id = src_anid_el.get(_w("val")) if src_anid_el is not None else None
    src_abstract_el = None
    for an in src_numbering_root.findall(_w("abstractNum")):
        if an.get(_w("abstractNumId")) == src_abstract_id:
            src_abstract_el = an
            break
    if src_abstract_el is None:
        raise ValueError(f"源 numbering 无 abstractNumId={src_abstract_id}")

    # 目标 numbering part（通过关系定位；python-docx 空文档也有 numbering part）
    NUM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"
    tgt_numbering_root = tgt_doc.part.part_related_by(NUM_REL).element

    # 分配新 id
    new_abstract_id = _max_num_id(tgt_numbering_root, "abstractNumId") + 1
    new_num_id = _max_num_id(tgt_numbering_root, "numId") + 1

    # deepcopy abstractNum，改 id
    new_abstract = deepcopy(src_abstract_el)
    new_abstract.set(_w("abstractNumId"), str(new_abstract_id))
    # abstractNum 必须排在所有 num 之前：插到目标首个 num 之前，否则末尾
    first_num = tgt_numbering_root.find(_w("num"))
    if first_num is not None:
        first_num.addprevious(new_abstract)
    else:
        tgt_numbering_root.append(new_abstract)

    # deepcopy num，改 numId 与 abstractNumId 引用
    new_num = deepcopy(src_num_el)
    new_num.set(_w("numId"), str(new_num_id))
    new_anid = new_num.find(_w("abstractNumId"))
    if new_anid is not None:
        new_anid.set(_w("val"), str(new_abstract_id))
    tgt_numbering_root.append(new_num)

    return str(new_num_id)


# ============================================================================
# 3. styles 复制：把源 styleId 的定义搬到目标，返回 styleId 映射
# ============================================================================
def _styles_root(doc):
    """获取 styles.xml 的 <w:styles> 根元素。依据：通过 styles 关系定位 part。"""
    STYLES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    return doc.part.part_related_by(STYLES_REL).element


def _style_signature(style_el) -> tuple:
    """生成样式定义的内容签名（用于冲突比对，忽略 styleId 本身）。"""
    clone = deepcopy(style_el)
    # 去掉 styleId 属性，只比内容
    clone.attrib.pop(_w("styleId"), None)
    return etree.tostring(clone, encoding="unicode")


def ensure_styles(tgt_doc, src_styles_root, src_style_ids: set[str],
                  num_map: dict) -> dict:
    """
    把源 styleId 集合的样式定义复制到目标 styles.xml，返回 {src_styleId: tgt_styleId}。

    冲突策略（重命名合并）：
        - 目标无该 styleId -> 直接 deepcopy，styleId 不变，映射为原值。
        - 目标有该 styleId 且内容签名相同 -> 复用，映射为原值。
        - 目标有该 styleId 但内容不同 -> 源副本 styleId 加 _copy 后缀，
          映射为新值，段落引用需重映射。
        - 样式若自身含 numPr/numId，用 num_map 重映射。

    依据说明：
        styles.xml 的 <w:style styleId=...>；styleId 是段落/run 的引用键。
    样式保护说明：
        deepcopy 整个 style 节点（含 pPr/rPr/tablePr 等），不手工重建。
    边界说明：
        - 源无某 styleId -> 跳过（映射为 None）。
        - basedOn/link 引用的其它样式：本版递归复制直接依赖，但深层链不完整递归
          （局限：若样式基于另一未复制样式，渲染可能回落默认）。
    """
    tgt_root = _styles_root(tgt_doc)
    # 目标已有 styleId -> 签名
    tgt_existing: dict[str, str] = {}
    for s in tgt_root.findall(_w("style")):
        sid = s.get(_w("styleId"))
        if sid:
            tgt_existing[sid] = _style_signature(s)

    mapping: dict[str, str] = {}
    for src_sid in src_style_ids:
        if src_sid is None:
            continue
        # 找源样式定义
        src_style_el = None
        for s in src_styles_root.findall(_w("style")):
            if s.get(_w("styleId")) == src_sid:
                src_style_el = s
                break
        if src_style_el is None:
            mapping[src_sid] = src_sid  # 源没有则原样（可能走默认）
            continue

        src_sig = _style_signature(src_style_el)

        if src_sid not in tgt_existing:
            # 目标无 -> 直接加，styleId 不变
            new_style = deepcopy(src_style_el)
            _remap_style_numid(new_style, num_map)
            tgt_root.append(new_style)
            tgt_existing[src_sid] = src_sig
            mapping[src_sid] = src_sid
        elif tgt_existing[src_sid] == src_sig:
            # 内容相同 -> 复用
            mapping[src_sid] = src_sid
        else:
            # 冲突 -> 加后缀
            new_sid = src_sid + "_copy"
            while new_sid in tgt_existing:
                new_sid += "x"
            new_style = deepcopy(src_style_el)
            new_style.set(_w("styleId"), new_sid)
            # basedOn 若引用原 src_sid，改为目标的同款（若目标有则指向目标，否则保留）
            _remap_style_numid(new_style, num_map)
            tgt_root.append(new_style)
            tgt_existing[new_sid] = src_sig
            mapping[src_sid] = new_sid

    return mapping


def _remap_style_numid(style_el, num_map: dict):
    """样式内若有 numPr/numId，按 num_map 重映射。"""
    if not num_map:
        return
    for numpr in style_el.iter(_w("numPr")):
        nid_el = numpr.find(_w("numId"))
        if nid_el is not None:
            old = nid_el.get(_w("val"))
            if old in num_map:
                nid_el.set(_w("val"), num_map[old])


# ============================================================================
# 4. 图片复制：把源图片搬到目标，返回 {src_rId: tgt_rId}
# ============================================================================
def ensure_images(tgt_doc, src_doc, src_rids: set[str]) -> dict:
    """
    把源 docx 中 rId 对应的图片复制到目标，返回 {src_rId: tgt_rId}。

    依据说明：
        源 rId -> 源 document.xml.rels -> media/imageN.png (blob)。
        目标 get_or_add_image_part(BytesIO(blob)) 按 sha1 去重复用，
        relate_to(image_part, RT.IMAGE) 拿新 rId。
    样式保护说明：
        图片字节原样复制，不改内容；drawing 尺寸等属性随段落 deepcopy 保留。
    边界说明：
        - 源 rId 在源无对应关系 -> 跳过（映射为 None）。
        - 同一图片多次引用 -> get_or_add 自动复用同一 part，但 relate_to 每次可给新 rId
          （指向同一 part），合法。
    """
    mapping: dict[str, str] = {}
    if not src_rids:
        return mapping
    src_part = src_doc.part
    tgt_part = tgt_doc.part
    tgt_pkg = tgt_part.package

    for src_rid in src_rids:
        # python-docx 的 related_parts 是 {rId: Part} 字典
        if src_rid not in src_part.related_parts:
            mapping[src_rid] = None
            continue
        src_image_part = src_part.related_parts[src_rid]

        blob = src_image_part.blob
        # get_or_add_image_part 接受 IO[bytes]，内部按 sha1 去重
        tgt_image_part = tgt_pkg.get_or_add_image_part(io.BytesIO(blob))
        # 建立目标 document -> image_part 关系，拿 rId
        tgt_rid = tgt_part.relate_to(tgt_image_part, RT.IMAGE)
        mapping[src_rid] = tgt_rid

    return mapping


# ============================================================================
# 5. 段落引用重映射：把副本内所有 id/styleId/numId/rId 回填为目标值
# ============================================================================
def remap_paragraph(p_elem, style_map: dict, num_map: dict,
                    image_map: dict, bookmark_start_id: int) -> int:
    """
    原地重映射段落副本内的所有引用，返回下一个可用 bookmark id。

    依据说明：
        - pPr/pStyle、run/rPr/rStyle -> 用 style_map 回填
        - pPr/numPr/numId -> 用 num_map 回填
        - drawing//a:blip 的 r:embed、VML imagedata 的 r:id -> 用 image_map 回填
        - bookmarkStart/End 的 w:id -> 从 bookmark_start_id 起递增；name 加 _copy
    """
    next_id = bookmark_start_id

    # pStyle
    ppr = p_elem.find(_w("pPr"))
    if ppr is not None:
        ps = ppr.find(_w("pStyle"))
        if ps is not None:
            old = ps.get(_w("val"))
            if old in style_map and style_map[old]:
                ps.set(_w("val"), style_map[old])
        # numId
        numpr = ppr.find(_w("numPr"))
        if numpr is not None:
            nid_el = numpr.find(_w("numId"))
            if nid_el is not None:
                old = nid_el.get(_w("val"))
                if old in num_map:
                    nid_el.set(_w("val"), num_map[old])

    # rStyle + 图片 rId
    for r in p_elem.iter(_w("r")):
        rpr = r.find(_w("rPr"))
        if rpr is not None:
            rs = rpr.find(_w("rStyle"))
            if rs is not None:
                old = rs.get(_w("val"))
                if old in style_map and style_map[old]:
                    rs.set(_w("val"), style_map[old])
        for blip in r.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
            old = blip.get(_r("embed"))
            if old in image_map and image_map[old]:
                blip.set(_r("embed"), image_map[old])
        for imgdata in r.iter("{urn:schemas-microsoft-com:vml:office}imagedata"):
            old = imgdata.get(_r("id"))
            if old in image_map and image_map[old]:
                imgdata.set(_r("id"), image_map[old])

    # 书签 id + name
    for bm in p_elem.iter(_w("bookmarkStart")):
        bm.set(_w("id"), str(next_id))
        old_name = bm.get(_w("name"))
        if old_name:
            bm.set(_w("name"), old_name + "_copy")
        next_id += 1
    for bm in p_elem.iter(_w("bookmarkEnd")):
        bm.set(_w("id"), str(next_id))
        next_id += 1

    return next_id


# ============================================================================
# 5b. 多元素引用重映射：remap_paragraph 的多元素推广版
# ============================================================================
def remap_elements(elems, style_map: dict, num_map: dict,
                   image_map: dict, bookmark_start_id: int) -> int:
    """
    原地重映射一组元素（段落+表格）副本内的所有引用，返回下一个可用 bookmark id。

    依据说明：
        - pPr/pStyle、tblPr/tblStyle、run/rPr/rStyle -> 用 style_map 回填
        - pPr/numPr/numId -> 用 num_map 回填
        - drawing//a:blip 的 r:embed、VML imagedata 的 r:id -> 用 image_map 回填
        - bookmarkStart/End 的 w:id -> 从 bookmark_start_id 起递增；name 加 _copy
    样式保护说明：
        - 只改引用属性（val/embed/id），不删不改其它子元素。
        - bookmark name 加 _copy 后缀，与 remap_paragraph 一致。
    边界说明：
        - elems 为空 -> 返回 bookmark_start_id（不变）。
        - map 中无对应 key -> 原值保留（未命中不报错）。
    """
    next_id = bookmark_start_id

    for el in elems:
        # pStyle / tblStyle / rStyle（遍历所有出现）
        for ps in el.iter(_w("pStyle")):
            old = ps.get(_w("val"))
            if old in style_map and style_map[old]:
                ps.set(_w("val"), style_map[old])
        for ts in el.iter(_w("tblStyle")):
            old = ts.get(_w("val"))
            if old in style_map and style_map[old]:
                ts.set(_w("val"), style_map[old])
        for rs in el.iter(_w("rStyle")):
            old = rs.get(_w("val"))
            if old in style_map and style_map[old]:
                rs.set(_w("val"), style_map[old])
        # numId
        for nid in el.iter(_w("numId")):
            old = nid.get(_w("val"))
            if old in num_map:
                nid.set(_w("val"), num_map[old])
        # 图片 rId
        for blip in el.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
            old = blip.get(_r("embed"))
            if old in image_map and image_map[old]:
                blip.set(_r("embed"), image_map[old])
        for imgdata in el.iter("{urn:schemas-microsoft-com:vml:office}imagedata"):
            old = imgdata.get(_r("id"))
            if old in image_map and image_map[old]:
                imgdata.set(_r("id"), image_map[old])

        # 书签 id + name（顺序：先 start 后 end，与 remap_paragraph 一致）
        for bm in el.iter(_w("bookmarkStart")):
            bm.set(_w("id"), str(next_id))
            old_name = bm.get(_w("name"))
            if old_name:
                bm.set(_w("name"), old_name + "_copy")
            next_id += 1
        for bm in el.iter(_w("bookmarkEnd")):
            bm.set(_w("id"), str(next_id))
            next_id += 1

    return next_id


def max_bookmark_id(doc) -> int:
    """取文档当前最大 bookmark id。"""
    body = doc.element.body
    max_id = -1
    for bm in body.iter(_w("bookmarkStart")):
        try:
            v = int(bm.get(_w("id")))
            if v > max_id:
                max_id = v
        except (TypeError, ValueError):
            continue
    for bm in body.iter(_w("bookmarkEnd")):
        try:
            v = int(bm.get(_w("id")))
            if v > max_id:
                max_id = v
        except (TypeError, ValueError):
            continue
    return max_id
