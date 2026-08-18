# -*- coding: utf-8 -*-
"""
阶段2 模块：读取器（Reader）—— 大纲提取 + 结构化导出

定位：提供文档全文本提取与 Markdown 结构化导出能力（P2-11）。
只读模块，不改文档。

================================================================
开发依据（基于 base.docx 真实结构，见 logs/base_structure.md + 实测）
================================================================
1. body 子元素序列：段落 <w:p> 与表格 <w:tbl> 交替，末尾是 <w:sectPr>。
2. 段落文本分散在多个 run，必须用 iter(qn('w:t')) 拼接（禁用 python-docx .text）。
3. 标题用 pStyle（base.docx: 1/2/3）或 outlineLvl（烟草招标.docx: 0/1/2），
   由 locator._heading_level_of 统一判定。
4. 表格：<w:tbl><w:tr><w:tc>，tc 内是 <w:tcPr> + <w:p>。

已确认的 XML 样本（来自 base.docx 实测）。
"""

from __future__ import annotations

import os as _os
import sys as _sys
from typing import Any

if __package__ in (None, ""):
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from docx.oxml.ns import qn
from lxml import etree

from src.locator import (
    _body, _body_paragraphs, _paragraph_text, _heading_level_of,
    _style_id_to_name, _local, _w,
)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


class ReaderError(Exception):
    """读取器失败统一异常。"""


# ============================================================================
# 内部工具
# ============================================================================
def _tc_text(tc_elem) -> str:
    """拼接单元格内所有段落文本（用 iter('w:t') 拼接）。"""
    if tc_elem is None:
        return ""
    parts = []
    for p in tc_elem.findall(_w("p")):
        parts.append(_paragraph_text(p))
    return " / ".join(parts)


def _table_to_markdown(tbl_elem) -> str:
    """把 <w:tbl> 转为 markdown 表格字符串。"""
    rows = tbl_elem.findall(_w("tr"))
    if not rows:
        return ""
    lines = []
    for ri, tr in enumerate(rows):
        cells = tr.findall(_w("tc"))
        cell_texts = [_tc_text(tc).replace("\n", " ") for tc in cells]
        lines.append("| " + " | ".join(cell_texts) + " |")
        if ri == 0:
            # 分隔行
            sep = ["---"] * len(cells)
            lines.append("| " + " | ".join(sep) + " |")
    return "\n".join(lines)


# ============================================================================
# 公共函数 1：extract_all_text（P2-11）
# ============================================================================
def extract_all_text(doc, *, include_tables: bool = True) -> dict:
    """
    提取文档全部文本（P2-11）。

    参数：
        doc: Document 对象或 body 元素
        include_tables: True 时把表格按行拼接（| cell | cell | 格式）

    返回：
        {text, paragraph_count, table_count, locator:"extract_all_text"}

    依据说明：
        遍历 body 段落，用 iter(qn('w:t')) 拼接文本。include_tables=True 时
        把表格按行拼接为 | cell | cell | 格式（与正文交替，按文档顺序）。
        表格内段落不计入 paragraph_count（只计 body 直接子级 <w:p>）。
    样式保护说明：
        只读不写，不涉及样式。
    边界说明：
        - 空文档 -> text=""，paragraph_count=0，table_count=0，不抛。
        - include_tables=False -> 只提取 body 段落文本，跳过表格。
    """
    body = _body(doc)
    text_parts = []
    para_count = 0
    table_count = 0

    for c in body:
        tag = _local(c.tag)
        if tag == "p":
            text_parts.append(_paragraph_text(c))
            para_count += 1
        elif tag == "tbl":
            table_count += 1
            if include_tables:
                rows = c.findall(_w("tr"))
                for tr in rows:
                    cells = tr.findall(_w("tc"))
                    cell_texts = [_tc_text(tc) for tc in cells]
                    text_parts.append("| " + " | ".join(cell_texts) + " |")
        # sectPr 等其它元素跳过

    return {
        "text": "\n".join(text_parts),
        "paragraph_count": para_count,
        "table_count": table_count,
        "locator": "extract_all_text",
    }


