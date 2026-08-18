# -*- coding: utf-8 -*-
"""
阶段2 模块3：删除器（Deleter）

定位：在 locator 锚定的位置执行"类人删除"——删除段落、删除 run（文本片段）、
删除表格行、清空表格单元格。所有删除都保证不破坏剩余内容的样式。

================================================================
开发依据（基于 base.docx 真实结构，见 logs/base_structure.md + 实测）
================================================================
1. 段落2（标题1）子元素序列：pPr, r, r, bookmarkEnd
   → 删除整段时 bookmarkEnd 随段落一起移除（它在 <w:p> 内）；
     若只删 run 保留段落，bookmarkEnd 会悬空（需调用方注意，本模块不自动清理）。
2. 段落33（批注）子元素：commentRangeStart, r, commentRangeEnd, r
   → 含批注范围标记；删除其 run 可能影响批注范围，本模块不做批注语义处理。
3. 表格结构：<w:tbl> = tblPr + tblGrid + tr×3；<w:tr> = tc×4；<w:tc> = tcPr + p。
   → 删行 = remove tr；删单元格 = remove tc（会改变列数）或清空其内段落文本。
4. body 末尾是 <w:sectPr> → 删段落时绝不能删到 sectPr（结构会损坏）。
5. 文本分散在多 run（段落9「宋体四号下划线」两个 run 各含部分文本）
   → 删"文本片段"需定位到具体 run，跨 run 的片段不在此版处理（局限）。

已确认 XML 样本（来自 base.docx 实测）。
"""

from __future__ import annotations

from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

# 兼容直接运行
import os as _os, sys as _sys
if __package__ in (None, ""):
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

from src.locator import (
    locate_by_paragraph_index,
    locate_by_text,
    locate_table_cell,
    LocateError,
)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def _local(tag) -> str:
    return etree.QName(tag).localname


class DeleterError(Exception):
    """删除失败统一异常。"""


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
    raise DeleterError(f"无法识别的 anchor 类型: {type(anchor)}")


def _run_text(r_elem) -> str:
    """单个 run 的文本（拼接其所有 <w:t>）。"""
    return "".join((t.text or "") for t in r_elem.findall(_w("t")))


def _body_index_of_p(doc, p_elem) -> int:
    """取 <w:p> 在 body 段落序列中的索引。"""
    body = doc.element.body
    idx = 0
    for c in body:
        if _local(c.tag) == "p":
            if c is p_elem:
                return idx
            idx += 1
    raise DeleterError("未在 body 中找到目标段落")


# ============================================================================
# 公共函数 1：delete_paragraph
# ============================================================================
def delete_paragraph(doc, anchor) -> dict:
    """
    删除锚点指定的整个段落（含其所有 run、bookmarkEnd 等）。

    参数：
        anchor: locator dict / 段落索引(int) / <w:p> 元素

    返回：
        {
          "doc": doc,
          "deleted_paragraph_index": int,   # 被删段落在删除前的索引
          "deleted_text": str,              # 被删段落的文本（留档）
          "locator": "delete_paragraph",
          "changes": [{"paragraph": <被删索引>, "path": None, "note": "删除段落"}]
        }

    依据说明：
        直接 remove 整个 <w:p> 节点。段落内的 bookmarkEnd/commentRangeEnd 等
        随段落一起移除（它们是 <w:p> 的子元素）。
        依据：base.docx 段落2 子元素含 bookmarkEnd，删段落=删整棵子树。
    样式保护说明：
        - 只删除目标 <w:p>，不触碰其它段落的 pPr/rPr。
        - 不删除 <w:sectPr>（强制保护：若误传 sectPr 当段落会抛异常）。
    边界说明：
        - 锚点段落是 body 最后一个段落（其后是 sectPr）-> 正常删除，sectPr 保留。
        - 锚点无法识别 -> 抛 DeleterError。
        - 删除后段落总数 -1，后续段落索引前移（调用方据此更新 expected_changes）。
        - 若段落含批注范围标记（commentRangeStart/End），删除会使批注范围失效，
          本模块不清理 comments.xml（局限，待后续处理）。
    """
    p_elem = _resolve_anchor_p(doc, anchor)
    # 保护：绝不删 sectPr
    if _local(p_elem.tag) == "sectPr":
        raise DeleterError("禁止删除 sectPr")
    idx = _body_index_of_p(doc, p_elem)
    text = "".join(_run_text(r) for r in p_elem.findall(_w("r")))
    # 超链接内文本也留档
    for hl in p_elem.findall(_w("hyperlink")):
        for r in hl.findall(_w("r")):
            text += _run_text(r)

    parent = p_elem.getparent()
    parent.remove(p_elem)

    return {
        "doc": doc,
        "deleted_paragraph_index": idx,
        "deleted_text": text,
        "locator": "delete_paragraph",
        "changes": [
            {"paragraph": idx, "path": None, "note": "删除段落（整段移除）"}
        ],
    }


