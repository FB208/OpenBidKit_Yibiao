# -*- coding: utf-8 -*-
"""
阶段2 模块2：写入器（Writer）

定位：在 locator 锚定的位置执行"类人写入"——插入段落、追加文本、
在指定位置写入新 run。所有写入都保证样式无损（依据 verifier 校验）。

================================================================
开发依据（基于 base.docx 真实结构，见 logs/base_structure.md + 实测）
================================================================
1. body 子元素序列末尾是 sectPr：<w:body>...<w:p/><w:sectPr/></w:body>
   → 插入新段落必须插到 sectPr 之前，否则文档结构损坏。
2. 段落7（正文宋体四号）结构：
     <w:p>
       <w:pPr><w:rPr>...宋体 sz28 szCs28...</w:rPr></w:pPr>
       <w:r><w:rPr>...宋体 sz28 szCs28...</w:rPr><w:t>正文宋体四号</w:t></w:r>
     </w:p>
   → 段落标记样式在 pPr/rPr；run 样式在 r/rPr。
3. 段落2（标题1）结构：
     <w:pPr><w:pStyle w:val="1"/></w:pPr>
     <w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>...<w:t>标题</w:t></w:r>
   → 标题段落字体走样式继承，run 的 rPr 很精简（仅 hint）。
4. run 内可能含 <w:lastRenderedPageBreak/>（渲染缓存，非样式）、<w:bookmarkEnd> 等
   非文本子元素 → 复制 rPr 时只取 rPr 节点，不复制这些。

已确认 XML 样本（来自 base.docx 实测，见上方）。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

# 兼容直接运行（python src/writer.py）：把项目根加入路径以导入 src 包
import os as _os, sys as _sys
if __package__ in (None, ""):
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from src.locator import (
    locate_by_paragraph_index,
    locate_by_text,
    locate_by_bookmark,
    locate_by_heading_level,
    locate_table_cell,
    LocateError,
)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def _local(tag) -> str:
    return etree.QName(tag).localname


class WriterError(Exception):
    """写入失败统一异常。"""


# ============================================================================
# 内部工具
# ============================================================================
def _first_text_run(p_elem):
    """返回段落内第一个含 <w:t> 的 <w:r>；无则 None。"""
    for r in p_elem.findall(_w("r")):
        if r.findall(_w("t")):
            return r
    return None


def _last_text_run(p_elem):
    """返回段落内最后一个含 <w:t> 的 <w:r>；无则 None。"""
    runs = [r for r in p_elem.findall(_w("r")) if r.findall(_w("t"))]
    return runs[-1] if runs else None


def _make_run_with_rpr(rpr_template, text: str):
    """
    构造一个 <w:r>，其 rPr = rpr_template 的 deepcopy（可为 None），文本 = text。
    rPr 必须是 run 的第一个子元素（OOXML 顺序要求）。
    <w:t> 带 xml:space="preserve" 防止首尾空格丢失。
    """
    r = etree.SubElement(etree.Element(_w("r_dummy")), _w("r"))  # 临时父，取回 r
    r = r.getparent().makeelement(_w("r"), {})
    if rpr_template is not None:
        r.append(deepcopy(rpr_template))
    t = r.makeelement(_w("t"), {qn("xml:space"): "preserve"})
    t.text = text
    r.append(t)
    return r


# run_props 支持的 key -> 对应 rPr 子元素本地名
_RUN_PROPS_MAP = {
    "underline": "u",
    "bold": "b",
    "italic": "i",
    "strike": "strike",
    "color": "color",
}


def _apply_run_props(rpr, run_props: dict | None):
    """
    在已有 rPr 元素上按 run_props 增删子元素（就地修改，返回 rpr）。

    参数：
        rpr: <w:rPr> 元素（可为 None，此时若无 run_props 返回 None；
             若有 run_props 则新建一个空 rPr）
        run_props: 样式字典，支持 key：
            underline(bool) -> <w:u w:val="single"/> / 删除
            bold(bool)      -> <w:b/> / 删除
            italic(bool)    -> <w:i/> / 删除
            strike(bool)    -> <w:strike/> / 删除
            color(hex str 如 "EE0000") -> <w:color w:val="EE0000"/> / 删除

    依据说明：
        OOXML 规范要求 rPr 子元素有顺序（rFonts→b→i→u→strike→color→sz…）。
        本库既有做法是「deepcopy 已有 rPr 模板」规避顺序问题，新增的开关元素
        append 到 rPr 末尾（Word 容忍乱序，且本库既已如此）。此处沿用该约定。
    样式保护说明：
        只对 run_props 中显式出现的 key 操作；未出现的 key 不触碰 rPr 已有子元素，
        避免破坏继承自模板的样式。
    边界说明：
        - run_props=None 或空字典 -> 直接返回 rpr，不改。
        - bool 值为 True 时新增（若已存在则更新 val），False 时删除该子元素。
        - color 传字符串即视为启用（设 val）；传 False/None 删除。
    """
    if not run_props:
        return rpr
    if rpr is None:
        rpr = etree.Element(_w("rPr"))
    for key, local in _RUN_PROPS_MAP.items():
        if key not in run_props:
            continue
        val = run_props[key]
        existing = rpr.find(_w(local))
        if local == "color":
            # color 需要 w:val
            if isinstance(val, str):
                if existing is None:
                    existing = etree.SubElement(rpr, _w(local))
                existing.set(_w("val"), val)
            else:
                # False/None -> 删除
                if existing is not None:
                    rpr.remove(existing)
        elif local == "u":
            if val:
                if existing is None:
                    existing = etree.SubElement(rpr, _w(local))
                existing.set(_w("val"), "single")
            else:
                if existing is not None:
                    rpr.remove(existing)
        else:
            # 开关元素：b / i / strike
            if val:
                if existing is None:
                    etree.SubElement(rpr, _w(local))
            else:
                if existing is not None:
                    rpr.remove(existing)
    return rpr


def _make_value_run(rpr_template, text: str, run_props: dict | None):
    """
    构造一个带样式的「值 run」：rPr 先 deepcopy 模板，再叠加 run_props。
    rPr 必须是 <w:r> 第一个子元素。复用 _make_run_with_rpr + _apply_run_props。
    """
    rpr = deepcopy(rpr_template) if rpr_template is not None else None
    rpr = _apply_run_props(rpr, run_props)
    return _make_run_with_rpr(rpr, text)


def _insert_paragraph_after(anchor_p, new_p):
    """
    把 new_p 插到 anchor_p 之后。
    若 anchor_p 之后紧跟的是 <w:sectPr>（body 末尾），仍插在 sectPr 之前
    （addnext 会自然插到 anchor_p 与下一兄弟之间，sectPr 不会被越过）。
    """
    anchor_p.addnext(new_p)


def _resolve_anchor(doc, anchor) -> Any:
    """
    把多种锚点形式统一解析为 <w:p> 元素。
    anchor 可为：
      - dict（locator 返回的结果，含 'p_elem'）
      - int（段落索引）
      - <w:p> 元素本身
    """
    if isinstance(anchor, dict):
        return anchor["p_elem"]
    if isinstance(anchor, int):
        return locate_by_paragraph_index(doc, anchor)["p_elem"]
    # 假定是 <w:p> 元素
    if _local(anchor.tag) == "p":
        return anchor
    raise WriterError(f"无法识别的 anchor 类型: {type(anchor)}")


# ============================================================================
# 公共函数 1：insert_paragraph_after
# ============================================================================
def insert_paragraph_after(doc, anchor, text: str = "",
                           inherit_style: bool = True,
                           run_props: dict | None = None) -> dict:
    """
    在锚点段落之后插入一个新段落。

    参数：
        doc: Document 对象
        anchor: 锚点，可为 locator 返回的 dict / 段落索引(int) / <w:p> 元素
        text: 新段落的文本（可为空串，表示插入空段落）
        inherit_style: True=新段落继承锚点段落的 pPr 与 run 的 rPr
                       （deepcopy，保证样式与锚点一致）；
                       False=新段落无 pPr、run 无 rPr（走文档默认样式）
        run_props: 可选，对新 run 叠加样式（语义同 replace_placeholder 的 run_props）。
                   None（默认）时行为不变，向后兼容。仅在有 text 时生效。

    返回：
        {
          "doc": doc,
          "new_p": <新 <w:p> 元素>,
          "anchor_paragraph_index": int,  # 锚点段落索引（若可推断）
          "new_paragraph_index": int,     # 新段落在 body 中的索引
          "locator": "insert_paragraph_after",
          "inherit_style": bool,
          "changes": [  # 供 verifier 使用的改动元信息
            {"paragraph": <新段落索引>, "path": None, "note": "新增段落"}
          ]
        }

    依据说明：
        新段落 <w:p> 的 pPr = deepcopy(锚点 pPr)（inherit_style=True 时），
        新 run 的 rPr = deepcopy(锚点段落首个有文本 run 的 rPr)。
        依据：base.docx 段落7 的样式同时存在于 pPr/rPr（段落标记）与 run/rPr，
        要让新段落视觉与锚点一致，两者都要继承。
    样式保护说明：
        - pPr 与 rPr 均用 deepcopy 复制，不手工构造，避免漏属性或写错顺序。
        - 仅复制 rPr 节点本身，不复制 run 内的 lastRenderedPageBreak/bookmarkEnd 等。
        - inherit_style=False 时新段落不带任何样式信息，走 Normal 默认，不污染锚点。
    边界说明：
        - text="" -> 插入空段落（合法，仅含 pPr，无 run）。
        - 锚点为 body 最后一个段落（其后是 sectPr）-> 新段落插到 sectPr 之前，
          结构正确（_insert_paragraph_after 用 addnext，自然落在 sectPr 前）。
        - anchor 无法识别 -> 抛 WriterError。
        - 锚点段落无 pPr 且无文本 run（纯空段落）-> inherit_style=True 时新段落
          也不带样式（与锚点一致），符合预期。
    """
    anchor_p = _resolve_anchor(doc, anchor)

    # 构造新 <w:p>
    new_p = anchor_p.makeelement(_w("p"), {})

    if inherit_style:
        src_ppr = anchor_p.find(_w("pPr"))
        if src_ppr is not None:
            new_p.append(deepcopy(src_ppr))
        # 文本 run 的 rPr：取锚点首个有文本 run 的 rPr
        src_run = _first_text_run(anchor_p)
        rpr_template = src_run.find(_w("rPr")) if src_run is not None else None
    else:
        rpr_template = None

    if text:
        new_r = _make_value_run(rpr_template, text, run_props)
        new_p.append(new_r)

    _insert_paragraph_after(anchor_p, new_p)

    # 推断索引（用于 changes 元信息）
    body = doc.element.body
    new_idx = None
    anchor_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is new_p:
                new_idx = p_counter
            if c is anchor_p:
                anchor_idx = p_counter
            p_counter += 1

    return {
        "doc": doc,
        "new_p": new_p,
        "anchor_paragraph_index": anchor_idx,
        "new_paragraph_index": new_idx,
        "locator": "insert_paragraph_after",
        "inherit_style": inherit_style,
        "changes": [
            {"paragraph": new_idx, "path": None, "note": "新增段落（继承样式）"
             if inherit_style else "新增段落（默认样式）"}
        ],
    }


# ============================================================================
# 公共函数 2：append_text_to_paragraph
# ============================================================================
def append_text_to_paragraph(doc, anchor, text: str,
                             inherit_style: bool = True,
                             run_props: dict | None = None) -> dict:
    """
    在锚点段落末尾追加文本（新增一个 run）。

    参数：
        anchor: 同 insert_paragraph_after
        text: 要追加的文本
        inherit_style: True=新 run 的 rPr 继承段落最后一个有文本 run 的 rPr；
                       False=新 run 无 rPr
        run_props: 可选，对新 run 叠加样式（语义同 replace_placeholder 的 run_props）。
                   None（默认）时行为不变，向后兼容。

    返回：
        {
          "doc": doc,
          "paragraph_index": int,
          "new_run": <新 <w:r> 元素>,
          "locator": "append_text_to_paragraph",
          "changes": [{"paragraph": idx, "path": "runs[N].rPr", "note": ...}]
        }

    依据说明：
        新 run 的 rPr = deepcopy(段落最后一个有文本 run 的 rPr)。
        依据：base.docx 段落9「宋体四号下划线」由两个 run 组成，两 run 的 rPr
        均含下划线属性；追加文本时继承最后一个 run 的 rPr 可保持视觉连续。
    样式保护说明：
        - 只 deepcopy rPr，不触碰段落已有 run、不改动 pPr。
        - 新 run 追加到段落末尾（所有现有 run 之后、非 run 元素如 bookmarkEnd 之前
          不强制处理，追加在最末，Word 仍可正常渲染）。
    边界说明：
        - text="" -> 抛 WriterError（空文本无需追加 run）。
        - 段落无任何有文本 run（空段落）-> inherit_style=True 时新 run 无 rPr
          （无模板可继承），等价 False；仍正常追加。
        - 段落末尾是 <w:bookmarkEnd> 等元素 -> 新 run 追加到段落最末，
          位于 bookmarkEnd 之后。这在 OOXML 中合法，但可能影响书签范围；
          若需精确控制书签内追加，建议改用更细粒度接口（待后续扩展）。
    """
    if not text:
        raise WriterError("text 不能为空")
    anchor_p = _resolve_anchor(doc, anchor)

    if inherit_style:
        last_run = _last_text_run(anchor_p)
        rpr_template = last_run.find(_w("rPr")) if last_run is not None else None
    else:
        rpr_template = None

    new_r = _make_value_run(rpr_template, text, run_props)
    anchor_p.append(new_r)

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1

    # 新 run 在段落中的位置
    run_idx = len(anchor_p.findall(_w("r"))) - 1

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "new_run": new_r,
        "run_index": run_idx,
        "locator": "append_text_to_paragraph",
        "changes": [
            {"paragraph": p_idx, "path": f"runs[{run_idx}]",
             "note": "追加文本 run（继承样式）" if inherit_style
             else "追加文本 run（默认样式）"}
        ],
    }


# ============================================================================
# 公共函数 3：insert_text_at_anchor（便捷封装）
# ============================================================================
def insert_text_at_anchor(doc, anchor_text: str, new_text: str,
                          occurrence: int = 1, mode: str = "after_paragraph",
                          inherit_style: bool = True,
                          run_props: dict | None = None) -> dict:
    """
    按文本锚点插入新文本。便捷封装：先用 locate_by_text 定位，再调用
    insert_paragraph_after 或 append_text_to_paragraph。

    参数：
        anchor_text: 用于定位的文本
        new_text: 要写入的文本
        occurrence: 第几次匹配
        mode: "after_paragraph"=在锚点段落后插入新段落；
              "append_to_paragraph"=追加到锚点段落末尾
        inherit_style: 是否继承锚点样式
        run_props: 可选，对新 run 叠加样式（语义同 replace_placeholder 的 run_props）。
                   None（默认）时行为不变，向后兼容。

    返回：底层函数的返回结果（含 doc 与 changes）。

    依据说明：
        复用 locator.locate_by_text（已处理多 run 文本拼接）。
    样式保护说明：
        样式继承逻辑同底层函数。
    边界说明：
        - anchor_text 找不到 -> 抛 LocateError（由 locator 抛出）。
        - mode 非法 -> 抛 WriterError。
        - new_text="" 且 mode="append_to_paragraph" -> 抛 WriterError。
    """
    loc = locate_by_text(doc, anchor_text, occurrence=occurrence)
    if mode == "after_paragraph":
        return insert_paragraph_after(doc, loc, new_text, inherit_style,
                                      run_props=run_props)
    elif mode == "append_to_paragraph":
        return append_text_to_paragraph(doc, loc, new_text, inherit_style,
                                        run_props=run_props)
    else:
        raise WriterError(f"未知 mode: {mode}（应为 after_paragraph/append_to_paragraph）")


# ============================================================================
# 公共函数 4：replace_placeholder（占位符就地替换）
# ============================================================================
def replace_placeholder(doc, anchor, pattern, value,
                        run_props: dict | None = None,
                        occurrence: int = 1) -> dict:
    """
    在锚点段落内，把**首个**（或第 occurrence 个）匹配 pattern 的占位符片段
    就地替换为 value，保留占位符 run 的 rPr（可叠加 run_props 样式）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义（dict / int / <w:p>）
        pattern: re.Pattern 或 str（str 自动 re.compile）。匹配的是**单个 run 内
                 拼接后的文本**（不跨 run）。
        value: 替换文本
        run_props: 可选样式，作用于「值 run」。复用占位符 run 的 rPr 作 deepcopy 模板，
                   再按 run_props 增删对应子元素（见 _apply_run_props）。支持 key：
                   underline(bool)/bold(bool)/italic(bool)/color(hex str)/strike(bool)。
        occurrence: 第几个匹配的 run（1 基，按段落内 run 顺序），默认 1。

    返回：
        {
          "doc": doc,
          "paragraph_index": int,         # 锚点段落在 body 中的索引
          "replaced_run_index": int,      # 被替换（原占位符）run 在段落中的索引
          "value_run_index": int,         # 新值 run 插入后的索引
          "locator": "replace_placeholder",
          "changes": [  # 供 verifier 用
            {"paragraph": idx, "path": f"runs[{..}]", "note": "占位符就地替换"}
          ]
        }

    依据说明：
        表单行的占位符（如 `________`）通常独占一个 run，或与后缀文本同处一个 run
        （如 `________ (签字或盖章)` 的 `________ (`）。本函数在**单个 run 内**用
        正则定位占位符，把该 run 拆成「前缀 run（可选）→ 值 run → 后缀 run（可选）」，
        值 run 带 run_props，前后缀 run 沿用原 rPr 不叠加 run_props。
        run 插入顺序：用 lxml anchor.addnext **正序**插入并顺移 anchor
        （anchor.addnext(before_run); anchor = before_run; anchor.addnext(value_run); ...），
        得到 before→value→after，避免逆序 addnext 导致 run 顺序反。
        新 run 均插入为段落 <w:p> 的直接子级（addnext 天然如此），绝不嵌套进父 <w:r>。
    样式保护说明：
        - 值 run 的 rPr = deepcopy(占位符 run 的 rPr) + run_props 叠加，保字体/字号/颜色。
        - 前缀/后缀 run 的 rPr = deepcopy(占位符 run 的 rPr)，不叠加 run_props。
        - 不改 pPr、不改段落其它 run。
        - rPr 始终是 <w:r> 第一个子元素（由 _make_run_with_rpr 保证）。
    边界说明：
        - **未命中任何占位符 -> 抛 WriterError（不静默跳过）**，把「静默填错」变「当场失败」。
        - pattern 为 str -> 自动 re.compile。
        - 占位符匹配跨多个 run -> 不命中（本函数只匹配单 run 内文本）；此类场景需先
          合并 run 或改用其它原语。
        - value="" -> 抛 WriterError（空值无需替换，删除占位符请用 deleter）。
        - occurrence 超出命中数 -> 抛 WriterError。
    """
    import re as _re

    if not value:
        raise WriterError("value 不能为空（删除占位符请用 deleter）")
    if isinstance(pattern, str):
        pattern = _re.compile(pattern)
    if occurrence < 1:
        raise WriterError(f"occurrence 必须 ≥1，实得 {occurrence}")

    anchor_p = _resolve_anchor(doc, anchor)

    # 在段落 run 中找第 occurrence 个匹配 pattern 的 run
    runs = anchor_p.findall(_w("r"))
    hit_run = None
    hit_match = None
    hit_run_index = None
    seen = 0
    for ri, r in enumerate(runs):
        rtext = "".join((t.text or "") for t in r.findall(_w("t")))
        m = pattern.search(rtext)
        if m:
            seen += 1
            if seen == occurrence:
                hit_run = r
                hit_match = m
                hit_run_index = ri
                break
    if hit_run is None:
        raise WriterError(
            f"未在锚点段落找到匹配 {pattern.pattern!r} 的占位符"
            f"（occurrence={occurrence}，命中 {seen} 个）")

    rpr_template = hit_run.find(_w("rPr"))
    before_text = hit_match.string[:hit_match.start()]
    after_text = hit_match.string[hit_match.end():]

    # 正序插入：before → value → after，顺移 anchor
    anchor_node = hit_run
    if before_text:
        before_run = _make_run_with_rpr(rpr_template, before_text)  # 前缀沿用原 rPr
        anchor_node.addnext(before_run)
        anchor_node = before_run

    value_run = _make_value_run(rpr_template, value, run_props)
    anchor_node.addnext(value_run)
    anchor_node = value_run
    value_run_index = list(anchor_p).index(value_run)

    if after_text:
        after_run = _make_run_with_rpr(rpr_template, after_text)  # 后缀沿用原 rPr
        anchor_node.addnext(after_run)

    # 删除原占位符 run
    anchor_p.remove(hit_run)

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "replaced_run_index": hit_run_index,
        "value_run_index": value_run_index,
        "locator": "replace_placeholder",
        "changes": [
            {"paragraph": p_idx, "path": f"runs[{value_run_index}]",
             "note": f"占位符就地替换为 {value!r}"}
        ],
    }


# ============================================================================
# 公共函数 5：fill_date_slots（空白占位 slot 填写，如日期行）
# ============================================================================
def fill_date_slots(doc, anchor, markers: list[str], values: list[str],
                    run_props: dict | None = None) -> dict:
    """
    针对 `日期：2025年  月  日` 这类「年/月/日之间用空白 run 占位」的行。

    定位锚点段落，找到文本 strip 后等于给定 markers（如 ["年","月"]）的 run，
    取其**紧邻下一个兄弟 run**，若该 run 文本 strip 后为空（即空白占位 slot），
    则删除它并在 marker run 后 addnext 一个值 run（带 run_props，默认下划线）。
    markers 与 values 按位置对应。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义
        markers: marker run 的文本（strip 后精确等值），如 ["年","月"]
        values: 对应的填写值，如 ["2","9"]，与 markers 等长
        run_props: 值 run 样式（语义同 replace_placeholder）。None 时默认
                   {"underline": True}（日期填写项惯例加下划线）。

    返回：
        {
          "doc": doc,
          "paragraph_index": int,
          "filled": [{"marker": str, "value": str, "value_run_index": int}, ...],
          "locator": "fill_date_slots",
          "changes": [...]
        }

    依据说明：
        `日期：2025年  月  日` 的「年」「月」run 后各跟一个空白 run（`  `）作月/日占位。
        末尾追加整串日期会重复（`…日2025年2月9日`）。正确做法：删掉 marker 后的空白
        slot run，再 addnext 值 run。年份 2025 保留不动。
        值 run 的 rPr = deepcopy(marker run 的 rPr) + run_props，保字体字号一致。
    样式保护说明：
        - 只删 marker 后紧邻的空白 slot run，不动其它 run、不改 pPr。
        - 值 run rPr 沿用 marker run 模板 + run_props 叠加。
    边界说明：
        - markers 与 values 长度不等 -> 抛 WriterError。
        - marker run 找不到 -> 抛 WriterError。
        - marker 后紧邻兄弟不是 <w:r> -> 抛 WriterError（无法定位 slot）。
        - slot run 文本 strip 后非空（已被填写）-> 抛 WriterError（避免误覆盖）。
        - run_props=None 时默认下划线；显式传 {} 则不加任何样式。
    """
    if len(markers) != len(values):
        raise WriterError(f"markers 与 values 长度不等: {len(markers)} vs {len(values)}")
    if run_props is None:
        run_props = {"underline": True}

    anchor_p = _resolve_anchor(doc, anchor)
    runs = anchor_p.findall(_w("r"))

    filled = []
    changes = []
    for marker, value in zip(markers, values):
        # 找文本 strip 后 == marker 的 run
        target_run = None
        for r in runs:
            rtext = "".join((t.text or "") for t in r.findall(_w("t")))
            if rtext.strip() == marker:
                target_run = r
                break
        if target_run is None:
            raise WriterError(f"未找到 marker run: {marker!r}")

        # 紧邻下一个兄弟 run
        next_sib = target_run.getnext()
        if next_sib is None or _local(next_sib.tag) != "r":
            raise WriterError(
                f"marker {marker!r} 后紧邻兄弟不是 <w:r>（无法定位空白 slot）")
        slot_text = "".join((t.text or "") for t in next_sib.findall(_w("t")))
        if slot_text.strip() != "":
            raise WriterError(
                f"marker {marker!r} 后 slot 非空（已填 {slot_text!r}），拒绝覆盖")

        rpr_template = target_run.find(_w("rPr"))
        value_run = _make_value_run(rpr_template, value, run_props)
        # 删 slot，marker 后插值 run
        anchor_p.remove(next_sib)
        target_run.addnext(value_run)
        # 同步 runs 视图（已删除/插入）
        runs = anchor_p.findall(_w("r"))
        vri = list(anchor_p).index(value_run)
        filled.append({"marker": marker, "value": value,
                       "value_run_index": vri})
        changes.append({"paragraph": None, "path": f"runs[{vri}]",
                        "note": f"日期 slot 填写: {marker} -> {value!r}"})

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1
    for ch in changes:
        ch["paragraph"] = p_idx

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "filled": filled,
        "locator": "fill_date_slots",
        "changes": changes,
    }


# ============================================================================
# 公共函数 6：insert_table_row（新增表格行）
# ============================================================================
def insert_table_row(doc, table_index: int, after_row: int,
                     template_row: int | None = None) -> dict:
    """
    在表格指定行之后新增一行，样式继承自模板行。

    参数：
        table_index: body 内 <w:tbl> 的顺序索引
        after_row: 新行插入到此行之后（0 基）。传 -1 表示插到表格最前。
        template_row: 作为样式模板的行索引；None=用 after_row 自身作模板。

    返回：
        {
          "doc": doc,
          "table_index": int,
          "new_row_index": int,         # 新行在表格中的索引
          "template_row": int,
          "locator": "insert_table_row",
          "changes": [{"paragraph": None, "path": f"tbl[{ti}].tr[{ni}]", "note": "新增行"}]
        }

    依据说明：
        deepcopy 模板 <w:tr>（含所有 <w:tc> 的 tcPr 与段落 pPr/rPr），
        清空各单元格文本（保留一个空段落 + 样式），插入到 after_row 之后。
        依据：base.docx 的 tr = tc×4，tc = tcPr + p，deepcopy 保结构最可靠。
    样式保护说明：
        - 整行 deepcopy，tcPr（单元格宽度/边框）与段落 pPr/rPr 全保留。
        - 清空文本时只删 <w:r>，保留 <w:p> 与其 pPr（复用 deleter 思路）。
        - 不修改其它行、不改 tblPr/tblGrid。
    边界说明：
        - table_index / after_row / template_row 越界 -> 抛 LocateError/WriterError。
        - after_row=-1 -> 新行插到表格首行之前。
        - 新行单元格为空（文本被清空），调用方可后续用 set_table_cell_text 填内容。
        - 表格列数由 deepcopy 决定，与模板行一致（不处理合并单元格场景）。
    """
    body = doc.element.body
    tables = [c for c in body if _local(c.tag) == "tbl"]
    if table_index < 0 or table_index >= len(tables):
        raise WriterError(f"表格索引越界: {table_index}（共 {len(tables)} 表）")
    tbl = tables[table_index]
    rows = tbl.findall(_w("tr"))
    if template_row is None:
        template_row = after_row if after_row >= 0 else 0
    if template_row < 0 or template_row >= len(rows):
        raise WriterError(f"模板行索引越界: {template_row}（共 {len(rows)} 行）")

    # deepcopy 模板行
    new_tr = deepcopy(rows[template_row])
    # 清空各单元格文本（保留 tcPr 与一个空段落）
    for tc in new_tr.findall(_w("tc")):
        ps = tc.findall(_w("p"))
        # 保留第一个 p（含其 pPr），删其余
        for p in ps[1:]:
            tc.remove(p)
        if ps:
            for r in list(ps[0].findall(_w("r"))):
                ps[0].remove(r)

    # 插入位置
    if after_row < 0:
        # 插到表格最前（tblPr/tblGrid 之后）
        first_tr = tbl.find(_w("tr"))
        if first_tr is not None:
            first_tr.addprevious(new_tr)
        else:
            tbl.append(new_tr)
        new_row_index = 0
    else:
        if after_row >= len(rows):
            raise WriterError(f"after_row 越界: {after_row}（共 {len(rows)} 行）")
        rows[after_row].addnext(new_tr)
        new_row_index = after_row + 1

    return {
        "doc": doc,
        "table_index": table_index,
        "new_row_index": new_row_index,
        "template_row": template_row,
        "locator": "insert_table_row",
        "changes": [
            {"paragraph": None, "path": f"tbl[{table_index}].tr[{new_row_index}]",
             "note": f"新增行（模板=tr[{template_row}]，文本已清空）"}
        ],
    }


# ============================================================================
# 公共函数 7：set_table_cell_text（单元格内容写入）
# ============================================================================
def set_table_cell_text(doc, table_index: int, row: int, col: int,
                        text: str, mode: str = "replace",
                        inherit_style: bool = True) -> dict:
    """
    向表格单元格写入文本。

    参数：
        table_index/row/col: 表格坐标
        text: 要写入的文本
        mode: "replace"=先清空单元格文本再写入（默认）；
              "append"=在单元格首个段落末尾追加
        inherit_style: True=新 run 的 rPr 继承单元格首个有文本 run 的 rPr；
                       False=新 run 无 rPr

    返回：
        {
          "doc": doc, "table_index": int, "row": int, "col": int,
          "locator": "set_table_cell_text",
          "changes": [{"paragraph": None, "path": f"tbl[..].tc[..]", "note": ...}]
        }

    依据说明：
        单元格 <w:tc> 内 <w:p> 的结构同正文段落（pPr + r/rPr/t）。
        复用 writer 内部 _make_run_with_rpr 构造带样式 run。
        依据：base.docx tc0 单元格段落 pPr/rPr 真实存在。
    样式保护说明：
        - replace 模式：清空单元格 run（保留 pPr 与空段落），再追加新 run。
        - append 模式：不动已有 run，在首个段落末尾追加。
        - 新 run 的 rPr deepcopy 单元格首个有文本 run 的 rPr（inherit_style=True）。
        - 不修改 tcPr、不修改其它单元格。
    边界说明：
        - 坐标越界 -> 抛 LocateError。
        - text="" -> 抛 WriterError（空文本无需写入，清空请用 deleter.clear_table_cell）。
        - 单元格无段落（异常情况）-> 自动补一个空 <w:p> 再写入。
        - 单元格无有文本 run（空单元格）-> inherit_style=True 时新 run 无 rPr（无模板）。
    """
    if not text:
        raise WriterError("text 不能为空（清空请用 deleter.clear_table_cell）")
    loc = locate_table_cell(doc, table_index, row, col)
    tc = loc["tc_elem"]
    ps = tc.findall(_w("p"))
    if not ps:
        # 异常：单元格无段落，补一个
        new_p = tc.makeelement(_w("p"), {})
        tc.append(new_p)
        ps = [new_p]
    target_p = ps[0]

    if mode == "replace":
        # 清空首个段落 run，保留 pPr
        for r in list(target_p.findall(_w("r"))):
            target_p.remove(r)
    elif mode != "append":
        raise WriterError(f"未知 mode: {mode}（应为 replace/append）")

    # 取 rPr 模板：单元格首个有文本 run 的 rPr
    rpr_template = None
    if inherit_style:
        for p in ps:
            for r in p.findall(_w("r")):
                if r.findall(_w("t")):
                    rpr_template = r.find(_w("rPr"))
                    break
            if rpr_template is not None:
                break

    new_r = _make_run_with_rpr(rpr_template, text)
    target_p.append(new_r)

    return {
        "doc": doc,
        "table_index": table_index, "row": row, "col": col,
        "locator": "set_table_cell_text",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{table_index}].tr[{row}].tc[{col}]",
             "note": f"单元格写入文本（mode={mode}，文本={text!r}）"}
        ],
    }


# ============================================================================
# 公共函数 8：replace_all_placeholders（语义层：同段所有占位符一次性替换）
# ============================================================================
def replace_all_placeholders(doc, anchor, pattern, values,
                             run_props: dict | None = None) -> dict:
    """
    同段内所有匹配 pattern 的占位符，按出现顺序一次性替换为 values 列表（语义层）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义（dict / int / <w:p>）
        pattern: re.Pattern 或 str（str 自动 re.compile）。匹配单个 run 内
                 拼接后的文本（不跨 run，同 replace_placeholder）。
        values: 替换值列表，按段落内 run 顺序、每个 run 内 match 顺序对应。
        run_props: 可选样式，作用于每个值 run（语义同 replace_placeholder）。

    返回：
        {doc, paragraph_index, replaced:[{rank, replaced_run_index,
         value_run_index, value}], locator:"replace_all_placeholders",
         changes:[...]}

    依据说明：
        多占位符同段（如 `姓名：___性别：___年龄：___职务：___`）若用 occurrence
        逐个替换，每次替换会拆 run 导致后续 occurrence 的 run 索引漂移。本函数
        先一遍扫描记录所有命中（按段落内 run 顺序、每个 run 内 match 顺序），
        收集 (run, match_span, rank)；再从后往前统一替换避免 span 失效。每个
        占位符走与 replace_placeholder 相同的「前缀→值→后缀」三段拆分逻辑。
    样式保护说明：
        - 值 run 的 rPr = deepcopy(占位符 run 的 rPr) + run_props 叠加。
        - 前缀/后缀 run 的 rPr = deepcopy(占位符 run 的 rPr)，不叠加 run_props。
        - 不改 pPr、不改段落其它 run。
    边界说明：
        - 命中 0 抛 WriterError（不静默）。
        - values 长度必须 == 命中数，否则抛 WriterError（明确告知「命中 N 个，传 M 个值」）。
        - 任一 value=="" 抛 WriterError。
        - pattern 为 str 自动 re.compile。
        - 跨 run 的占位符不命中（同 replace_placeholder）。
    """
    import re as _re

    if isinstance(pattern, str):
        pattern = _re.compile(pattern)
    if not values:
        raise WriterError("values 不能为空 list")
    if any((v is None or v == "") for v in values):
        raise WriterError("values 中含空串（空值无需替换，删除占位符请用 deleter）")

    anchor_p = _resolve_anchor(doc, anchor)

    # 第一遍扫描：按 run 分组记录命中
    # hits: [{run, run_index, matches:[(match_obj, global_rank)]}]
    hits_by_run = []
    global_rank = 0
    for ri, r in enumerate(anchor_p.findall(_w("r"))):
        rtext = "".join((t.text or "") for t in r.findall(_w("t")))
        run_matches = []
        for m in pattern.finditer(rtext):
            run_matches.append((m, global_rank))
            global_rank += 1
        if run_matches:
            hits_by_run.append({"run": r, "run_index": ri,
                                "matches": run_matches})
    total_hits = global_rank
    if total_hits == 0:
        raise WriterError(
            f"未在锚点段落找到匹配 {pattern.pattern!r} 的占位符（命中 0 个）")
    if len(values) != total_hits:
        raise WriterError(
            f"命中 {total_hits} 个占位符，但传入 {len(values)} 个值（必须等长）")

    # 从后往前处理每个 run（addnext 保证新 run 插在该 run 之后）。
    # 同一 run 内多个匹配：按匹配顺序把 rtext 切成片段序列
    # [前缀, match1, 间隔, match2, ..., 后缀]，每个 match 用对应 value，
    # 前缀/间隔/后缀沿用原 rPr。
    replaced = []
    changes = []
    for h in reversed(hits_by_run):
        hit_run = h["run"]
        rpr_template = hit_run.find(_w("rPr"))
        # 取该 run 的 rtext（与扫描时一致）
        rtext = "".join((t.text or "") for t in hit_run.findall(_w("t")))
        # 构造片段列表：[(text, is_value, rank_if_value)]
        segments = []
        last_end = 0
        for m, rank in h["matches"]:
            if m.start() > last_end:
                segments.append((rtext[last_end:m.start()], False, None))
            segments.append((values[rank], True, rank))
            last_end = m.end()
        if last_end < len(rtext):
            segments.append((rtext[last_end:], False, None))

        # 正序插入新 run（before 顺序：hit_run.addnext 会插到 hit_run 之后，
        # 再顺移 anchor_node，得到正确顺序）
        anchor_node = hit_run
        run_value_indices = []
        for text_seg, is_value, rank in segments:
            if is_value:
                new_r = _make_value_run(rpr_template, text_seg, run_props)
            else:
                new_r = _make_run_with_rpr(rpr_template, text_seg)
            anchor_node.addnext(new_r)
            anchor_node = new_r
            if is_value:
                vri = list(anchor_p).index(new_r)
                run_value_indices.append((rank, vri, text_seg))

        # 删除原占位符 run
        anchor_p.remove(hit_run)
        for rank, vri, val in run_value_indices:
            replaced.append({"rank": rank + 1,
                             "replaced_run_index": h["run_index"],
                             "value_run_index": vri,
                             "value": val})
            changes.append({"paragraph": None, "path": f"runs[{vri}]",
                            "note": f"占位符 #{rank+1} 替换为 {val!r}"})

    # 按 rank 升序排列（便于阅读）
    replaced.sort(key=lambda x: x["rank"])
    changes.sort(key=lambda x: int(x["note"].split("#")[1].split(" ")[0]))

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1
    for ch in changes:
        ch["paragraph"] = p_idx

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "replaced": replaced,
        "locator": "replace_all_placeholders",
        "changes": changes,
    }


# ============================================================================
# 公共函数 9：set_paragraph_text（语义层：整段替换文本）
# ============================================================================
def set_paragraph_text(doc, anchor, text, inherit_style=True,
                       run_props: dict | None = None) -> dict:
    """
    整段替换文本为 text，保留首个有 rPr 的 run 作模板（语义层）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义
        text: 新文本。"" 时清空段落全部 run（保留 pPr），返回 run_index=None，不抛。
        inherit_style: True=用首个有 rPr 的 run 作 rPr 模板；False=无 rPr。
        run_props: 可选，对新 run 叠加样式（语义同 replace_placeholder）。

    返回：
        {doc, paragraph_index, run_index, locator:"set_paragraph_text", changes:[...]}

    依据说明：
        删段落内所有 <w:r> 与 <w:hyperlink>（保留 pPr 与 bookmarkStart/End），
        用模板 rPr 构造单个值 run。保留 bookmark 是因为书签范围不应因文本替换而
        丢失（bookmarkStart/End 是 <w:p> 的子元素，与 run 同级）。
    样式保护说明：
        - pPr 不动；run 的 rPr 来自首个有 rPr 的 run（inherit_style=True）或无（False）。
        - bookmarkStart/bookmarkEnd 等非 run/hyperlink 子元素保留。
        - 段落无 run 无 rPr 模板时，inherit_style=True 也无样式（等价 False）。
    边界说明：
        - text="" -> 清空段落全部 run（保留 pPr），返回 run_index=None，不抛
          （区别于 append 的空值抛错）。
        - 段落无 run 无 rPr 模板时，inherit_style=True 也无样式。
        - 保留段落 pPr 不动。
    """
    anchor_p = _resolve_anchor(doc, anchor)

    # 取 rPr 模板：首个有 rPr 的 run（inherit_style=True 时）
    rpr_template = None
    if inherit_style:
        for r in anchor_p.findall(_w("r")):
            rpr = r.find(_w("rPr"))
            if rpr is not None and len(rpr) > 0:
                rpr_template = rpr
                break
        if rpr_template is None:
            # 退而求其次：首个有文本 run 的 rPr（可能为空 rPr）
            for r in anchor_p.findall(_w("r")):
                if r.findall(_w("t")):
                    rpr_template = r.find(_w("rPr"))
                    break

    # 删段落内所有 <w:r> 与 <w:hyperlink>（保留 pPr、bookmarkStart/End 等）
    for r in list(anchor_p.findall(_w("r"))):
        anchor_p.remove(r)
    for hl in list(anchor_p.findall(_w("hyperlink"))):
        anchor_p.remove(hl)

    new_run_index = None
    if text:
        new_r = _make_value_run(rpr_template, text, run_props)
        anchor_p.append(new_r)
        new_run_index = list(anchor_p).index(new_r)

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "run_index": new_run_index,
        "locator": "set_paragraph_text",
        "changes": [
            {"paragraph": p_idx, "path": None,
             "note": f"整段文本替换为 {text!r}"}
        ],
    }


# ============================================================================
# 公共函数 10：set_cell_by_label（语义层：标签|值 表格写入）
# ============================================================================
def set_cell_by_label(doc, table_index, label, value, mode="replace",
                      direction="right", inherit_style=True,
                      strip_colon=True, occurrence=1) -> dict:
    """
    在表格中找到文本==label 的单元格，把其指定方向相邻单元格写为 value（语义层）。

    参数：
        doc: Document 对象
        table_index: body 内 <w:tbl> 的顺序索引
        label: 标签文本（strip 后精确等值；strip_colon=True 时去掉末尾「：:」再比较）
        value: 要写入相邻单元格的值
        mode: 传给 set_table_cell_text（"replace"/"append"）
        direction: "right"=右侧相邻 tc（同行下一列）；"below"=下方相邻 tc（同列下一行）
        inherit_style: 传给 set_table_cell_text
        strip_colon: True 时 label 与单元格文本都 rstrip「：:」后比较（默认开）
        occurrence: 第几个匹配的 label 单元格（1 基，默认 1）

    返回：
        {doc, table_index, label_cell:{row,col}, value_cell:{row,col},
         locator:"set_cell_by_label", changes:[...]}

    依据说明：
        专治「标签｜值」合并表（如基本信息表、开票信息表）。label 匹配用 strip 后
        精确等值；值单元格采用 set_table_cell_text 写入（复用其 rPr 继承）。
    样式保护说明：
        - 值单元格走 set_table_cell_text 的样式继承逻辑（inherit_style）。
        - label 单元格不修改。
    边界说明：
        - label 未找到抛 LocateError。
        - 值单元格不存在（label 在行/列末尾）抛 WriterError。
        - value=="" 抛 WriterError（清空用 deleter.clear_table_cell）。
        - occurrence < 1 抛 ValueError。
    """
    if occurrence < 1:
        raise ValueError(f"occurrence 必须 >=1，实得 {occurrence}")
    if not value:
        raise WriterError("value 不能为空（清空请用 deleter.clear_table_cell）")
    if direction not in ("right", "below"):
        raise WriterError(f"未知 direction: {direction}（应为 right/below）")

    def _norm(s: str) -> str:
        s = s.strip()
        if strip_colon:
            s = s.rstrip("：:")
        return s

    label_norm = _norm(label)

    body = doc.element.body
    tables = [c for c in body if _local(c.tag) == "tbl"]
    if table_index < 0 or table_index >= len(tables):
        raise WriterError(f"表格索引越界: {table_index}（共 {len(tables)} 表）")
    tbl = tables[table_index]
    rows = tbl.findall(_w("tr"))

    matches = []
    for ri, r in enumerate(rows):
        cells = r.findall(_w("tc"))
        for ci, tc in enumerate(cells):
            tc_text = " / ".join(
                "".join((t.text or "") for t in p.iter(_w("t")))
                for p in tc.findall(_w("p")))
            if _norm(tc_text) == label_norm:
                matches.append((ri, ci))

    if not matches:
        raise LocateError(f"表格 {table_index} 中未找到 label={label!r} 的单元格")
    if occurrence > len(matches):
        raise LocateError(
            f"occurrence={occurrence} 超出 label 匹配数 {len(matches)}")
    label_row, label_col = matches[occurrence - 1]

    # 确定值单元格坐标
    if direction == "right":
        value_row, value_col = label_row, label_col + 1
        # 检查列是否存在
        label_cells = rows[label_row].findall(_w("tc"))
        if value_col >= len(label_cells):
            raise WriterError(
                f"label 单元格 (row={label_row},col={label_col}) 在行末尾，无右侧相邻单元格")
    else:  # below
        value_row, value_col = label_row + 1, label_col
        if value_row >= len(rows):
            raise WriterError(
                f"label 单元格 (row={label_row},col={label_col}) 在列末尾，无下方相邻单元格")

    # 用 set_table_cell_text 写入
    set_table_cell_text(doc, table_index, value_row, value_col, value,
                        mode=mode, inherit_style=inherit_style)

    return {
        "doc": doc,
        "table_index": table_index,
        "label_cell": {"row": label_row, "col": label_col},
        "value_cell": {"row": value_row, "col": value_col},
        "locator": "set_cell_by_label",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{table_index}].tr[{value_row}].tc[{value_col}]",
             "note": f"按 label {label!r} 写入相邻单元格（direction={direction}，值={value!r}）"}
        ],
    }


# ============================================================================
# 内部工具：表格属性容器 ensure 模式（参考 structure._ensure_ppr）
# ============================================================================
def _ensure_tcpr(tc_elem):
    """取或建单元格 tcPr（建则插到 tc 最前）。返回 tcPr 元素。

    tcPr 必须是 <w:tc> 的第一个子元素（OOXML 顺序）。
    """
    tcPr = tc_elem.find(_w("tcPr"))
    if tcPr is None:
        tcPr = tc_elem.makeelement(_w("tcPr"), {})
        tc_elem.insert(0, tcPr)
    return tcPr


def _ensure_tblpr(tbl_elem):
    """取或建表格 tblPr（建则插到 tbl 最前）。返回 tblPr 元素。

    tblPr 必须是 <w:tbl> 的第一个子元素（OOXML 顺序，在 tblGrid 之前）。
    """
    tblPr = tbl_elem.find(_w("tblPr"))
    if tblPr is None:
        tblPr = tbl_elem.makeelement(_w("tblPr"), {})
        tbl_elem.insert(0, tblPr)
    return tblPr


def _ensure_trpr(tr_elem):
    """取或建行 trPr（建则插到 tr 最前）。返回 trPr 元素。

    trPr 必须是 <w:tr> 的第一个子元素（OOXML 顺序，在所有 tc 之前）。
    """
    trPr = tr_elem.find(_w("trPr"))
    if trPr is None:
        trPr = tr_elem.makeelement(_w("trPr"), {})
        tr_elem.insert(0, trPr)
    return trPr


def _ensure_tblgrid(tbl_elem):
    """取或建 tblGrid。tblGrid 必须紧跟 tblPr 之后（OOXML 顺序）。
    若 tblPr 不存在则先建 tblPr。返回 tblGrid 元素。"""
    tblGrid = tbl_elem.find(_w("tblGrid"))
    if tblGrid is None:
        tblGrid = tbl_elem.makeelement(_w("tblGrid"), {})
        tblPr = _ensure_tblpr(tbl_elem)
        # 插到 tblPr 之后
        tblPr.addnext(tblGrid)
    return tblGrid


def _get_table(doc, table_index):
    """取 body 第 table_index 个 <w:tbl>；越界抛 WriterError。返回 (tbl, table_index)。"""
    body = doc.element.body
    tables = [c for c in body if _local(c.tag) == "tbl"]
    if table_index < 0 or table_index >= len(tables):
        raise WriterError(f"表格索引越界: {table_index}（共 {len(tables)} 表）")
    return tables[table_index]


def _table_col_count(tbl):
    """取表格列数（按 tblGrid 的 gridCol 数；无 tblGrid 则按首行 tc 数）。"""
    tblGrid = tbl.find(_w("tblGrid"))
    if tblGrid is not None:
        cols = tblGrid.findall(_w("gridCol"))
        if cols:
            return len(cols)
    rows = tbl.findall(_w("tr"))
    if rows:
        return len(rows[0].findall(_w("tc")))
    return 0


# ============================================================================
# 公共函数 11：insert_image（P0-5：从磁盘插入图片）
# ============================================================================
def insert_image(doc, anchor, image_path, width=None, height=None,
                 *, inherit_style=True) -> dict:
    """
    从磁盘图片文件插入到锚点段落（inline drawing），支持指定宽高（P0-5）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义（dict / int / <w:p>）
        image_path: 图片文件路径（PNG/JPG 等 python-docx 支持的格式）
        width: python-docx Length（如 Inches(2)）或 None（原图尺寸）
        height: python-docx Length 或 None。二者都给则按比例，给其一则等比缩放。
        inherit_style: True=新 run 的 rPr 继承锚点段首个有文本 run 的 rPr（deepcopy），
                       叠加 noProof（与 base.docx 图片 run 一致）；False=新 run 无 rPr。

    返回：
        {
          "doc": doc, "paragraph_index": int, "image_rid": str,
          "drawing_run_index": int, "width": int|None, "height": int|None,
          "locator": "insert_image", "changes": [...]
        }

    依据说明：
        用 python-docx 内部 doc.part.new_pic_inline(image_path, width, height)
        构造 <wp:inline> 元素（含 blip 引用新 image part），包装进 <w:r> 追加到
        锚点段。new_pic_inline 会自动注册 image part 并分配 rId。
    样式保护说明：
        - 不动锚点段已有 run/pPr，仅追加 drawing run。
        - inherit_style=True 时新 run 的 rPr = deepcopy(锚点段首个有文本 run 的 rPr)
          + noProof（base.docx 图片 run 含 noProof）。
        - inherit_style=False 时新 run 无 rPr。
    边界说明：
        - 图片文件不存在/不支持格式 -> 抛 WriterError（python-docx 抛
          ImageNotFoundError/UnrecognizedImageError，捕获转 WriterError）。
        - 锚点不可识别 -> 抛 WriterError。
    """
    try:
        from docx.image.exceptions import (
            ImageNotFoundError, UnrecognizedImageError,
        )
    except ImportError:
        ImageNotFoundError = UnrecognizedImageError = Exception

    anchor_p = _resolve_anchor(doc, anchor)

    # rPr 模板
    rpr_template = None
    if inherit_style:
        src_run = _first_text_run(anchor_p)
        rpr_template = src_run.find(_w("rPr")) if src_run is not None else None

    try:
        inline = doc.part.new_pic_inline(image_path, width, height)
    except (ImageNotFoundError, UnrecognizedImageError) as e:
        raise WriterError(f"图片文件不可用: {image_path} ({e})")
    except Exception as e:
        # 兜底：其它文件/格式异常也转 WriterError
        raise WriterError(f"插入图片失败: {image_path} ({type(e).__name__}: {e})")

    # 构造 <w:r>，rPr（含 noProof）在前，drawing 在后
    r = anchor_p.makeelement(_w("r"), {})
    if rpr_template is not None:
        r.append(deepcopy(rpr_template))
    # 追加 noProof（确保存在，base.docx 图片 run 有此属性）
    rpr_el = r.find(_w("rPr"))
    if rpr_el is None:
        rpr_el = r.makeelement(_w("rPr"), {})
        r.insert(0, rpr_el)
    if rpr_el.find(_w("noProof")) is None:
        rpr_el.append(rpr_el.makeelement(_w("noProof"), {}))
    # drawing 元素
    drawing = r.makeelement(_w("drawing"), {})
    drawing.append(inline)
    r.append(drawing)
    anchor_p.append(r)

    # 取 image rId（从 inline 的 blip embed）
    image_rid = None
    for b in inline.iter(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"
    ):
        image_rid = b.get(
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"
        )
        break

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1

    run_idx = len(anchor_p.findall(_w("r"))) - 1

    # 取实际宽高（EMU）用于返回
    ext = inline.find(
        "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent"
    )
    cx = int(ext.get("cx")) if ext is not None and ext.get("cx") else None
    cy = int(ext.get("cy")) if ext is not None and ext.get("cy") else None

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "image_rid": image_rid,
        "drawing_run_index": run_idx,
        "width": cx,
        "height": cy,
        "locator": "insert_image",
        "changes": [
            {"paragraph": p_idx, "path": f"runs[{run_idx}].drawing",
             "note": f"插入图片 {image_path!r}（inline drawing）"}
        ],
    }


# ============================================================================
# 公共函数 12：set_table_column_widths（P1-6：表格列宽）
# ============================================================================
def set_table_column_widths(doc, table_index, widths, *, layout="fixed") -> dict:
    """
    设表格各列列宽（tblGrid + 每格 tcW），并可选注入固定布局（P1-6）。

    参数：
        doc: Document 对象
        table_index: body 内 <w:tbl> 的顺序索引
        widths: python-docx Length 列表（dxa），每个元素是一列的宽度
        layout: "fixed" 注入 <w:tblLayout type="fixed"/>；None 不注入。

    返回：
        {doc, table_index, col_count, layout, locator:"set_table_column_widths",
         changes:[...]}

    依据说明：
        设 <w:tblGrid> 的 <w:gridCol w:w=..>（一列一个，dxa）+ 每行每格
        <w:tcPr><w:tcW w:w=.. w:type="dxa"/>。layout="fixed" 时注入
        <w:tblLayout type="fixed"/> 进 tblPr。tblLayout 在 tblPr 子元素顺序中
        位于 tblStyle/tblW/tblInd 之后、tblLook 之前（ECMA-376）。
    样式保护说明：
        - 只追加/改格式子元素（gridCol/tcW/tblLayout），不动单元格文本与已有 run。
        - tblGrid 已有的 gridCol 全部重建（按 widths 数量），保证列数一致。
        - 每个 tcPr 的 tcW 已有则改 w:val，无则新建。
    边界说明：
        - 表格索引越界 -> 抛 WriterError。
        - widths 长度 != 列数 -> 抛 WriterError。
        - widths 为空 -> 抛 WriterError。
    """
    if not widths:
        raise WriterError("widths 不能为空")
    tbl = _get_table(doc, table_index)
    col_count = _table_col_count(tbl)
    if len(widths) != col_count:
        raise WriterError(
            f"widths 长度 {len(widths)} != 表格列数 {col_count}")

    # dxa 值（python-docx Length 转 dxa：1 dxa = 1/20 pt；Length 内部 EMU）
    def _to_dxa(length):
        # Length.int 实现：EMU；1 dxa = 1/20 pt = 635 EMU
        return str(int(length) // 635)

    dxa_vals = [_to_dxa(w) for w in widths]

    # 1) 重建 tblGrid 的 gridCol
    tblGrid = tbl.find(_w("tblGrid"))
    if tblGrid is None:
        tblGrid = tbl.makeelement(_w("tblGrid"), {})
        _ensure_tblpr(tbl).addnext(tblGrid)
    # 删除旧 gridCol，按 widths 新建
    for gc in list(tblGrid.findall(_w("gridCol"))):
        tblGrid.remove(gc)
    for dxa in dxa_vals:
        gc = tblGrid.makeelement(_w("gridCol"), {_w("w"): dxa})
        tblGrid.append(gc)

    # 2) 每行每格设 tcW
    rows = tbl.findall(_w("tr"))
    for tr in rows:
        tcs = tr.findall(_w("tc"))
        for ci, tc in enumerate(tcs):
            if ci >= len(dxa_vals):
                break
            tcPr = _ensure_tcpr(tc)
            tcW = tcPr.find(_w("tcW"))
            if tcW is None:
                tcW = tcPr.makeelement(_w("tcW"), {})
                # tcW 在 tcPr 子元素顺序中靠前（tcW 必须在 shd 之前）
                tcPr.insert(0, tcW)
            tcW.set(_w("w"), dxa_vals[ci])
            tcW.set(_w("type"), "dxa")

    # 3) layout="fixed" 注入 tblLayout
    if layout == "fixed":
        tblPr = _ensure_tblpr(tbl)
        tblLayout = tblPr.find(_w("tblLayout"))
        if tblLayout is None:
            tblLayout = tblPr.makeelement(_w("tblLayout"), {})
            _insert_tblpr_child_in_order(tblPr, tblLayout)
        tblLayout.set(_w("type"), "fixed")

    return {
        "doc": doc,
        "table_index": table_index,
        "col_count": len(widths),
        "layout": layout,
        "locator": "set_table_column_widths",
        "changes": [
            {"paragraph": None, "path": f"tbl[{table_index}].tblGrid/tcPr",
             "note": f"设 {len(widths)} 列宽 + layout={layout}"}
        ],
    }


# tblPr 子元素顺序（ECMA-376，用于正确插入 tblLayout/tblBorders 等）。
# 仅列本库需要插入的子元素相对顺序：
#   tblStyle -> tblpPr -> tblW -> tblInd -> tblBorders -> shd ->
#   tblLayout -> tblCellMar -> tblLook
_TBLPR_ORDER = [
    "tblStyle", "tblpPr", "tblW", "tblInd", "tblBorders", "shd",
    "tblLayout", "tblCellMar", "tblLook",
]


def _insert_tblpr_child_in_order(tblPr, child):
    """把 child 插入 tblPr，保持 OOXML 子元素顺序正确。
    child 的本地名必须在 _TBLPR_ORDER 中；插到第一个顺序更后的元素之前。"""
    child_local = _local(child.tag)
    if child_local not in _TBLPR_ORDER:
        tblPr.append(child)
        return
    child_pos = _TBLPR_ORDER.index(child_local)
    for existing in tblPr:
        ex_local = _local(existing.tag)
        if ex_local in _TBLPR_ORDER:
            ex_pos = _TBLPR_ORDER.index(ex_local)
            if ex_pos > child_pos:
                existing.addprevious(child)
                return
    # 没有更后的元素，append 到末尾
    tblPr.append(child)


# tblBorders 子元素顺序（ECMA-376 固定）：top, left, bottom, right, insideH, insideV
_TBLBORDERS_ORDER = ["top", "left", "bottom", "right", "insideH", "insideV"]


# ============================================================================
# 公共函数 13：set_row_height（P1-6：表格行高）
# ============================================================================
def set_row_height(doc, table_index, row, height, *, rule="atLeast") -> dict:
    """
    设表格指定行的行高（P1-6）。

    参数：
        doc: Document 对象
        table_index: body 内 <w:tbl> 的顺序索引
        row: 行索引（0 基）
        height: python-docx Length
        rule: 高度规则 "atLeast"/"exact"/"auto"（w:hRule）

    返回：
        {doc, table_index, row, height, rule,
         locator:"set_row_height", changes:[...]}

    依据说明：
        设 <w:trPr><w:trHeight w:val=.. w:hRule=../>。trHeight val 单位 dxa。
        trPr 必须是 <w:tr> 第一个子元素。
    样式保护说明：
        - 只追加/改 trPr 内的 trHeight，不动单元格文本与已有 run、不动 tcPr。
        - trPr 已存在则复用，不存在则新建并插到 tr 最前。
    边界说明：
        - 表格/行索引越界 -> 抛 WriterError。
        - rule 非 atLeast/exact/auto -> 抛 WriterError。
    """
    if rule not in ("atLeast", "exact", "auto"):
        raise WriterError(f"rule 必须为 atLeast/exact/auto，实得 {rule!r}")
    tbl = _get_table(doc, table_index)
    rows = tbl.findall(_w("tr"))
    if row < 0 or row >= len(rows):
        raise WriterError(f"行索引越界: {row}（共 {len(rows)} 行）")

    trPr = _ensure_trpr(rows[row])
    trHeight = trPr.find(_w("trHeight"))
    if trHeight is None:
        trHeight = trPr.makeelement(_w("trHeight"), {})
        trPr.append(trHeight)
    dxa = str(int(height) // 635)
    trHeight.set(_w("val"), dxa)
    trHeight.set(_w("hRule"), rule)

    return {
        "doc": doc,
        "table_index": table_index,
        "row": row,
        "height": int(height),
        "rule": rule,
        "locator": "set_row_height",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{table_index}].tr[{row}].trPr.trHeight",
             "note": f"设行高 val={dxa} hRule={rule}"}
        ],
    }


# ============================================================================
# 公共函数 14：shade_cell（P1-6：单元格底纹）
# ============================================================================
def shade_cell(doc, table_index, row, col, fill) -> dict:
    """
    给表格单元格设底纹（P1-6）。

    参数：
        doc: Document 对象
        table_index: body 内 <w:tbl> 的顺序索引
        row: 行索引（0 基）
        col: 列索引（0 基）
        fill: 底纹颜色 hex 字符串（如 "FFE699"）

    返回：
        {doc, table_index, row, col, fill,
         locator:"shade_cell", changes:[...]}

    依据说明：
        设 <w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>。
        tcPr 子元素顺序：shd 在 tcW 之后、noWrap 之前（ECMA-376）。
    样式保护说明：
        - 只追加/改 tcPr 内的 shd，不动单元格文本与已有 run、不动 tcW。
        - shd 已存在则改 fill，不存在则新建。
    边界说明：
        - 表格/行/列越界 -> 抛 WriterError。
        - fill 为空 -> 抛 WriterError。
    """
    if not fill:
        raise WriterError("fill 不能为空")
    loc = locate_table_cell(doc, table_index, row, col)
    tc = loc["tc_elem"]
    tcPr = _ensure_tcpr(tc)
    shd = tcPr.find(_w("shd"))
    if shd is None:
        shd = tcPr.makeelement(_w("shd"), {})
        _insert_tcpr_child_in_order(tcPr, shd)
    shd.set(_w("val"), "clear")
    shd.set(_w("color"), "auto")
    shd.set(_w("fill"), fill)

    return {
        "doc": doc,
        "table_index": table_index, "row": row, "col": col,
        "fill": fill,
        "locator": "shade_cell",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{table_index}].tr[{row}].tc[{col}].tcPr.shd",
             "note": f"设底纹 fill={fill!r}"}
        ],
    }


# tcPr 子元素顺序（ECMA-376，本库相关子集）：
#   tcW -> gridSpan -> vMerge -> tcBorders -> shd -> noWrap -> tcMar -> ...
_TCPR_ORDER = [
    "tcW", "gridSpan", "vMerge", "tcBorders", "shd", "noWrap",
    "tcMar", "textDirection", "tcFitText", "vAlign",
]


def _insert_tcpr_child_in_order(tcPr, child):
    """把 child 插入 tcPr，保持 OOXML 子元素顺序正确。"""
    child_local = _local(child.tag)
    if child_local not in _TCPR_ORDER:
        tcPr.append(child)
        return
    child_pos = _TCPR_ORDER.index(child_local)
    for existing in tcPr:
        ex_local = _local(existing.tag)
        if ex_local in _TCPR_ORDER:
            ex_pos = _TCPR_ORDER.index(ex_local)
            if ex_pos > child_pos:
                existing.addprevious(child)
                return
    tcPr.append(child)


# trPr 子元素顺序（ECMA-376，本库相关子集）：
#   cnfStyle -> divId -> gridBefore -> gridAfter -> wBefore -> wAfter ->
#   trHeight -> cantSplit -> trPr -> tblHeader -> tblCellSpacing -> ...
_TRPR_ORDER = [
    "cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter",
    "trHeight", "cantSplit", "trPr", "tblHeader",
    "tblCellSpacing", "jc", "hidden", "ins", "del",
]


def _insert_trpr_child_in_order(trPr, child):
    """把 child 插入 trPr，保持 OOXML 子元素顺序正确。"""
    child_local = _local(child.tag)
    if child_local not in _TRPR_ORDER:
        trPr.append(child)
        return
    child_pos = _TRPR_ORDER.index(child_local)
    for existing in trPr:
        ex_local = _local(existing.tag)
        if ex_local in _TRPR_ORDER:
            ex_pos = _TRPR_ORDER.index(ex_local)
            if ex_pos > child_pos:
                existing.addprevious(child)
                return
    trPr.append(child)


# ============================================================================
# 公共函数 15：set_table_borders（P1-6：表格边框）
# ============================================================================
def set_table_borders(doc, table_index, *, style="single", sz=4,
                      color="000000",
                      sides=("top", "left", "bottom", "right",
                             "insideH", "insideV")) -> dict:
    """
    设表格边框（P1-6）。

    参数：
        doc: Document 对象
        table_index: body 内 <w:tbl> 的顺序索引
        style: 边框样式 w:val（如 "single"/"none"/"dashed"）
        sz: 边框宽度（1/8 pt 单位，w:sz，如 4 = 0.5pt）
        color: 边框颜色 hex（如 "000000"）
        sides: 要设的边 tuple，默认 6 个全设：
               ("top","left","bottom","right","insideH","insideV")

    返回：
        {doc, table_index, style, sz, color, sides,
         locator:"set_table_borders", changes:[...]}

    依据说明：
        设 <w:tblPr><w:tblBorders> 各 side 的
        <w:{side} w:val=.. w:sz=.. w:space=0 w:color=..>。
        tblBorders 子元素顺序固定（ECMA-376）：
        top, left, bottom, right, insideH, insideV ——按此顺序插入。
        tblBorders 在 tblPr 子元素顺序中位于 tblInd 之后、shd 之前。
    样式保护说明：
        - 只追加/改 tblPr 内的 tblBorders，不动单元格文本与已有 run。
        - tblBorders 已存在则重建其 side 子元素（保证顺序与数量）。
    边界说明：
        - 表格索引越界 -> 抛 WriterError。
        - sides 中的 side 名不合法 -> 抛 WriterError。
    """
    for s in sides:
        if s not in _TBLBORDERS_ORDER:
            raise WriterError(f"非法 side: {s!r}（合法: {_TBLBORDERS_ORDER}）")
    tbl = _get_table(doc, table_index)
    tblPr = _ensure_tblpr(tbl)

    # 删除旧 tblBorders，按固定顺序重建
    old_borders = tblPr.find(_w("tblBorders"))
    if old_borders is not None:
        tblPr.remove(old_borders)
    tblBorders = tblPr.makeelement(_w("tblBorders"), {})
    for side in _TBLBORDERS_ORDER:
        if side not in sides:
            continue
        border = tblBorders.makeelement(_w(side), {})
        border.set(_w("val"), style)
        border.set(_w("sz"), str(sz))
        border.set(_w("space"), "0")
        border.set(_w("color"), color)
        tblBorders.append(border)
    _insert_tblpr_child_in_order(tblPr, tblBorders)

    return {
        "doc": doc,
        "table_index": table_index,
        "style": style,
        "sz": sz,
        "color": color,
        "sides": list(sides),
        "locator": "set_table_borders",
        "changes": [
            {"paragraph": None, "path": f"tbl[{table_index}].tblPr.tblBorders",
             "note": f"设 {len(sides)} 个边框（style={style}, sz={sz}, color={color}）"}
        ],
    }


# ============================================================================
# 公共函数 16：set_repeat_header_row（P1-6：表头跨页重复）
# ============================================================================
def set_repeat_header_row(doc, table_index, row) -> dict:
    """
    设表格指定行为表头跨页重复（P1-6）。

    参数：
        doc: Document 对象
        table_index: body 内 <w:tbl> 的顺序索引
        row: 行索引（0 基）

    返回：
        {doc, table_index, row, locator:"set_repeat_header_row", changes:[...]}

    依据说明：
        设该行 <w:trPr><w:tblHeader/>（表头跨页重复）。
        tblHeader 在 trPr 子元素顺序中位于 trHeight 之后（ECMA-376）。
    样式保护说明：
        - 只追加 trPr 内的 tblHeader，不动单元格文本与已有 run、不动 tcPr。
        - tblHeader 已存在则幂等不重复插。
    边界说明：
        - 表格/行索引越界 -> 抛 WriterError。
    """
    tbl = _get_table(doc, table_index)
    rows = tbl.findall(_w("tr"))
    if row < 0 or row >= len(rows):
        raise WriterError(f"行索引越界: {row}（共 {len(rows)} 行）")

    trPr = _ensure_trpr(rows[row])
    if trPr.find(_w("tblHeader")) is None:
        tblHeader = trPr.makeelement(_w("tblHeader"), {})
        _insert_trpr_child_in_order(trPr, tblHeader)

    return {
        "doc": doc,
        "table_index": table_index,
        "row": row,
        "locator": "set_repeat_header_row",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{table_index}].tr[{row}].trPr.tblHeader",
             "note": "设表头跨页重复"}
        ],
    }


# ============================================================================
# 公共函数 17：create_paragraph_style（P1-9：样式创作 - 创建段落样式）
# ============================================================================
def create_paragraph_style(doc, style_id, name, *, based_on="Normal",
                           font_name=None, font_size=None, bold=None,
                           color=None, alignment=None) -> dict:
    """
    在 styles.xml 创建新的段落样式定义（P1-9）。

    **注意：此函数主动修改 styles.xml。** 调用方在 verifier 校验时需把
    styles.xml 变更列入 expected_changes 放行（与既有「styles.xml 不应变」
    的约定冲突，故在此明确告知）。

    参数：
        doc: Document 对象
        style_id: 样式 ID（styles.xml 的 w:styleId）
        name: 样式显示名（w:name w:val）
        based_on: 基于样式 ID（w:basedOn w:val），默认 "Normal"
        font_name: 字体名 -> <w:rFonts> 四属性 ascii/hAnsi/eastAsia/cs
        font_size: 字号（pt，float/int）-> <w:sz>/<w:szCs w:val=points*2>
        bold: True -> <w:b/>；None/False 不设
        color: hex 字符串 -> <w:color w:val=..>
        alignment: "left"/"center"/"right"/"both"/"distribute" -> <w:jc w:val=..>

    返回：
        {doc, style_id, name, based_on, locator:"create_paragraph_style",
         changes:[...]}

    依据说明：
        用 python-docx doc.styles.add_style(style_id, WD_STYLE_TYPE.PARAGRAPH)
        建样式元素，设 name/basedOn/rPr（font_name 设 rFonts 四属性 + 删 theme 属性，
        参考 ai-bid assembler._set_rfonts；font_size 设 sz/szCs val=points*2；
        bold 设 b；color 设 color；alignment 设 pPr/jc）。
    样式保护说明：
        - 只新增样式定义，不覆盖已有样式（style_id 已存在 -> 抛 WriterError）。
        - rFonts 设四属性（ascii/hAnzi/eastAsia/cs）并删 theme 属性
          （eastAsiaTheme/asciiTheme 等），这是中文字体正确渲染的关键。
    边界说明：
        - style_id 已存在 -> 抛 WriterError（不覆盖）。
        - 主动改 styles.xml，调用方校验需 expected 放行。
    """
    from docx.enum.style import WD_STYLE_TYPE

    # 检查 style_id 是否已存在
    existing_ids = {s.style_id for s in doc.styles}
    if style_id in existing_ids:
        raise WriterError(f"style_id 已存在: {style_id!r}（不覆盖）")
    # 也检查 name 是否已存在（python-docx add_style 按 name 去重）
    existing_names = {s.name for s in doc.styles}
    if name in existing_names:
        raise WriterError(f"样式名 {name!r} 已存在（不覆盖）")

    try:
        style = doc.styles.add_style(style_id, WD_STYLE_TYPE.PARAGRAPH)
    except ValueError as e:
        raise WriterError(f"创建样式失败: {e}")
    style.name = name

    # basedOn
    style_el = style.element
    if based_on is not None:
        # basedOn 必须在 name 之后、rPr 之前（OOXML 顺序）
        existing_basedOn = style_el.find(_w("basedOn"))
        if existing_basedOn is None:
            basedOn_el = style_el.makeelement(_w("basedOn"), {_w("val"): based_on})
            # 插到 name 之后
            name_el = style_el.find(_w("name"))
            if name_el is not None:
                name_el.addnext(basedOn_el)
            else:
                style_el.append(basedOn_el)

    # rPr（字体/字号/加粗/颜色）
    rpr = style_el.find(_w("rPr"))
    if rpr is None:
        rpr = style_el.makeelement(_w("rPr"), {})
        style_el.append(rpr)

    if font_name is not None:
        rfonts = rpr.find(_w("rFonts"))
        if rfonts is None:
            rfonts = rpr.makeelement(_w("rFonts"), {})
            rpr.insert(0, rfonts)
        # 四属性 + 删 theme 属性（参考 ai-bid _set_rfonts）
        rfonts.set(_w("ascii"), font_name)
        rfonts.set(_w("hAnsi"), font_name)
        rfonts.set(_w("eastAsia"), font_name)
        rfonts.set(_w("cs"), font_name)
        for attr in ("eastAsiaTheme", "asciiTheme", "hAnsiTheme", "cstheme"):
            qname = _w(attr)
            if qname in rfonts.attrib:
                del rfonts.attrib[qname]

    if font_size is not None:
        sz_val = str(int(float(font_size) * 2))
        sz = rpr.find(_w("sz"))
        if sz is None:
            sz = rpr.makeelement(_w("sz"), {})
            rpr.append(sz)
        sz.set(_w("val"), sz_val)
        szCs = rpr.find(_w("szCs"))
        if szCs is None:
            szCs = rpr.makeelement(_w("szCs"), {})
            rpr.append(szCs)
        szCs.set(_w("val"), sz_val)

    if bold:
        if rpr.find(_w("b")) is None:
            rpr.append(rpr.makeelement(_w("b"), {}))
        # bCs 也设
        if rpr.find(_w("bCs")) is None:
            rpr.append(rpr.makeelement(_w("bCs"), {}))

    if color is not None:
        c = rpr.find(_w("color"))
        if c is None:
            c = rpr.makeelement(_w("color"), {})
            rpr.append(c)
        c.set(_w("val"), color)

    # alignment -> pPr/jc
    if alignment is not None:
        ppr = style_el.find(_w("pPr"))
        if ppr is None:
            ppr = style_el.makeelement(_w("pPr"), {})
            style_el.append(ppr)
        jc = ppr.find(_w("jc"))
        if jc is None:
            jc = ppr.makeelement(_w("jc"), {})
            ppr.append(jc)
        jc.set(_w("val"), alignment)

    return {
        "doc": doc,
        "style_id": style_id,
        "name": name,
        "based_on": based_on,
        "locator": "create_paragraph_style",
        "changes": [
            {"paragraph": None, "path": f"styles.xml/style[{style_id}]",
             "note": f"新建段落样式 {name!r}（basedOn={based_on}）"}
        ],
    }


# ============================================================================
# 公共函数 18：apply_style（P1-9：应用命名样式）
# ============================================================================
def apply_style(doc, anchor, style_id) -> dict:
    """
    给锚点段落应用命名样式（设 pPr/pStyle）（P1-9）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义（dict / int / <w:p>）
        style_id: 样式 ID（须已存在于 doc.styles）

    返回：
        {doc, paragraph_index, style_id, locator:"apply_style", changes:[...]}

    依据说明：
        设/替换锚点段 pPr 的 <w:pStyle w:val=style_id>。pStyle 必须是 pPr
        第一个子元素（OOXML 顺序）。
    样式保护说明：
        - 只改 pPr 内的 pStyle 一个属性，不动 run/rPr、不动 pPr 其它子元素。
        - pStyle 已存在则改 val，不存在则新建并插到 pPr 最前。
    边界说明：
        - style_id 不在 doc.styles -> 抛 WriterError。
        - 锚点不可识别 -> 抛 WriterError。
    """
    existing_ids = {s.style_id for s in doc.styles}
    if style_id not in existing_ids:
        raise WriterError(f"style_id 不存在: {style_id!r}")

    anchor_p = _resolve_anchor(doc, anchor)
    ppr = anchor_p.find(_w("pPr"))
    if ppr is None:
        ppr = anchor_p.makeelement(_w("pPr"), {})
        anchor_p.insert(0, ppr)
    pStyle = ppr.find(_w("pStyle"))
    if pStyle is None:
        pStyle = ppr.makeelement(_w("pStyle"), {})
        # pStyle 必须是 pPr 第一个子元素
        ppr.insert(0, pStyle)
    pStyle.set(_w("val"), style_id)

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "style_id": style_id,
        "locator": "apply_style",
        "changes": [
            {"paragraph": p_idx, "path": f"pPr.pStyle",
             "note": f"应用样式 {style_id!r}"}
        ],
    }


# ============================================================================
# 公共函数 19：set_run_font（P1-9：设置中文字体四属性）
# ============================================================================
def set_run_font(doc, anchor, font_name, *, size=None, east_asia=None) -> dict:
    """
    给锚点段落所有 run 设字体四属性（中文字体必须设 eastAsia，P1-9）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 _resolve_anchor 语义（dict / int / <w:p>）
        font_name: 字体名（ascii/hAnsi/cs 用此；eastAsia 用 east_asia 或 font_name）
        size: 可选，字号（pt）-> sz/szCs val=points*2
        east_asia: 东亚字体名；None 时用 font_name（中文字体关键：必须设 eastAsia）

    返回：
        {doc, paragraph_index, run_count, font_name, east_asia,
         locator:"set_run_font", changes:[...]}

    依据说明：
        对锚点段每个 run（无 run 则新建一个空 run）设 <w:rFonts> 四属性
        （ascii/hAnzi/cs 用 font_name，eastAsia 用 east_asia 或 font_name），
        并删 theme 属性（eastAsiaTheme/asciiTheme 等，参考 ai-bid _set_rfonts）。
        size 设 sz/szCs。保留其它 rPr 子元素。
    样式保护说明：
        - 只改 rPr 内的 rFonts/sz/szCs，保留其它 rPr 子元素。
        - 不改 pPr、不改 run 文本。
        - 段落无 run 时新建一个空 run（无文本）再设字体。
    边界说明：
        - 锚点不可识别 -> 抛 WriterError。
        - font_name 为空 -> 抛 WriterError。
    """
    if not font_name:
        raise WriterError("font_name 不能为空")
    ea_font = east_asia if east_asia else font_name

    anchor_p = _resolve_anchor(doc, anchor)
    runs = anchor_p.findall(_w("r"))
    if not runs:
        # 新建一个空 run
        new_r = anchor_p.makeelement(_w("r"), {})
        anchor_p.append(new_r)
        runs = [new_r]

    for r in runs:
        rpr = r.find(_w("rPr"))
        if rpr is None:
            rpr = r.makeelement(_w("rPr"), {})
            r.insert(0, rpr)
        rfonts = rpr.find(_w("rFonts"))
        if rfonts is None:
            rfonts = rpr.makeelement(_w("rFonts"), {})
            # rFonts 应是 rPr 第一个子元素
            rpr.insert(0, rfonts)
        # 四属性 + 删 theme 属性
        rfonts.set(_w("ascii"), font_name)
        rfonts.set(_w("hAnsi"), font_name)
        rfonts.set(_w("eastAsia"), ea_font)
        rfonts.set(_w("cs"), font_name)
        for attr in ("eastAsiaTheme", "asciiTheme", "hAnsiTheme", "cstheme"):
            qname = _w(attr)
            if qname in rfonts.attrib:
                del rfonts.attrib[qname]
        if size is not None:
            sz_val = str(int(float(size) * 2))
            sz = rpr.find(_w("sz"))
            if sz is None:
                sz = rpr.makeelement(_w("sz"), {})
                rpr.append(sz)
            sz.set(_w("val"), sz_val)
            szCs = rpr.find(_w("szCs"))
            if szCs is None:
                szCs = rpr.makeelement(_w("szCs"), {})
                rpr.append(szCs)
            szCs.set(_w("val"), sz_val)

    # 推断段落索引
    body = doc.element.body
    p_idx = None
    p_counter = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is anchor_p:
                p_idx = p_counter
                break
            p_counter += 1

    return {
        "doc": doc,
        "paragraph_index": p_idx,
        "run_count": len(runs),
        "font_name": font_name,
        "east_asia": ea_font,
        "locator": "set_run_font",
        "changes": [
            {"paragraph": p_idx, "path": f"runs[*].rPr.rFonts",
             "note": f"设字体 {font_name!r}（eastAsia={ea_font!r}，size={size}）"}
        ],
    }


# ============================================================================
# 自测：对 base.docx 写入，并用 verifier 校验样式无损
# ============================================================================
def _self_test():
    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from src.verifier import (
        compare_documents, validate_openable, extract_style_fingerprint,
    )
    from src.locator import _pstyle_value

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    # 说明：插入新段落会改变段落数量，导致 compare_documents 按索引对齐失效
    # （verifier 已知局限）。因此对"插入段落"类操作，改用针对性校验：
    #   1) 插入位置之前的段落（索引 0~anchor）逐段指纹必须完全一致；
    #   2) 新段落样式必须与锚点段落一致（pPr/rPr 逐一比对）；
    #   3) styles.xml 未被改动；文档可打开。
    # 对"追加文本"类操作（不改变段落数），仍可用 compare_documents 全量校验。

    def assert_prefix_unchanged(doc_before_path, doc_after_path, up_to_index):
        """校验 after 文档的 0~up_to_index 段落与 before 完全一致。"""
        db = Document(doc_before_path)
        da = Document(doc_after_path)
        for i in range(up_to_index + 1):
            fpb = extract_style_fingerprint(db.paragraphs[i])
            fpa = extract_style_fingerprint(da.paragraphs[i])
            assert fpb["fingerprint_sha1"] == fpa["fingerprint_sha1"], (
                f"段落{i} 样式指纹变化：before={fpb} after={fpa}")

    # ---- 测试1：在段落7后插入新段落（继承样式）----
    doc = Document(BASE)
    res = insert_paragraph_after(doc, 7, "新插入的段落内容", inherit_style=True)
    out1 = "output/writer_test_1.docx"
    doc.save(out1)
    # 插入位置之前的段落（0~7）必须零差异
    assert_prefix_unchanged(BASE, out1, 7)
    # 新段落样式应与段落7一致（pPr_rPr 与 runs[0].rPr）
    doc2 = Document(out1)
    new_p = doc2.paragraphs[res["new_paragraph_index"]]
    assert new_p.text == "新插入的段落内容", new_p.text
    fp7 = extract_style_fingerprint(doc2.paragraphs[7])
    fp_new = extract_style_fingerprint(new_p)
    assert fp7["pPr_rPr"] == fp_new["pPr_rPr"], "新段落段落标记样式应与段落7一致"
    assert fp_new["runs"][0]["rPr"] == fp7["runs"][0]["rPr"], "新段落 run 样式应与段落7一致"
    # styles.xml 未改动 + 可打开
    r1 = compare_documents(BASE, out1, expected_changes=None)
    assert r1["styles_xml_changed"] is False, "styles.xml 不应被改动"
    assert validate_openable(out1)
    print(f"[测试1 通过] 段落7后插入新段落，继承宋体四号样式；0~7段零差异，styles.xml 未变")

    # ---- 测试2：在标题1段落后插入新标题段落（继承 pStyle=1）----
    doc = Document(BASE)
    loc = locate_by_heading_level(doc, 1)  # 段落2
    res = insert_paragraph_after(doc, loc, "新增标题1", inherit_style=True)
    out2 = "output/writer_test_2.docx"
    doc.save(out2)
    assert_prefix_unchanged(BASE, out2, 2)
    doc2 = Document(out2)
    new_p = doc2.paragraphs[res["new_paragraph_index"]]
    assert new_p.text == "新增标题1"
    assert _pstyle_value(new_p._p) == "1", "新段落应继承标题1样式 pStyle=1"
    r2 = compare_documents(BASE, out2, expected_changes=None)
    assert r2["styles_xml_changed"] is False
    assert validate_openable(out2)
    print(f"[测试2 通过] 标题1后插入新标题段落，继承 pStyle=1；0~2段零差异，styles.xml 未变")

    # ---- 测试3：追加文本到段落7（继承字号字体）—— 不改变段落数，可全量校验 ----
    doc = Document(BASE)
    res = append_text_to_paragraph(doc, 7, "【追加】", inherit_style=True)
    out3 = "output/writer_test_3.docx"
    doc.save(out3)
    # 追加 run 属于段落7 的 runs[N]，声明该新 run 整段放行
    result = compare_documents(BASE, out3, expected_changes=res["changes"])
    assert result["unexpected_changes"] == [], (
        f"测试3 意外样式改动: {result['unexpected_changes']}")
    assert result["styles_xml_changed"] is False
    assert validate_openable(out3)
    doc2 = Document(out3)
    p7 = doc2.paragraphs[7]
    assert p7.text == "正文宋体四号【追加】", p7.text
    new_run_rpr = p7.runs[-1]._r.find(_w("rPr"))
    sz = new_run_rpr.find(_w("sz"))
    assert sz is not None and sz.get(_w("val")) == "28", "追加 run 应继承字号28"
    print(f"[测试3 通过] 段落7追加文本，继承字号28；全量校验仅新 run 放行，无意外改动")

    # ---- 测试4：在 body 末尾段落(38)后插入，确保落在 sectPr 之前 ----
    doc = Document(BASE)
    res = insert_paragraph_after(doc, 38, "末尾新增段落", inherit_style=True)
    out4 = "output/writer_test_4.docx"
    doc.save(out4)
    body = doc.element.body
    assert _local(body[-1].tag) == "sectPr", "sectPr 必须仍是 body 末尾元素"
    assert _local(body[-2].tag) == "p", "新段落应在 sectPr 之前"
    assert validate_openable(out4)
    print(f"[测试4 通过] 末尾段落后插入，新段落正确落在 sectPr 之前")

    # ---- 边界测试：空文本追加应抛异常 ----
    doc = Document(BASE)
    try:
        append_text_to_paragraph(doc, 7, "")
        raised = False
    except WriterError:
        raised = True
    assert raised, "空文本追加应抛 WriterError"
    print(f"[边界通过] 空文本追加 -> 抛 WriterError")

    # ---- 测试5：replace_placeholder 正常替换（base.docx 段落9 含下划线文本）----
    # base.docx 段落9 文本「宋体四号下划线」run 含 <w:u>，适合做占位符替换模板。
    # 先用 insert_paragraph_after 在段落7后插一个含占位符的段落，再就地替换。
    import re as _re
    doc = Document(BASE)
    # 构造测试段落：在段落7后插入「单位地址：_____________________」
    insert_paragraph_after(doc, 7, "单位地址：_____________________", inherit_style=True)
    # 新段落索引 = 8
    res = replace_placeholder(doc, 8, _re.compile(r"_{2,}"), "广西南宁市青秀区某路1号",
                              run_props={"underline": True})
    out5 = "output/writer_test_5.docx"
    doc.save(out5)
    doc2 = Document(out5)
    p8 = doc2.paragraphs[8]
    assert p8.text == "单位地址：广西南宁市青秀区某路1号", p8.text
    assert "____" not in p8.text, "不应残留占位符下划线"
    # 值 run 应带下划线
    val_run = p8.runs[-1]._r
    u = val_run.find(_w("rPr")).find(_w("u"))
    assert u is not None and u.get(_w("val")) == "single", "值 run 应带下划线"
    assert validate_openable(out5)
    print(f"[测试5 通过] replace_placeholder 长占位符(21个_)就地替换，无残留，值带下划线")

    # ---- 测试6：replace_placeholder 带后缀替换（如 ________ (签字或盖章)）----
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "法定代表人：________ (签字或盖章)", inherit_style=True)
    res = replace_placeholder(doc, 8, r"_{2,}", "张三", run_props={"underline": True})
    out6 = "output/writer_test_6.docx"
    doc.save(out6)
    doc2 = Document(out6)
    p8 = doc2.paragraphs[8]
    assert p8.text == "法定代表人：张三 (签字或盖章)", p8.text
    # 值在 (签字或盖章) 之前
    assert p8.text.index("张三") < p8.text.index("(签字或盖章)"), "值应在后缀前"
    assert validate_openable(out6)
    print(f"[测试6 通过] replace_placeholder 带后缀替换，值落在后缀前：{p8.text!r}")

    # ---- 测试7：replace_placeholder 未命中抛 WriterError（不静默跳过）----
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "无占位符的普通段落", inherit_style=True)
    try:
        replace_placeholder(doc, 8, r"_{2,}", "值")
        raised = False
    except WriterError:
        raised = True
    assert raised, "未命中占位符应抛 WriterError"
    print(f"[测试7 通过] replace_placeholder 未命中 -> 抛 WriterError（非静默）")

    # ---- 测试8：fill_date_slots 日期 slot 填写 ----
    doc = Document(BASE)
    # 构造测试段落：「日期：2025年  月  日」，年/月后各跟空白 run
    # 用多 run 拼接：先插一个空段落，再用 lxml 构造各 run
    insert_paragraph_after(doc, 7, "", inherit_style=True)
    p8_elem = doc.paragraphs[8]._p
    # 清空默认 run（insert 空段落无 run，pPr 已继承）
    tmpl_rpr = doc.paragraphs[7]._p.find(_w("r")).find(_w("rPr"))
    for seg in ["日期：", "2025", "年", "  ", "月", "  ", "日"]:
        p8_elem.append(_make_run_with_rpr(tmpl_rpr, seg))
    res = fill_date_slots(doc, 8, markers=["年", "月"], values=["2", "9"],
                          run_props={"underline": True})
    out8 = "output/writer_test_8.docx"
    doc.save(out8)
    doc2 = Document(out8)
    p8 = doc2.paragraphs[8]
    assert p8.text == "日期：2025年2月9日", p8.text
    # 无重复（年份只出现一次，且没有「日2025」这种末尾追加导致的重复串）
    assert p8.text.count("2025") == 1, "不应重复年份"
    assert "日2025" not in p8.text, "不应出现末尾追加导致的重复串 日2025"
    assert validate_openable(out8)
    print(f"[测试8 通过] fill_date_slots 日期填写：{p8.text!r}，无重复")

    # ---- 测试9：fill_date_slots slot 非空抛 WriterError ----
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "", inherit_style=True)
    p8_elem = doc.paragraphs[8]._p
    tmpl_rpr = doc.paragraphs[7]._p.find(_w("r")).find(_w("rPr"))
    for seg in ["日期：", "2025", "年", "已被占", "月", "  ", "日"]:
        p8_elem.append(_make_run_with_rpr(tmpl_rpr, seg))
    try:
        fill_date_slots(doc, 8, markers=["年"], values=["2"])
        raised = False
    except WriterError:
        raised = True
    assert raised, "slot 非空应抛 WriterError"
    print(f"[测试9 通过] fill_date_slots slot 非空 -> 抛 WriterError")

    # ---- 测试10：append_text_to_paragraph 带 run_props 下划线 ----
    doc = Document(BASE)
    append_text_to_paragraph(doc, 7, "带下划线追加", run_props={"underline": True})
    out10 = "output/writer_test_10.docx"
    doc.save(out10)
    doc2 = Document(out10)
    p7 = doc2.paragraphs[7]
    last_run = p7.runs[-1]._r
    u = last_run.find(_w("rPr")).find(_w("u"))
    assert u is not None and u.get(_w("val")) == "single", "追加 run 应带下划线"
    # 字号应继承（28）
    sz = last_run.find(_w("rPr")).find(_w("sz"))
    assert sz is not None and sz.get(_w("val")) == "28", "应继承字号28"
    assert validate_openable(out10)
    print(f"[测试10 通过] append_text_to_paragraph 带 run_props 下划线，且继承字号28")

    # ---- 测试11：replace_all_placeholders 多占位符一次性替换 ----
    import re as _re2
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "姓名：____ 性别：____ 年龄：____ 职务：____",
                           inherit_style=True)
    res = replace_all_placeholders(
        doc, 8, _re2.compile(r"_{2,}"),
        ["张三", "男", "18", "销售"], run_props={"underline": True})
    out11 = "output/writer_test_11.docx"
    doc.save(out11)
    doc2 = Document(out11)
    p8 = doc2.paragraphs[8]
    assert p8.text == "姓名：张三 性别：男 年龄：18 职务：销售", p8.text
    assert "____" not in p8.text, "不应残留占位符"
    assert len(res["replaced"]) == 4, res
    assert validate_openable(out11)
    print(f"[测试11 通过] replace_all_placeholders 4 个占位符一次性替换：{p8.text!r}")

    # ---- 测试12：replace_all_placeholders values 长度不等抛 WriterError ----
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "姓名：____ 性别：____", inherit_style=True)
    try:
        replace_all_placeholders(doc, 8, _re2.compile(r"_{2,}"),
                                 ["张三"])  # 命中 2 个，传 1 个
        raised = False
    except WriterError:
        raised = True
    assert raised, "values 长度不等应抛 WriterError"
    print(f"[测试12 通过] replace_all_placeholders values 长度不等 -> 抛 WriterError")

    # ---- 测试13：replace_all_placeholders 命中 0 抛 WriterError ----
    doc = Document(BASE)
    insert_paragraph_after(doc, 7, "无占位符的普通段落", inherit_style=True)
    try:
        replace_all_placeholders(doc, 8, _re2.compile(r"_{2,}"), ["值"])
        raised = False
    except WriterError:
        raised = True
    assert raised, "命中 0 应抛 WriterError"
    print(f"[测试13 通过] replace_all_placeholders 命中 0 -> 抛 WriterError")

    # ---- 测试14：set_paragraph_text 整段替换（保留 pPr/rPr 模板）----
    doc = Document(BASE)
    res = set_paragraph_text(doc, 7, "整段替换后的新文本", inherit_style=True)
    out14 = "output/writer_test_14.docx"
    doc.save(out14)
    doc2 = Document(out14)
    p7 = doc2.paragraphs[7]
    assert p7.text == "整段替换后的新文本", p7.text
    # pPr 应保留（段落7 pPr 含 rPr 宋体 sz28）
    ppr = p7._p.find(_w("pPr"))
    assert ppr is not None, "pPr 应保留"
    # run rPr 应继承字号28
    new_run_rpr = p7.runs[0]._r.find(_w("rPr"))
    sz = new_run_rpr.find(_w("sz"))
    assert sz is not None and sz.get(_w("val")) == "28", "应继承字号28"
    assert validate_openable(out14)
    print(f"[测试14 通过] set_paragraph_text 整段替换，保留 pPr 与字号28：{p7.text!r}")

    # ---- 测试15：set_paragraph_text 空文本清空段落 ----
    doc = Document(BASE)
    res = set_paragraph_text(doc, 7, "", inherit_style=True)
    out15 = "output/writer_test_15.docx"
    doc.save(out15)
    doc2 = Document(out15)
    p7 = doc2.paragraphs[7]
    assert p7.text == "", f"清空后应为空，实得{p7.text!r}"
    assert res["run_index"] is None, "空文本 run_index 应为 None"
    # pPr 应保留
    ppr = p7._p.find(_w("pPr"))
    assert ppr is not None, "pPr 应保留"
    assert validate_openable(out15)
    print(f"[测试15 通过] set_paragraph_text 空文本清空段落，保留 pPr，run_index=None")

    # ---- 测试16：set_cell_by_label 标签右侧写入值 ----
    doc = Document(BASE)
    # base.docx 表0 表头 C1|C2|C3|C4，用 C1 作 label，写右侧 C2 位置
    res = set_cell_by_label(doc, 0, "C1", "标签右侧值", direction="right")
    out16 = "output/writer_test_16.docx"
    doc.save(out16)
    doc2 = Document(out16)
    tc = doc2.tables[0]._tbl.findall(_w("tr"))[0].findall(_w("tc"))[1]
    tc_text = "".join((t.text or "") for t in tc.iter(_w("t")))
    assert tc_text == "标签右侧值", f"右侧单元格应为标签右侧值，实得{tc_text!r}"
    assert res["label_cell"] == {"row": 0, "col": 0}, res
    assert res["value_cell"] == {"row": 0, "col": 1}, res
    assert validate_openable(out16)
    print(f"[测试16 通过] set_cell_by_label label=C1 右侧写入「标签右侧值」")

    # ---- 测试17：set_cell_by_label 下方写入值 ----
    doc = Document(BASE)
    res = set_cell_by_label(doc, 0, "C1", "下方值", direction="below")
    out17 = "output/writer_test_17.docx"
    doc.save(out17)
    doc2 = Document(out17)
    tc = doc2.tables[0]._tbl.findall(_w("tr"))[1].findall(_w("tc"))[0]
    tc_text = "".join((t.text or "") for t in tc.iter(_w("t")))
    assert tc_text == "下方值", f"下方单元格应为下方值，实得{tc_text!r}"
    assert res["value_cell"] == {"row": 1, "col": 0}, res
    assert validate_openable(out17)
    print(f"[测试17 通过] set_cell_by_label label=C1 下方写入「下方值」")

    # ---- 测试18：set_cell_by_label label 在行末尾抛 WriterError ----
    doc = Document(BASE)
    try:
        set_cell_by_label(doc, 0, "C4", "值", direction="right")  # C4 在行末尾
        raised = False
    except WriterError:
        raised = True
    assert raised, "label 在行末尾应抛 WriterError"
    print(f"[测试18 通过] set_cell_by_label label=C4 右侧无单元格 -> 抛 WriterError")

    # ---- 测试19：set_cell_by_label label 未找到抛 LocateError ----
    doc = Document(BASE)
    try:
        set_cell_by_label(doc, 0, "不存在的标签", "值")
        raised = False
    except LocateError:
        raised = True
    assert raised, "label 未找到应抛 LocateError"
    print(f"[测试19 通过] set_cell_by_label label 未找到 -> 抛 LocateError")

    # ---- 测试20：set_cell_by_label strip_colon 去冒号匹配 ----
    doc = Document(BASE)
    # 先在单元格写入「姓名：」，再按 label="姓名" 匹配（strip_colon=True 默认）
    from src.deleter import clear_table_cell
    clear_table_cell(doc, 0, 0, 0)
    set_table_cell_text(doc, 0, 0, 0, "姓名：", mode="replace")
    res = set_cell_by_label(doc, 0, "姓名", "李四", direction="right")
    out20 = "output/writer_test_20.docx"
    doc.save(out20)
    doc2 = Document(out20)
    tc = doc2.tables[0]._tbl.findall(_w("tr"))[0].findall(_w("tc"))[1]
    tc_text = "".join((t.text or "") for t in tc.iter(_w("t")))
    assert tc_text == "李四", f"strip_colon 匹配后右侧应为李四，实得{tc_text!r}"
    assert validate_openable(out20)
    print(f"[测试20 通过] set_cell_by_label strip_colon 去冒号匹配 label=姓名")

    # ====================================================================
    # insert_image / 表格格式 / 样式创作 测试（P0-5 / P1-6 / P1-9）
    # ====================================================================
    _self_test_image_table_style()

    print()
    print("产出文件：output/writer_test_1~20.docx（供人工验证）")


def _self_test_image_table_style():
    """insert_image / 表格格式 / 样式创作 自测（P0-5 / P1-6 / P1-9）。"""
    import os, zipfile
    from docx.shared import Inches, Pt
    from src.verifier import validate_openable

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
    WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"

    # ---- 提取测试图片（从 base.docx 的 word/media/image1.png）----
    test_img = "output/_test_img.png"
    if not os.path.exists(test_img):
        with zipfile.ZipFile(BASE) as z:
            with z.open("word/media/image1.png") as src, \
                 open(test_img, "wb") as dst:
                dst.write(src.read())

    # ---- 测试21：insert_image 到段落7 ----
    doc = Document(BASE)
    res = insert_image(doc, 7, test_img, inherit_style=True)
    out21 = "output/writer_test_21.docx"
    doc.save(out21)
    doc2 = Document(out21)
    p7 = doc2.paragraphs[7]._p
    blips = list(p7.iter(f"{{{A_NS}}}blip"))
    assert len(blips) == 1, f"应含 1 个 blip，实得 {len(blips)}"
    # noProof
    drawing_run = None
    for r in p7.findall(_w("r")):
        if r.find(_w("drawing")) is not None:
            drawing_run = r
            break
    assert drawing_run is not None, "应有 drawing run"
    rpr = drawing_run.find(_w("rPr"))
    assert rpr is not None and rpr.find(_w("noProof")) is not None, "应有 noProof"
    assert validate_openable(out21)
    print(f"[测试21 通过] insert_image 到段落7，blip=1，含 noProof")

    # ---- 测试22：insert_image width=Inches(2) extent 比例 ----
    doc = Document(BASE)
    res = insert_image(doc, 7, test_img, width=Inches(2))
    out22 = "output/writer_test_22.docx"
    doc.save(out22)
    doc2 = Document(out22)
    p7 = doc2.paragraphs[7]._p
    extent = None
    for ext in p7.iter(f"{{{WP_NS}}}extent"):
        extent = ext
        break
    assert extent is not None, "应有 wp:extent"
    cx = int(extent.get("cx"))
    # Inches(2) = 1828800 EMU
    assert cx == 1828800, f"cx 应=1828800，实得 {cx}"
    assert validate_openable(out22)
    print(f"[测试22 通过] insert_image width=Inches(2)，cx={cx}（比例正确）")

    # ---- 测试23：insert_image 不存在文件抛 WriterError ----
    doc = Document(BASE)
    try:
        insert_image(doc, 7, "nonexistent.png")
        raised = False
    except WriterError:
        raised = True
    assert raised, "不存在文件应抛 WriterError"
    print(f"[测试23 通过] insert_image 不存在文件 -> WriterError")

    # ---- 测试24：set_table_column_widths 4 列 ----
    doc = Document(BASE)
    from docx.shared import Inches as _In
    res = set_table_column_widths(doc, 0, [_In(1), _In(1), _In(1), _In(1)])
    out24 = "output/writer_test_24.docx"
    doc.save(out24)
    doc2 = Document(out24)
    tbl = doc2.tables[0]._tbl
    gridCols = tbl.find(_w("tblGrid")).findall(_w("gridCol"))
    assert len(gridCols) == 4, f"应有 4 gridCol，实得 {len(gridCols)}"
    tblLayout = tbl.find(_w("tblPr")).find(_w("tblLayout"))
    assert tblLayout is not None and tblLayout.get(_w("type")) == "fixed", \
        "tblLayout 应为 fixed"
    assert validate_openable(out24)
    print(f"[测试24 通过] set_table_column_widths 4 列 + layout=fixed")

    # ---- 测试25：set_row_height ----
    doc = Document(BASE)
    res = set_row_height(doc, 0, 0, _In(1), rule="atLeast")
    out25 = "output/writer_test_25.docx"
    doc.save(out25)
    doc2 = Document(out25)
    tr = doc2.tables[0]._tbl.findall(_w("tr"))[0]
    trPr = tr.find(_w("trPr"))
    assert trPr is not None, "应有 trPr"
    trHeight = trPr.find(_w("trHeight"))
    assert trHeight is not None, "应有 trHeight"
    assert trHeight.get(_w("hRule")) == "atLeast"
    assert validate_openable(out25)
    print(f"[测试25 通过] set_row_height 行0，trHeight hRule=atLeast")

    # ---- 测试26：shade_cell ----
    doc = Document(BASE)
    res = shade_cell(doc, 0, 0, 0, "FFE699")
    out26 = "output/writer_test_26.docx"
    doc.save(out26)
    doc2 = Document(out26)
    tc = doc2.tables[0]._tbl.findall(_w("tr"))[0].findall(_w("tc"))[0]
    shd = tc.find(_w("tcPr")).find(_w("shd"))
    assert shd is not None and shd.get(_w("fill")) == "FFE699", \
        f"shd fill 应为 FFE699"
    assert validate_openable(out26)
    print(f"[测试26 通过] shade_cell (0,0) fill=FFE699")

    # ---- 测试27：set_table_borders ----
    doc = Document(BASE)
    res = set_table_borders(doc, 0)
    out27 = "output/writer_test_27.docx"
    doc.save(out27)
    doc2 = Document(out27)
    tblBorders = doc2.tables[0]._tbl.find(_w("tblPr")).find(_w("tblBorders"))
    assert tblBorders is not None, "应有 tblBorders"
    sides = [etree.QName(c).localname for c in tblBorders]
    assert len(sides) == 6, f"应有 6 个 side，实得 {len(sides)}"
    assert validate_openable(out27)
    print(f"[测试27 通过] set_table_borders 6 个 side 子元素")

    # ---- 测试28：set_repeat_header_row ----
    doc = Document(BASE)
    res = set_repeat_header_row(doc, 0, 0)
    out28 = "output/writer_test_28.docx"
    doc.save(out28)
    doc2 = Document(out28)
    tr = doc2.tables[0]._tbl.findall(_w("tr"))[0]
    trPr = tr.find(_w("trPr"))
    assert trPr is not None and trPr.find(_w("tblHeader")) is not None, \
        "应有 tblHeader"
    assert validate_openable(out28)
    print(f"[测试28 通过] set_repeat_header_row 行0，trPr 含 tblHeader")

    # ---- 测试29：表格格式越界抛 WriterError ----
    doc = Document(BASE)
    try:
        set_table_column_widths(doc, 99, [_In(1)])
        raised = False
    except WriterError:
        raised = True
    assert raised, "表索引越界应抛 WriterError"
    try:
        set_table_column_widths(doc, 0, [_In(1), _In(1)])  # 2 != 4 列
        raised = False
    except WriterError:
        raised = True
    assert raised, "widths 长度不匹配应抛 WriterError"
    print(f"[测试29 通过] 表格格式越界/不匹配 -> WriterError")

    # ---- 测试30：create_paragraph_style ----
    doc = Document(BASE)
    res = create_paragraph_style(doc, "MyTitle", "My Title",
                                 font_name="宋体", font_size=14,
                                 bold=True, color="000000",
                                 alignment="center")
    out30 = "output/writer_test_30.docx"
    doc.save(out30)
    doc2 = Document(out30)
    style_ids = {s.style_id for s in doc2.styles}
    assert "MyTitle" in style_ids, "应含 MyTitle 样式"
    # 检查 styles.xml 内容
    z = zipfile.ZipFile(out30)
    styles_root = etree.fromstring(z.read("word/styles.xml"))
    found = False
    for st in styles_root.findall(_w("style")):
        if st.get(_w("styleId")) == "MyTitle":
            found = True
            name_el = st.find(_w("name"))
            assert name_el is not None and name_el.get(_w("val")) == "My Title"
            rpr = st.find(_w("rPr"))
            assert rpr is not None
            rfonts = rpr.find(_w("rFonts"))
            assert rfonts is not None
            assert rfonts.get(_w("eastAsia")) == "宋体"
            assert rfonts.get(_w("ascii")) == "宋体"
            break
    assert found, "styles.xml 应含 MyTitle"
    assert validate_openable(out30)
    print(f"[测试30 通过] create_paragraph_style MyTitle（宋体 14pt 加粗）")

    # ---- 测试31：create_paragraph_style style_id 已存在抛 WriterError ----
    doc = Document(BASE)
    try:
        create_paragraph_style(doc, "Normal", "x")
        raised = False
    except WriterError:
        raised = True
    assert raised, "style_id 已存在应抛 WriterError"
    print(f"[测试31 通过] create_paragraph_style style_id 已存在 -> WriterError")

    # ---- 测试32：apply_style ----
    doc = Document(BASE)
    create_paragraph_style(doc, "MyTitle2", "My Title 2")
    res = apply_style(doc, 7, "MyTitle2")
    out32 = "output/writer_test_32.docx"
    doc.save(out32)
    doc2 = Document(out32)
    p7 = doc2.paragraphs[7]._p
    ppr = p7.find(_w("pPr"))
    assert ppr is not None, "应有 pPr"
    pStyle = ppr.find(_w("pStyle"))
    assert pStyle is not None and pStyle.get(_w("val")) == "MyTitle2", \
        "pStyle 应为 MyTitle2"
    assert validate_openable(out32)
    print(f"[测试32 通过] apply_style 段落7 -> pStyle=MyTitle2")

    # ---- 测试33：apply_style 不存在样式抛 WriterError ----
    doc = Document(BASE)
    try:
        apply_style(doc, 7, "NonExistentStyle")
        raised = False
    except WriterError:
        raised = True
    assert raised, "不存在样式应抛 WriterError"
    print(f"[测试33 通过] apply_style 不存在样式 -> WriterError")

    # ---- 测试34：set_run_font 宋体 ----
    doc = Document(BASE)
    res = set_run_font(doc, 7, "宋体", size=14)
    out34 = "output/writer_test_34.docx"
    doc.save(out34)
    doc2 = Document(out34)
    p7 = doc2.paragraphs[7]._p
    for r in p7.findall(_w("r")):
        rpr = r.find(_w("rPr"))
        if rpr is None:
            continue
        rfonts = rpr.find(_w("rFonts"))
        if rfonts is not None:
            assert rfonts.get(_w("eastAsia")) == "宋体", \
                f"eastAsia 应为宋体，实得 {rfonts.get(_w('eastAsia'))}"
            assert rfonts.get(_w("ascii")) == "宋体"
            assert rfonts.get(_w("hAnsi")) == "宋体"
            assert rfonts.get(_w("cs")) == "宋体"
            break
    assert validate_openable(out34)
    print(f"[测试34 通过] set_run_font 段落7 宋体（四属性齐全）")

    print()