# ============================================================================
# 公共函数 2：to_markdown（P2-11）
# ============================================================================
def to_markdown(doc, *, heading_levels: tuple = (1, 2, 3, 4, 5, 6)) -> dict:
    """
    把文档转为 Markdown 结构化表示（P2-11）。

    参数：
        doc: Document 对象或 body 元素
        heading_levels: 参与转换的标题层级 tuple（默认 1~6）

    返回：
        {markdown, outline, locator:"to_markdown"}

    依据说明：
        标题段（locator._heading_level_of 判定）转 #/##/###（按 level），
        正文段转普通行，表格转 markdown 表格（| a | b | + 分隔行 |---|）。
        outline 调用 locator.extract_outline 获取。
    样式保护说明：
        只读不写，不涉及样式。
    边界说明：
        - 空文档 -> markdown=""，outline count=0，不抛。
        - heading_levels 过滤：不在列表中的标题层级视为普通段落。
        - 标题级别 > 6 时用 ######（6 个 #）兜底。
    """
    from src.locator import extract_outline

    body = _body(doc)
    style_id_map = _style_id_to_name(doc if hasattr(doc, "part") else None)

    lines = []
    for c in body:
        tag = _local(c.tag)
        if tag == "p":
            hlv = _heading_level_of(c, style_id_map)
            text = _paragraph_text(c)
            if hlv is not None and hlv in heading_levels:
                # markdown 标题：level 1 -> #, level 2 -> ## ...
                hashes = "#" * min(hlv, 6)
                lines.append(f"{hashes} {text}")
            else:
                lines.append(text)
        elif tag == "tbl":
            md_table = _table_to_markdown(c)
            if md_table:
                lines.append(md_table)
        # sectPr 等跳过

    outline_result = extract_outline(doc, levels=heading_levels)

    return {
        "markdown": "\n".join(lines),
        "outline": outline_result["outline"],
        "locator": "to_markdown",
    }


# ============================================================================
# 页眉页脚读取（P0-3 配套：文本级读取，非 mutate）
# ============================================================================

# header/footer part 的关系类型
REL_HEADER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"
REL_FOOTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"

# relationships 命名空间（取 r:id）
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# which(对外 API) -> OOXML headerReference/footerReference 的 @w:type
_HF_WHICH_TO_TYPE = {
    "default": "default",
    "first_page": "first",
    "even_page": "even",
}

# which -> python-docx Section 上的代理属性名
_HF_WHICH_TO_PROXY = {
    ("header", "default"): "header",
    ("header", "first_page"): "first_page_header",
    ("header", "even_page"): "even_page_header",
    ("footer", "default"): "footer",
    ("footer", "first_page"): "first_page_footer",
    ("footer", "even_page"): "even_page_footer",
}


def _hf_validate_which(which: str) -> str:
    if which not in _HF_WHICH_TO_TYPE:
        raise ValueError(
            f"which 必须为 default/first_page/even_page，实得 {which!r}")
    return which


def _hf_proxy(section, kind: str, which: str):
    """取 python-docx 的 header/footer 代理（仅用于读 is_linked_to_previous）。"""
    return getattr(section, _HF_WHICH_TO_PROXY[(kind, which)])


def _read_hf_part_text(doc, section, kind: str, which: str):
    """非 mutate 读取某 section 自有 header/footer part 的段落文本。

    通过该 section 的 sectPr 上的 headerReference/footerReference 取 rId，
    解析到 target_part.element（<w:hdr>/<w:ftr> root），用 _paragraph_text
    拼接。全程不访问 python-docx 代理的 .paragraphs/._element（会触发 part 创建）。
    part 不存在（无对应 reference）返回 (None, 0)：表示该 section 此 kind/which
    无自有 part。
    返回 (text, paragraph_count)。
    """
    sectpr = section._sectPr
    ref_local = "headerReference" if kind == "header" else "footerReference"
    want_type = _HF_WHICH_TO_TYPE[which]
    rId = None
    for ref in sectpr.findall(_w(ref_local)):
        if ref.get(_w("type")) == want_type:
            rId = ref.get(f"{{{_R_NS}}}id")
            break
    if rId is None:
        return None, 0  # 该 section 无此 kind/which 的自有 part
    rel = doc.part.rels[rId]
    target = rel.target_part
    root = target.element  # <w:hdr>/<w:ftr> root，已存在的 part 不 mutate
    paras = root.findall(_w("p"))
    text = "\n".join(_paragraph_text(p) for p in paras)
    return text, len(paras)