# ============================================================================
# 公共函数 2：delete_run_by_text
# ============================================================================
def delete_run_by_text(doc, anchor, text: str, occurrence: int = 1) -> dict:
    """
    删除段落内"文本完全匹配"的 run（保留段落与 pPr，删除该 run 节点）。

    参数：
        anchor: 同 delete_paragraph
        text: 要删除的 run 文本（必须与某 run 的文本完全相等）
        occurrence: 第几个匹配的 run（1 基）

    返回：
        {
          "doc": doc,
          "paragraph_index": int,
          "deleted_run_index": int,         # 被删 run 在段落中的原位置
          "deleted_text": str,
          "locator": "delete_run_by_text",
          "changes": [{"paragraph": idx, "path": "runs[N]", "note": ...}]
        }

    依据说明：
        遍历段落 <w:r>，找 run_text(r) == text 的 run，remove 该 run 节点。
        依据：base.docx 段落9「宋体四号下划线」= run[0]('宋体四号') + run[1]('下划线')，
        删"下划线"即删 run[1]，run[0] 及段落 pPr 完全不动。
    样式保护说明：
        - 只删目标 <w:r>，不动其它 run、不动 pPr。
        - 不修改任何 rPr（被删 run 整体移除，其它 run 的 rPr 原样保留）。
    边界说明：
        - text 为空 -> 抛 DeleterError（空文本无法唯一定位 run）。
        - 段落内无任何 run 文本等于 text -> 抛 DeleterError。
        - occurrence 超出匹配数 -> 抛 DeleterError。
        - 删除后段落可能变成"无 run 空段落"（仍含 pPr）-> 合法，不自动删段落。
        - 跨 run 的文本片段（如"宋体下划线"横跨 run[0]+run[1]）本版不处理（局限）。
        - 超链接 <w:hyperlink> 内的 run 不在遍历范围（仅处理段落顶层 <w:r>）。
    """
    if not text:
        raise DeleterError("text 不能为空")
    p_elem = _resolve_anchor_p(doc, anchor)
    idx = _body_index_of_p(doc, p_elem)

    # 找匹配的 run
    matches = []
    for ri, r in enumerate(p_elem.findall(_w("r"))):
        if _run_text(r) == text:
            matches.append((ri, r))
    if not matches:
        raise DeleterError(f"段落{idx} 内无文本等于 {text!r} 的 run")
    if occurrence < 1 or occurrence > len(matches):
        raise DeleterError(
            f"occurrence={occurrence} 超出匹配数 {len(matches)}（文本 {text!r}）")

    run_idx, target_run = matches[occurrence - 1]
    p_elem.remove(target_run)

    return {
        "doc": doc,
        "paragraph_index": idx,
        "deleted_run_index": run_idx,
        "deleted_text": text,
        "locator": "delete_run_by_text",
        "changes": [
            {"paragraph": idx, "path": f"runs[{run_idx}]",
             "note": f"删除文本为 {text!r} 的 run"}
        ],
    }


# ============================================================================
# 公共函数 3：delete_table_row
# ============================================================================
def delete_table_row(doc, table_index: int, row: int) -> dict:
    """
    删除表格的指定行。

    参数：
        table_index: body 内 <w:tbl> 的顺序索引
        row: 行索引（0 基）

    返回：
        {
          "doc": doc,
          "table_index": int, "deleted_row": int,
          "locator": "delete_table_row",
          "changes": [{"paragraph": None, "path": f"tbl[{table_index}].tr[{row}]",
                       "note": "删除表格行"}]
        }

    依据说明：
        <w:tbl> 内 <w:tr> 按顺序排列（实测 3 行）；remove 目标 tr。
        依据：base.docx 表格0 = tblPr + tblGrid + tr×3。
    样式保护说明：
        - 只删目标 <w:tr>，不动 tblPr/tblGrid/其它行。
        - 不修改任何单元格样式。
    边界说明：
        - table_index / row 越界 -> 抛 DeleterError。
        - 删除唯一一行（表格只剩 1 行）-> 仍允许删除，但表格会变成空表
          （仅剩 tblPr+tblGrid）。若需连带删表，调用方另行处理。
        - 删除行不影响 numbering（行内段落若属列表，编号由 Word 重算）。
    """
    body = doc.element.body
    tables = [c for c in body if _local(c.tag) == "tbl"]
    if table_index < 0 or table_index >= len(tables):
        raise DeleterError(f"表格索引越界: {table_index}（共 {len(tables)} 表）")
    tbl = tables[table_index]
    rows = tbl.findall(_w("tr"))
    if row < 0 or row >= len(rows):
        raise DeleterError(f"行索引越界: {row}（共 {len(rows)} 行）")
    tbl.remove(rows[row])
    return {
        "doc": doc,
        "table_index": table_index,
        "deleted_row": row,
        "locator": "delete_table_row",
        "changes": [
            {"paragraph": None, "path": f"tbl[{table_index}].tr[{row}]",
             "note": "删除表格行"}
        ],
    }


