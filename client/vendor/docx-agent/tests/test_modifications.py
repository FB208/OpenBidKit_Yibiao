# -*- coding: utf-8 -*-
"""
阶段1 验收测试：基于 base.docx 做真实修改，保存到 output/test_{}.docx，
用 src/verifier.py 校验"除明确改动外样式无损"，校验通过后交人工验证。

每项测试独立从 base.docx 全新加载，互不污染（遵循 CLAUDE.md 测试独立性）。
"""
import os
import sys

# 让脚本能导入上级 src 目录
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from docx import Document
from docx.oxml.ns import qn
from copy import deepcopy

from src.verifier import (
    compare_documents,
    validate_openable,
    extract_style_fingerprint,
)

BASE = "input/base.docx"
OUT_DIR = "output"


def _save(doc, name) -> str:
    path = os.path.join(OUT_DIR, name)
    doc.save(path)
    return path


def _set_run_text(run_elem, new_text: str):
    """把一个 <w:r> 的文本设为 new_text，保留其 rPr 与其它子元素不变。

    做法：删除原有所有 <w:t>，新建一个 <w:t> 放在 rPr 之后（rPr 必须是 run 的第一个子元素）。
    """
    rpr = run_elem.find(qn("w:rPr"))
    # 删除旧 t
    for t in run_elem.findall(qn("w:t")):
        run_elem.remove(t)
    # 新建 t（xml:space="preserve" 防止首尾空格丢失）
    t = run_elem.makeelement(qn("w:t"), {qn("xml:space"): "preserve"})
    t.text = new_text
    # 插入位置：rPr 之后；若无 rPr 则插到最前
    if rpr is not None:
        rpr.addnext(t)
    else:
        run_elem.insert(0, t)


# ============================================================================
# 测试1：纯文本替换（保样式）—— 段落[35] "内容填充" -> "内容已填充"
# ============================================================================
def test_1_text_replace_preserve_style():
    name = "test_1.docx"
    doc = Document(BASE)
    p = doc.paragraphs[35]
    assert p.text == "内容填充", f"段落35文本不符预期，实得: {p.text!r}"

    # 段落35是单 run，直接改其 <w:t>
    run_elem = p.runs[0]._r
    _set_run_text(run_elem, "内容已填充")

    path = _save(doc, name)

    # 校验：文本变了但样式指纹应完全不变 -> unexpected 必为空
    result = compare_documents(BASE, path, expected_changes=None)
    assert result["unexpected_changes"] == [], (
        f"test_1 纯文本替换不应破坏样式，实得意外改动: {result['unexpected_changes']}"
    )
    assert result["styles_xml_changed"] is False
    assert validate_openable(path) is True

    print(f"[test_1 通过] {name}：段落35 文本「内容填充」->「内容已填充」，样式零差异")
    return path, result


# ============================================================================
# 测试2：多 run 文本替换（保样式）—— 段落[11] "宋体四号字体红色" 改文本，保留 color=EE0000
# ============================================================================
def test_2_multirun_text_replace_preserve_style():
    name = "test_2.docx"
    doc = Document(BASE)
    p = doc.paragraphs[11]
    assert p.text == "宋体四号字体红色", f"段落11文本不符，实得: {p.text!r}"

    # 段落11是两个 run：run[0]='宋体四号' run[1]='字体红色'，均带 color=EE0000
    runs = p.runs
    assert len(runs) == 2, f"段落11应为2个run，实得{len(runs)}"
    _set_run_text(runs[0]._r, "红色")
    _set_run_text(runs[1]._r, "文字测试")

    path = _save(doc, name)

    # 文本变了，但 rPr 全保留 -> unexpected 必为空
    result = compare_documents(BASE, path, expected_changes=None)
    assert result["unexpected_changes"] == [], (
        f"test_2 多run文本替换不应破坏样式，实得: {result['unexpected_changes']}"
    )
    assert result["styles_xml_changed"] is False
    assert validate_openable(path) is True

    # 复核：新文档段落11仍应保留红色
    doc2 = Document(path)
    rpr = doc2.paragraphs[11].runs[0]._r.find(qn("w:rPr"))
    color = rpr.find(qn("w:color"))
    assert color is not None and color.get(qn("w:val")) == "EE0000", "红色应保留"

    print(f"[test_2 通过] {name}：段落11 文本改为「红色文字测试」，color=EE0000 等样式全保留")
    return path, result


# ============================================================================
# 测试3：显式改样式并声明预期 —— 段落[7] 字号 28->32
# ============================================================================
def test_3_intentional_style_change_declared():
    name = "test_3.docx"
    doc = Document(BASE)
    p = doc.paragraphs[7]
    assert p.text == "正文宋体四号", f"段落7文本不符，实得: {p.text!r}"

    # 改 run 字号 28 -> 32
    run_rpr = p.runs[0]._r.find(qn("w:rPr"))
    sz = run_rpr.find(qn("w:sz"))
    assert sz.get(qn("w:val")) == "28", f"段落7字号应为28，实得{sz.get(qn('w:val'))}"
    sz.set(qn("w:val"), "32")
    # 同步 szCs 保持一致（Word 通常成对）
    szcs = run_rpr.find(qn("w:szCs"))
    if szcs is not None:
        szcs.set(qn("w:val"), "32")

    path = _save(doc, name)

    # 声明预期：段落7 的 runs[0].rPr.sz 与 szCs 改动
    expected = [
        {"paragraph": 7, "path": "runs[0].rPr.sz", "note": "字号28->32"},
        {"paragraph": 7, "path": "runs[0].rPr.szCs", "note": "字号28->32"},
    ]
    result = compare_documents(BASE, path, expected_changes=expected)
    assert result["unexpected_changes"] == [], (
        f"test_3 声明预期后不应有意外改动，实得: {result['unexpected_changes']}"
    )
    # 预期放行清单应记录到这两处
    paths_applied = {(d["paragraph"], d["path"]) for d in result["expected_applied"]}
    assert (7, "runs[0].rPr.sz") in paths_applied, "应放行 sz"
    assert (7, "runs[0].rPr.szCs") in paths_applied, "应放行 szCs"
    assert validate_openable(path) is True

    print(f"[test_3 通过] {name}：段落7 字号 28->32，已声明预期，其余样式零差异")
    return path, result


# ============================================================================
# 主流程
# ============================================================================
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("=" * 60)
    print("阶段1 验收测试：基于 base.docx 修改 -> output/test_{}.docx")
    print("=" * 60)
    print()

    tests = [
        test_1_text_replace_preserve_style,
        test_2_multirun_text_replace_preserve_style,
        test_3_intentional_style_change_declared,
    ]
    summary = []
    for t in tests:
        path, result = t()
        summary.append((os.path.basename(path), result["summary"]))
        print(f"  -> 校验摘要: {result['summary']}")
        print(f"  -> 可打开: {validate_openable(path)}")
        print()

    print("=" * 60)
    print("全部测试通过。产出文件：")
    for name, summ in summary:
        print(f"  output/{name}  （{summ}）")
    print()
    print("请人工用 Word 打开上述文件，确认修改符合预期、样式无损。")
    print("校验通过，停止，等待人工验证。")


if __name__ == "__main__":
    main()