def _hf_effective_text(doc, section_index: int, kind: str, which: str):
    """取某 section 的 effective header/footer 文本（含 linked 继承回溯）。

    返回 (text, paragraph_count, linked, has_part)：
      - linked：目标 section（section_index）自身是否 linked（继承自前节）。
      - has_part：回溯链上是否找到提供文本的自有 part（目标或更前 section）。
        True=有 part 提供文本（text 非空或 part 存在）；False=整条链都 linked，
        无任何 part（text=""）。
    语义：linked 表示「该 section 没有自己的 part，文本是继承来的」；
          has_part 表示「能否取到实际文本」（区分「继承到空」与「根本没有 part」）。
    """
    sections = doc.sections
    if section_index < 0 or section_index >= len(sections):
        raise ReaderError(
            f"section_index 越界：{section_index}（共 {len(sections)} 个 section）")
    # 目标 section 自身是否 linked（决定 linked 字段）
    target_proxy = _hf_proxy(sections[section_index], kind, which)
    target_linked = target_proxy.is_linked_to_previous  # getter 非 mutate
    # 回溯找首个非 linked 的 section（提供 effective 文本）
    idx = section_index
    while idx >= 0:
        sec = sections[idx]
        proxy = _hf_proxy(sec, kind, which)
        if not proxy.is_linked_to_previous:
            text, pcount = _read_hf_part_text(doc, sec, kind, which)
            if text is None:
                # 标记非 linked 但找不到 reference（理论不应发生）-> 视为无 part
                return "", 0, target_linked, False
            return text, pcount, target_linked, True
        idx -= 1
    # 整条链都 linked（含首 section linked -> 渲染为空）
    return "", 0, target_linked, False


def get_header_text(doc, *, section_index: int = 0,
                    which: str = "default") -> dict:
    """
    读取页眉文本（非 mutate，P0-3 配套）。

    参数：
        doc: Document 对象（须为 Document，不接受 bare body）
        section_index: section 索引（0 基），默认 0
        which: default / first_page / even_page（对应 headerReference 的 @w:type
               default/first/even）。default=常规页眉，first_page=首页页眉
               （需 sectPr 含 titlePg），even_page=偶数页页眉（需 evenAndOddHeaders）

    返回：
        {text, paragraph_count, section_index, which, linked:bool, has_part:bool,
         locator:"get_header_text"}

    依据说明：
        linked 继承：目标 section 无自有 part（is_linked_to_previous=True）时，
        向更前 section 回溯取同 kind/which 的 effective 文本（Word 的继承语义）；
        回溯到头仍无（首 section 也 linked）-> text=""。
        文本用 _paragraph_text 拼接（与 extract_all_text 同口径，含 hyperlink 内 run）。
        全程通过 sectPr 的 headerReference 取 rId->target_part.element 读取，
        **不访问 python-docx 代理的 .paragraphs/._element**（对 linked 代理会触发
        part 创建，属 mutate，读操作必须避免）。
    样式保护说明：
        只读不写，不创建/修改任何 part、不动 sectPr、不动 rels。
    边界说明：
        - doc 非 Document（如 bare body）-> 抛 ReaderError。
        - section_index 越界 -> 抛 ReaderError。
        - which 非法 -> 抛 ValueError。
        - 无自有 part 且无可继承 -> text=""，has_part=False，linked=True，不抛。
    """
    if not hasattr(doc, "sections"):
        raise ReaderError("get_header_text 需要 Document 对象（含 .sections）")
    _hf_validate_which(which)
    text, pcount, linked, has_part = _hf_effective_text(
        doc, section_index, "header", which)
    return {
        "text": text,
        "paragraph_count": pcount,
        "section_index": section_index,
        "which": which,
        "linked": linked,
        "has_part": has_part,
        "locator": "get_header_text",
    }