# ============================================================================
# 公共函数 4：clear_table_cell
# ============================================================================
def clear_table_cell(doc, table_index: int, row: int, col: int,
                     remove_paragraph: bool = False) -> dict:
    """
    清空表格单元格内容（保留 tc 结构与 tcPr）。

    参数：
        table_index/row/col: 表格坐标
        remove_paragraph: False=清空单元格内各 <w:p> 的 run（保留空段落，
            符合"单元格不能没有段落"的 OOXML 约束）；
            True=删除除第一个 <w:p> 外的所有段落，并清空第一个段落的 run。

    返回：
        {
          "doc": doc, "table_index": int, "row": int, "col": int,
          "cleared_text": str,
          "locator": "clear_table_cell",
          "changes": [{"paragraph": None, "path": f"tbl[..].tc[..]", "note": ...}]
        }

    依据说明：
        <w:tc> = tcPr + 一个或多个 <w:p>（实测 tc0 = tcPr + p）。
        OOXML 规范要求每个 <w:tc> 至少含一个 <w:p> → 清空时保留一个空段落。
    样式保护说明：
        - 保留 tcPr（单元格属性：宽度/边框/底纹等）。
        - 保留至少一个 <w:p>（含其 pPr），只删其内 <w:r>。
        - 不触碰同行其它单元格。
    边界说明：
        - 坐标越界 -> 抛 DeleterError。
        - 单元格原本就空 -> 正常返回，cleared_text 为空串。
        - remove_paragraph=True 且单元格仅 1 段 -> 等价 False（保留该段并清空 run）。
    """
    loc = locate_table_cell(doc, table_index, row, col)
    tc = loc["tc_elem"]
    ps = tc.findall(_w("p"))
    cleared = loc["text"]

    if remove_paragraph and len(ps) > 1:
        # 保留第一个 p，删除其余
        for p in ps[1:]:
            tc.remove(p)
        ps = [ps[0]]
    # 清空保留段落的 run（保留 pPr）
    for p in ps:
        for r in list(p.findall(_w("r"))):
            p.remove(r)

    return {
        "doc": doc,
        "table_index": table_index, "row": row, "col": col,
        "cleared_text": cleared,
        "locator": "clear_table_cell",
        "changes": [
            {"paragraph": None,
             "path": f"tbl[{table_index}].tr[{row}].tc[{col}]",
             "note": "清空单元格内容（保留 tcPr 与空段落）"}
        ],
    }