def get_footer_text(doc, *, section_index: int = 0,
                    which: str = "default") -> dict:
    """
    读取页脚文本（非 mutate，P0-3 配套）。语义同 get_header_text，kind=footer。

    参数：
        doc: Document 对象
        section_index: section 索引（0 基），默认 0
        which: default / first_page / even_page

    返回：
        {text, paragraph_count, section_index, which, linked:bool, has_part:bool,
         locator:"get_footer_text"}

    依据说明：
        同 get_header_text，区别仅 kind=footer（footerReference / footer part）。
    样式保护说明：
        只读不写，不创建/修改任何 part、不动 sectPr、不动 rels。
    边界说明：
        - doc 非 Document -> 抛 ReaderError。
        - section_index 越界 -> 抛 ReaderError。
        - which 非法 -> 抛 ValueError。
        - 无自有 part 且无可继承 -> text=""，has_part=False，linked=True，不抛。
    """
    if not hasattr(doc, "sections"):
        raise ReaderError("get_footer_text 需要 Document 对象（含 .sections）")
    _hf_validate_which(which)
    text, pcount, linked, has_part = _hf_effective_text(
        doc, section_index, "footer", which)
    return {
        "text": text,
        "paragraph_count": pcount,
        "section_index": section_index,
        "which": which,
        "linked": linked,
        "has_part": has_part,
        "locator": "get_footer_text",
    }