# ============================================================================
# 自测：对 base.docx 删除，并校验样式无损
# ============================================================================
def _self_test():
    from src.verifier import (
        compare_documents, validate_openable, extract_style_fingerprint,
    )

    BASE = "input/base.docx"
    import os
    os.makedirs("output", exist_ok=True)

    # ---- 测试1：删除段落35（"内容填充"），校验其余段落零差异 ----
    # 删除会改变段落数+索引错位 -> 改用针对性校验：删除点之前的段落指纹一致
    doc = Document(BASE)
    res = delete_paragraph(doc, 35)
    assert res["deleted_text"] == "内容填充", res
    out1 = "output/deleter_test_1.docx"
    doc.save(out1)
    # 删除点之前(0~34)必须零差异
    db, da = Document(BASE), Document(out1)
    for i in range(35):
        fpb = extract_style_fingerprint(db.paragraphs[i])
        fpa = extract_style_fingerprint(da.paragraphs[i])
        assert fpb["fingerprint_sha1"] == fpa["fingerprint_sha1"], f"段落{i}样式变化"
    assert validate_openable(out1)
    assert compare_documents(BASE, out1)["styles_xml_changed"] is False
    print(f"[测试1 通过] 删除段落35「内容填充」，0~34段零差异，styles.xml 未变")

    # ---- 测试2：删除段落9的 run「下划线」（保留 run「宋体四号」与段落样式）----
    # 段落9 = run[0]('宋体四号') + run[1]('下划线')，不改变段落数 -> 全量校验
    doc = Document(BASE)
    res = delete_run_by_text(doc, 9, "下划线")
    out2 = "output/deleter_test_2.docx"
    doc.save(out2)
    result = compare_documents(BASE, out2, expected_changes=res["changes"])
    assert result["unexpected_changes"] == [], (
        f"测试2 意外改动: {result['unexpected_changes']}")
    assert validate_openable(out2)
    doc2 = Document(out2)
    p9 = doc2.paragraphs[9]
    assert p9.text == "宋体四号", p9.text  # 只剩"宋体四号"
    # 段落9 剩余 run 的 rPr 应原样保留（含下划线属性）
    rpr = p9.runs[0]._r.find(_w("rPr"))
    u = rpr.find(_w("u"))
    assert u is not None and u.get(_w("val")) == "single", "下划线样式应保留"
    print(f"[测试2 通过] 删除段落9 run「下划线」，保留「宋体四号」与下划线样式，全量校验无意外改动")

    # ---- 测试3：删除表格第1行（原行0: C1|C2|C3|C4）----
    doc = Document(BASE)
    res = delete_table_row(doc, 0, 0)
    out3 = "output/deleter_test_3.docx"
    doc.save(out3)
    assert validate_openable(out3)
    doc2 = Document(out3)
    tbl = doc2.tables[0]
    assert len(tbl.rows) == 2, f"删行后应剩2行，实得{len(tbl.rows)}"
    # 剩余首行应为原第二行 1|2|3|4
    cells = [c.text for c in tbl.rows[0].cells]
    assert cells == ["1", "2", "3", "4"], f"剩余首行应为1234，实得{cells}"
    # 表格外段落样式零差异（表格改动不影响 body 段落指纹）
    db, da = Document(BASE), Document(out3)
    for i in range(len(db.paragraphs)):
        fpb = extract_style_fingerprint(db.paragraphs[i])
        fpa = extract_style_fingerprint(da.paragraphs[i])
        assert fpb["fingerprint_sha1"] == fpa["fingerprint_sha1"], f"段落{i}样式变化"
    print(f"[测试3 通过] 删除表格行0，剩2行且首行=1234，body段落样式零差异")

    # ---- 测试4：清空单元格(0,0,0)内容（原 C1）----
    doc = Document(BASE)
    res = clear_table_cell(doc, 0, 0, 0)
    assert res["cleared_text"] == "C1", res
    out4 = "output/deleter_test_4.docx"
    doc.save(out4)
    assert validate_openable(out4)
    doc2 = Document(out4)
    tc0_text = doc2.tables[0].rows[0].cells[0].text
    assert tc0_text == "", f"清空后应空，实得{tc0_text!r}"
    # tcPr 应保留（单元格宽度等属性）
    tc = doc2.tables[0]._tbl.findall(_w("tr"))[0].findall(_w("tc"))[0]
    assert tc.find(_w("tcPr")) is not None, "tcPr 应保留"
    # 单元格仍含至少一个 <w:p>
    assert len(tc.findall(_w("p"))) >= 1, "单元格应保留至少一个空段落"
    print(f"[测试4 通过] 清空单元格(0,0,0)「C1」，保留 tcPr 与空段落")

    # ---- 边界测试 ----
    doc = Document(BASE)
    for fn, desc in [
        (lambda: delete_run_by_text(doc, 9, ""), "空文本"),
        (lambda: delete_run_by_text(doc, 9, "不存在的run文本"), "不匹配文本"),
        (lambda: delete_table_row(doc, 0, 99), "行越界"),
        (lambda: clear_table_cell(doc, 0, 9, 9), "单元格越界"),
    ]:
        try:
            fn(); raised = False
        except (DeleterError, LocateError):
            raised = True
        assert raised, f"应抛异常: {desc}"
    print(f"[边界通过] 空文本/不匹配/行越界/单元格越界 均抛异常")
    print()
    print("产出文件：output/deleter_test_1~4.docx（供人工验证）")


if __name__ == "__main__":
    _self_test()