# ============================================================================
# 自测
# ============================================================================
def _self_test():
    import os
    from docx import Document
    from src.verifier import validate_openable

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    # ---- 测试1：extract_all_text base.docx ----
    doc = Document(BASE)
    r = extract_all_text(doc)
    assert "正文宋体四号" in r["text"], "文本应含「正文宋体四号」"
    assert r["paragraph_count"] > 0, f"paragraph_count 应 >0，实得 {r['paragraph_count']}"
    assert r["table_count"] == 1, f"table_count 应=1，实得 {r['table_count']}"
    # 表格文本应在 include_tables=True 时出现
    assert "C1" in r["text"], "文本应含表格内容 C1"
    print(f"[测试1 通过] extract_all_text -> paragraph_count={r['paragraph_count']}, table_count={r['table_count']}")

    # ---- 测试2：extract_all_text include_tables=False ----
    doc = Document(BASE)
    r = extract_all_text(doc, include_tables=False)
    assert "C1" not in r["text"], "include_tables=False 时文本不应含表格内容"
    assert r["table_count"] == 1, "table_count 仍应=1（计数不受 include_tables 影响）"
    print(f"[测试2 通过] extract_all_text include_tables=False -> 表格内容跳过")

    # ---- 测试3：to_markdown base.docx ----
    doc = Document(BASE)
    r = to_markdown(doc)
    md = r["markdown"]
    # 标题行
    assert "# 标题1" in md, f"markdown 应含 '# 标题1'，实得片段: {md[:300]!r}"
    assert "## 标题2" in md, f"markdown 应含 '## 标题2'"
    assert "### 标题3" in md, f"markdown 应含 '### 标题3'"
    # 表格分隔行
    assert "| --- |" in md or "|---|" in md, \
        f"markdown 应含表格分隔行 '|---|'"
    # 正文
    assert "正文宋体四号" in md, "markdown 应含正文"
    # outline
    assert len(r["outline"]) >= 3, f"outline 应 >=3 条，实得 {len(r['outline'])}"
    print(f"[测试3 通过] to_markdown -> 含标题(#/##/###) + 表格分隔行 + outline {len(r['outline'])} 条")

    # ---- 测试4：to_markdown 空文档 ----
    from docx import Document as Doc
    doc = Doc()
    r = to_markdown(doc)
    assert r["markdown"] == "", f"空文档 markdown 应空，实得 {r['markdown']!r}"
    assert r["outline"] == [], "空文档 outline 应空"
    r2 = extract_all_text(doc)
    assert r2["text"] == "", "空文档 text 应空"
    assert r2["paragraph_count"] == 0
    assert r2["table_count"] == 0
    print(f"[测试4 通过] 空文档 -> markdown='' text='' 不抛")

    # ---- 测试5：to_markdown 烟草招标.docx（outlineLvl 标题）----
    tobacco_path = "input/烟草招标.docx"
    if os.path.exists(tobacco_path):
        doc = Document(tobacco_path)
        r = to_markdown(doc)
        assert "# " in r["markdown"] or "## " in r["markdown"], \
            "烟草招标 markdown 应含标题行"
        assert len(r["outline"]) > 0, "烟草招标 outline 应 >0"
        print(f"[测试5 通过] to_markdown 烟草招标.docx -> outline {len(r['outline'])} 条")

    # ---- 测试6：get_header_text / get_footer_text base.docx（全 linked，空）----
    doc = Document(BASE)
    rh = get_header_text(doc)
    rf = get_footer_text(doc)
    assert rh["text"] == "", f"base 无 header part，应空，实得 {rh['text']!r}"
    assert rf["text"] == "", f"base 无 footer part，应空，实得 {rf['text']!r}"
    assert rh["linked"] is True and rh["has_part"] is False, rh
    assert rf["linked"] is True and rf["has_part"] is False, rf
    # 读操作不应创建 part（非 mutate 校验）
    hf_rels = [rel for rel in doc.part.rels.values()
               if "header" in rel.reltype or "footer" in rel.reltype]
    assert not hf_rels, f"读操作不应创建 header/footer part，实得 {len(hf_rels)} 个"
    print(f"[测试6 通过] get_header_text/get_footer_text base -> 空(linked)，非 mutate")

    # ---- 测试7：写入后读回往返（用 structure.set_footer_text 构造场景）----
    from src.structure import set_footer_text, set_header_text
    doc = Document(BASE)
    set_footer_text(doc, "机密文档", align="center")
    set_header_text(doc, "公司名称", which="default")
    rf = get_footer_text(doc)
    rh = get_header_text(doc)
    assert rf["text"] == "机密文档", f"页脚应=机密文档，实得 {rf['text']!r}"
    assert rh["text"] == "公司名称", f"页眉应=公司名称，实得 {rh['text']!r}"
    assert rf["has_part"] is True and rf["linked"] is False, rf
    assert rh["has_part"] is True and rh["linked"] is False, rh
    assert rf["paragraph_count"] >= 1, rf
    print(f"[测试7 通过] 往返：set 后 get 读回页眉=公司名称 页脚=机密文档，has_part=True")

    # ---- 测试8：which=first_page / even_page + 边界 ----
    doc = Document(BASE)
    set_footer_text(doc, "首页页脚", which="first_page")
    rf_first = get_footer_text(doc, which="first_page")
    assert rf_first["text"] == "首页页脚", rf_first
    # default 仍空（first_page 是独立 part）
    rf_def = get_footer_text(doc, which="default")
    assert rf_def["text"] == "", rf_def
    print(f"[测试8 通过] which=first_page 独立 part：首页页脚有，default 空")
    # 边界：which 非法 -> ValueError
    try:
        get_footer_text(doc, which="bogus")
        raised = False
    except ValueError:
        raised = True
    assert raised, "which 非法应抛 ValueError"
    # 边界：section_index 越界 -> ReaderError
    try:
        get_footer_text(doc, section_index=99)
        raised = False
    except ReaderError:
        raised = True
    assert raised, "section_index 越界应抛 ReaderError"
    print(f"[测试8 通过] 边界：which 非法抛 ValueError；section_index 越界抛 ReaderError")

    # ---- 测试9：多 section linked 继承回溯 ----
    doc = Document(BASE)
    # section 0 设 default footer，再加一个 section（继承 section 0）
    set_footer_text(doc, "第一节的页脚", section_index=0)
    from docx.enum.section import WD_SECTION_START
    doc.add_section(WD_SECTION_START.NEW_PAGE)
    # 新 section 的 footer 默认 linked 到前一节
    sec1_footer = doc.sections[1].footer
    assert sec1_footer.is_linked_to_previous is True, "新 section footer 应 linked"
    rf_sec1 = get_footer_text(doc, section_index=1)
    assert rf_sec1["text"] == "第一节的页脚", \
        f"section 1 linked 应继承 section 0 的页脚，实得 {rf_sec1['text']!r}"
    assert rf_sec1["linked"] is True, "linked 标志应为 True（继承自前节）"
    print(f"[测试9 通过] 多 section：section 1 linked 继承 section 0 的页脚文本")

    print()
    print("reader.py 自测全部通过")


if __name__ == "__main__":
    _self_test()
