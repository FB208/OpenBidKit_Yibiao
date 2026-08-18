# -*- coding: utf-8 -*-
"""
阶段4：测试执行器 run_tests.py

遍历 tests/test_cases.json 中每个测试项：
  1. 从 input/base.docx 全新加载文档（测试独立性）
  2. 执行对应工具函数
  3. 保存产出到 output/{id}_{name}/：result.docx / before_after.xml / style_report.json / summary.md
  4. 执行 assertions，记录 pass/fail
最后生成 output/OVERVIEW.md 汇总表。

设计：
  - TestRunner：单条测试的执行上下文（持有 before/after 文档、函数返回值、verifier 结果）
  - AssertionChecker：46 种断言类型的判定器，每类一个方法
  - 函数分发：target_function 字符串 -> 实际可调用对象
  - 跨文档测试与 verifier 测试有特殊处理（不适用标准 before/after 流程）
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import traceback
import zipfile
from copy import deepcopy
from typing import Any

# 项目根加入路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

from src import locator, writer, deleter, clipboard, structure
from src.verifier import (
    compare_documents, validate_openable, extract_style_fingerprint,
    _styles_xml_changed, VerifierError, check_structure,
)
from src._xdoc import max_bookmark_id
from src import comments, reader

BASE = os.path.join(ROOT, "input", "base.docx")
TARGET_PLAIN = os.path.join(ROOT, "input", "target_plain.docx")
CASES_PATH = os.path.join(ROOT, "tests", "test_cases.json")
OUTPUT_DIR = os.path.join(ROOT, "output")

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _w(n): return f"{{{W_NS}}}{n}"
def _r(n): return f"{{{R_NS}}}{n}"
def _local(t): return etree.QName(t).localname


# ============================================================================
# 函数分发表：target_function 字符串 -> 可调用对象
# ============================================================================
FUNC_MAP = {
    "locator.locate_by_paragraph_index": locator.locate_by_paragraph_index,
    "locator.locate_by_text": locator.locate_by_text,
    "locator.locate_by_heading_level": locator.locate_by_heading_level,
    "locator.locate_by_bookmark": locator.locate_by_bookmark,
    "locator.locate_table_cell": locator.locate_table_cell,
    "writer.insert_paragraph_after": writer.insert_paragraph_after,
    "writer.append_text_to_paragraph": writer.append_text_to_paragraph,
    "writer.insert_text_at_anchor": writer.insert_text_at_anchor,
    "writer.insert_table_row": writer.insert_table_row,
    "writer.set_table_cell_text": writer.set_table_cell_text,
    "deleter.delete_paragraph": deleter.delete_paragraph,
    "deleter.delete_run_by_text": deleter.delete_run_by_text,
    "deleter.delete_table_row": deleter.delete_table_row,
    "deleter.clear_table_cell": deleter.clear_table_cell,
    "clipboard.copy_paragraph_after": clipboard.copy_paragraph_after,
    "clipboard.copy_run_to_paragraph": clipboard.copy_run_to_paragraph,
    "clipboard.copy_table_cell_to_cell": clipboard.copy_table_cell_to_cell,
    "clipboard.copy_paragraph_across_docs": clipboard.copy_paragraph_across_docs,
    "verifier.compare_documents": compare_documents,
    "verifier.extract_style_fingerprint": extract_style_fingerprint,
    "verifier.validate_openable": validate_openable,
    # 语义层函数
    "locator.locate_by_heading": locator.locate_by_heading,
    "locator.locate_in_section": locator.locate_in_section,
    "locator.locate_table_by_header": locator.locate_table_by_header,
    "writer.replace_all_placeholders": writer.replace_all_placeholders,
    "writer.set_paragraph_text": writer.set_paragraph_text,
    "writer.set_cell_by_label": writer.set_cell_by_label,
    "structure.add_page_break_before": structure.add_page_break_before,
    "structure.remove_page_break": structure.remove_page_break,
    "structure.remove_section_break": structure.remove_section_break,
    "structure.delete_range": structure.delete_range,
    "structure.delete_section": structure.delete_section,
    "structure.insert_toc_field": structure.insert_toc_field,
    "structure.merge_documents": structure.merge_documents,
    "structure.renumber_headings": structure.renumber_headings,
    "clipboard.copy_table_across_docs": clipboard.copy_table_across_docs,
    "clipboard.copy_range_across_docs": clipboard.copy_range_across_docs,
    "verifier.check_structure": check_structure,
    # P0-5 / P1-6 / P1-9 writer 新增
    "writer.insert_image": writer.insert_image,
    "writer.set_table_column_widths": writer.set_table_column_widths,
    "writer.set_row_height": writer.set_row_height,
    "writer.shade_cell": writer.shade_cell,
    "writer.set_table_borders": writer.set_table_borders,
    "writer.set_repeat_header_row": writer.set_repeat_header_row,
    "writer.create_paragraph_style": writer.create_paragraph_style,
    "writer.apply_style": writer.apply_style,
    "writer.set_run_font": writer.set_run_font,
    # P1-8 批注
    "comments.add_comment": comments.add_comment,
    "comments.list_comments": comments.list_comments,
    "comments.delete_comment": comments.delete_comment,
    # P2-10/11 大纲提取 + 结构化导出
    "locator.extract_outline": locator.extract_outline,
    "reader.extract_all_text": reader.extract_all_text,
    "reader.to_markdown": reader.to_markdown,
    # 页眉页脚文本读写
    "reader.get_header_text": reader.get_header_text,
    "reader.get_footer_text": reader.get_footer_text,
    "structure.set_header_text": structure.set_header_text,
    "structure.set_footer_text": structure.set_footer_text,
}


# ============================================================================
# TestRunner：单条测试的执行上下文
# ============================================================================
class TestRunner:
    def __init__(self, tid: str, case: dict):
        self.tid = tid
        self.case = case
        self.input = case["input"]
        self.func_name = case["target_function"]
        self.func = FUNC_MAP.get(self.func_name)

        # 执行产物
        self.before_doc = None        # 操作前文档（base 副本）
        self.after_doc = None         # 操作后文档
        self.result_path = None       # result.docx 路径
        self.ret = None               # 函数返回值
        self.raised_exc = None        # 抛出的异常
        self.style_report = None      # verifier 结果
        self.xdoc_output = None       # 跨文档测试的输出路径

    # ---- 执行被测函数 ----
    def run_function(self):
        if self.func is None:
            self.raised_exc = ValueError(f"未知函数: {self.func_name}")
            return

        inp = self.input

        # 特殊场景：verifier 类测试不加载 base.docx 流程
        if self.func_name == "verifier.validate_openable":
            self._run_validate_openable()
            return
        if self.func_name == "verifier.compare_documents":
            self._run_compare_documents()
            return
        if self.func_name == "verifier.extract_style_fingerprint":
            self._run_fingerprint()
            return

        # 跨文档复制
        if self.func_name == "clipboard.copy_paragraph_across_docs":
            self._run_xdoc()
            return

        # 整表跨文档复制
        if self.func_name == "clipboard.copy_table_across_docs":
            self._run_xdoc_table()
            return

        # 范围跨文档复制
        if self.func_name == "clipboard.copy_range_across_docs":
            self._run_xdoc_range()
            return

        # 文档合并
        if self.func_name == "structure.merge_documents":
            self._run_merge()
            return

        # 标准流程：加载 base（或自定义 doc_path）
        doc_src = BASE
        if "doc_path" in self.input:
            dp = self.input["doc_path"]
            doc_src = dp if os.path.isabs(dp) else os.path.join(ROOT, dp)
        self.before_doc = Document(doc_src)
        self.after_doc = self.before_doc  # 同一文档，原地修改

        # 解析 input 为函数实参
        kwargs = self._build_kwargs(inp)

        # 组合操作的前置（如 pre_clear / crud_roundtrip）
        self._apply_pre_steps(inp)

        try:
            self.ret = self.func(self.after_doc, **kwargs)
        except Exception as e:
            self.raised_exc = e
            return

        # 组合操作的后置（then_insert / then_fill / crud_roundtrip）
        self._apply_post_steps(inp)

    # ---- 把 input dict 转成函数 kwargs ----
    def _build_kwargs(self, inp: dict) -> dict:
        # 跨文档与 verifier 已单独处理
        if self.func_name in (
            "writer.insert_paragraph_after", "writer.append_text_to_paragraph",
            "deleter.delete_paragraph", "deleter.delete_run_by_text",
            "clipboard.copy_paragraph_after", "clipboard.copy_run_to_paragraph",
        ):
            kw = dict(inp)
            # 锚点为 dict 形式时（T028）：先用 locate_by_text 解析
            if "anchor" in kw and isinstance(kw["anchor"], dict) and \
               kw["anchor"].get("type") == "locator_dict":
                loc = locator.locate_by_text(
                    self.after_doc, kw["anchor"]["anchor_text"])
                kw["anchor"] = loc
            # source_paragraph/target_paragraph 可能是索引
            return kw

        if self.func_name == "writer.insert_text_at_anchor":
            return dict(inp)
        if self.func_name == "writer.insert_table_row":
            kw = dict(inp)
            kw.pop("then_fill", None)
            return kw
        if self.func_name == "writer.set_table_cell_text":
            kw = dict(inp)
            kw.pop("pre_clear", None)
            kw.pop("crud_roundtrip", None)
            return kw
        if self.func_name == "deleter.delete_table_row":
            kw = dict(inp)
            kw.pop("then_insert", None)
            return kw

        # 语义层函数：剥离测试专用字段（pre_setup 等在 _apply_pre_steps 处理）
        SEMANTIC_FUNCS_WITH_ANCHOR = (
            "writer.replace_all_placeholders", "writer.set_paragraph_text",
            "structure.add_page_break_before", "structure.remove_page_break",
            "structure.remove_section_break", "structure.insert_toc_field",
        )
        if self.func_name in SEMANTIC_FUNCS_WITH_ANCHOR:
            kw = {k: v for k, v in inp.items() if k != "pre_setup"}
            # anchor dict 解析（语义层支持 locator_dict / locator_heading）
            if "anchor" in kw and isinstance(kw["anchor"], dict):
                kw["anchor"] = self._resolve_anchor_dict(kw["anchor"])
            return kw

        if self.func_name == "structure.delete_range":
            kw = {k: v for k, v in inp.items()
                   if k not in ("pre_setup",)}
            for ak in ("start_anchor", "end_anchor_exclusive"):
                if ak in kw and kw[ak] is not None and isinstance(kw[ak], dict):
                    kw[ak] = self._resolve_anchor_dict(kw[ak])
            return kw

        if self.func_name == "structure.delete_section":
            kw = {k: v for k, v in inp.items() if k != "pre_setup"}
            return kw

        if self.func_name == "writer.set_cell_by_label":
            kw = {k: v for k, v in inp.items()
                   if k not in ("pre_setup",)}
            return kw

        if self.func_name == "verifier.check_structure":
            # check_structure 全部用关键字参数（h1_titles 等是 kw-only）
            kw = {k: v for k, v in inp.items() if k != "pre_setup"}
            return kw

        # P0-4：renumber_headings（doc_path 是测试专用字段）
        if self.func_name in (
            "structure.renumber_headings",
        ):
            kw = {k: v for k, v in inp.items()
                  if k not in ("doc_path",)}
            return kw

        # P0-5 / P1-9：insert_image / apply_style / set_run_font（含 anchor + pre_setup）
        if self.func_name in (
            "writer.insert_image", "writer.apply_style", "writer.set_run_font",
        ):
            kw = {k: v for k, v in inp.items()
                  if k not in ("pre_setup", "doc_path")}
            if "anchor" in kw and isinstance(kw["anchor"], dict):
                kw["anchor"] = self._resolve_anchor_dict(kw["anchor"])
            # insert_image 的 image_path 可能是相对路径，转为绝对
            if "image_path" in kw and not os.path.isabs(kw["image_path"]):
                kw["image_path"] = os.path.join(ROOT, kw["image_path"])
            # width_pt -> Inches(width_pt)
            if "width_pt" in kw:
                from docx.shared import Inches
                kw["width"] = Inches(kw.pop("width_pt"))
            return kw

        # P1-6 / P1-9 表格格式/样式创作函数：透传（剥离 pre_setup）
        if self.func_name in (
            "writer.set_table_column_widths", "writer.set_row_height",
            "writer.shade_cell", "writer.set_table_borders",
            "writer.set_repeat_header_row", "writer.create_paragraph_style",
        ):
            kw = {k: v for k, v in inp.items()
                  if k not in ("pre_setup", "doc_path")}
            # widths_pt -> [Inches(w) for w in widths_pt]
            if "widths_pt" in kw:
                from docx.shared import Inches
                kw["widths"] = [Inches(w) for w in kw.pop("widths_pt")]
            # height_pt -> Inches(height_pt)
            if "height_pt" in kw:
                from docx.shared import Inches
                kw["height"] = Inches(kw.pop("height_pt"))
            return kw

        # P1-8 批注 / P2-10/11 大纲导出：剥离 doc_path（已在标准流程处理）
        if self.func_name in (
            "comments.add_comment", "comments.list_comments",
            "comments.delete_comment",
            "locator.extract_outline",
            "reader.extract_all_text", "reader.to_markdown",
        ):
            return {k: v for k, v in inp.items() if k != "doc_path"}

        # locator 类、clear_table_cell、copy_table_cell_to_cell：直接透传
        return dict(inp)

    def _resolve_anchor_dict(self, anchor_spec):
        """把 input 中 anchor 的 dict 规格解析为 locator 返回的 dict（含 p_elem）。
        支持 type:
          - locator_dict / locator_text -> locate_by_text(anchor_text)
          - locator_heading -> locate_by_heading(text=, level=)
          - locator_paragraph_index -> locate_by_paragraph_index(index)
        int / <w:p> 直接返回。
        """
        if not isinstance(anchor_spec, dict):
            return anchor_spec
        typ = anchor_spec.get("type")
        if typ in ("locator_dict", "locator_text"):
            return locator.locate_by_text(
                self.after_doc, anchor_spec["anchor_text"])
        if typ == "locator_heading":
            return locator.locate_by_heading(
                self.after_doc, text=anchor_spec.get("text"),
                level=anchor_spec.get("level", 1))
        if typ == "locator_paragraph_index":
            return locator.locate_by_paragraph_index(
                self.after_doc, anchor_spec["index"])
        # 兼容：若已是 locator 返回结构（含 p_elem）直接用
        if "p_elem" in anchor_spec:
            return anchor_spec
        return anchor_spec

    # ---- 前置步骤 ----
    def _apply_pre_steps(self, inp: dict):
        if self.func_name == "writer.set_table_cell_text" and inp.get("pre_clear"):
            deleter.clear_table_cell(
                self.after_doc, inp["table_index"], inp["row"], inp["col"])

        # 语义层测试前置：pre_setup 是一系列构造场景的操作
        if inp.get("pre_setup"):
            for step in inp["pre_setup"]:
                self._apply_setup_step(step)

    def _apply_setup_step(self, step):
        """执行一个 pre_setup 构造步骤。"""
        op = step["op"]
        if op == "insert_paragraph_after":
            writer.insert_paragraph_after(
                self.after_doc, step["anchor"], step.get("text", ""),
                inherit_style=step.get("inherit_style", True))
        elif op == "append_run":
            # 在指定段落后插一个含 <w:br type=page> 的 run 段落
            writer.insert_paragraph_after(
                self.after_doc, step["anchor"], "", inherit_style=True)
            # 在新段加 br（由 step 指定段索引）
            # 注意：此时段落数已变，step["paragraph"] 指的是操作后索引
            target_idx = step.get("paragraph")
            if target_idx is not None:
                p_elem = self.after_doc.paragraphs[target_idx]._p
                r = p_elem.makeelement(_w("r"), {})
                br = p_elem.makeelement(_w("br"), {_w("type"): "page"})
                r.append(br)
                p_elem.append(r)
        elif op == "add_inline_sectpr":
            # 给指定段落加内嵌 sectPr
            target_idx = step["paragraph"]
            p_elem = self.after_doc.paragraphs[target_idx]._p
            ppr = p_elem.find(_w("pPr"))
            if ppr is None:
                ppr = p_elem.makeelement(_w("pPr"), {})
                p_elem.insert(0, ppr)
            sect = ppr.makeelement(_w("sectPr"), {})
            ppr.append(sect)
        elif op == "add_page_break_before":
            # 给指定段落加 pageBreakBefore
            target_idx = step["paragraph"]
            p_elem = self.after_doc.paragraphs[target_idx]._p
            ppr = p_elem.find(_w("pPr"))
            if ppr is None:
                ppr = p_elem.makeelement(_w("pPr"), {})
                p_elem.insert(0, ppr)
            ppr.insert(0, ppr.makeelement(_w("pageBreakBefore"), {}))
        elif op == "add_h1_heading":
            # 插入一个 H1 标题段（pStyle=1），用于 check_structure 测试
            loc = locator.locate_by_heading_level(self.after_doc, 1)
            writer.insert_paragraph_after(
                self.after_doc, loc, step["text"], inherit_style=True)
        elif op == "create_paragraph_style":
            # 建段落样式（用于 apply_style 测试前置）
            writer.create_paragraph_style(
                self.after_doc, step["style_id"], step["name"],
                based_on=step.get("based_on", "Normal"),
                font_name=step.get("font_name"),
                font_size=step.get("font_size"),
                bold=step.get("bold"),
                color=step.get("color"),
                alignment=step.get("alignment"))
        else:
            raise ValueError(f"未知 pre_setup op: {op}")

    # ---- 后置步骤 ----
    def _apply_post_steps(self, inp: dict):
        if self.raised_exc is not None:
            return
        # T079: 新增行后填充单元格
        if self.func_name == "writer.insert_table_row" and inp.get("then_fill"):
            new_row = self.ret["new_row_index"]
            for cell in inp["then_fill"]:
                writer.set_table_cell_text(
                    self.after_doc, inp["table_index"], new_row,
                    cell["col"], cell["text"], mode="replace")
        # T092: 删行后新增行
        if self.func_name == "deleter.delete_table_row" and inp.get("then_insert"):
            ti = inp["then_insert"]
            writer.insert_table_row(
                self.after_doc, inp["table_index"],
                ti["after_row"], ti["template_row"])

    # ---- 跨文档复制 ----
    def _run_xdoc(self):
        inp = self.input
        src_path = inp["src_path"]
        if not os.path.isabs(src_path):
            src_path = os.path.join(ROOT, src_path)
        # 每次用全新目标副本
        tgt_src = inp["tgt_path"]
        if not os.path.isabs(tgt_src):
            tgt_src = os.path.join(ROOT, tgt_src)
        tmp_tgt = os.path.join(OUTPUT_DIR, f"_{self.tid}_tgt_tmp.docx")
        shutil.copy(tgt_src, tmp_tgt)

        src_anchor = inp["src_anchor"]
        tgt_anchor = inp["tgt_anchor"]
        out = inp.get("output_path") or tmp_tgt
        if not os.path.isabs(out):
            out = os.path.join(ROOT, out)
        # 确保 output 目录存在
        os.makedirs(os.path.dirname(out), exist_ok=True)

        try:
            self.ret = self.func(src_path, src_anchor, tmp_tgt, tgt_anchor,
                                 output_path=out, remap_bookmarks=True)
            self.xdoc_output = out
            # after_doc 用于断言：加载输出文档
            self.after_doc = Document(out)
            # before_doc：目标原始文档（用于对比目标内已有段落）
            self.before_doc = Document(tgt_src)
        except Exception as e:
            self.raised_exc = e

    def _resolve_path(self, p):
        if p is None:
            return None
        if not os.path.isabs(p):
            p = os.path.join(ROOT, p)
        return p

    # ---- 整表跨文档复制 ----
    def _run_xdoc_table(self):
        inp = self.input
        src_path = self._resolve_path(inp["src_path"])
        tgt_src = self._resolve_path(inp["tgt_path"])
        tmp_tgt = os.path.join(OUTPUT_DIR, f"_{self.tid}_tgt_tmp.docx")
        shutil.copy(tgt_src, tmp_tgt)

        out = self._resolve_path(inp.get("output_path")) or tmp_tgt
        os.makedirs(os.path.dirname(out), exist_ok=True)

        try:
            self.ret = self.func(src_path, inp["src_table_index"],
                                 tmp_tgt, inp["tgt_anchor"], output_path=out)
            self.xdoc_output = out
            self.after_doc = Document(out)
            self.before_doc = Document(tgt_src)
        except Exception as e:
            self.raised_exc = e

    # ---- 范围跨文档复制 ----
    def _run_xdoc_range(self):
        inp = self.input
        src_path = self._resolve_path(inp["src_path"])
        tgt_src = self._resolve_path(inp["tgt_path"])
        tmp_tgt = os.path.join(OUTPUT_DIR, f"_{self.tid}_tgt_tmp.docx")
        shutil.copy(tgt_src, tmp_tgt)

        out = self._resolve_path(inp.get("output_path")) or tmp_tgt
        os.makedirs(os.path.dirname(out), exist_ok=True)

        try:
            self.ret = self.func(src_path, inp["start_anchor"],
                                 inp["end_anchor_exclusive"],
                                 tmp_tgt, inp["tgt_anchor"], output_path=out)
            self.xdoc_output = out
            self.after_doc = Document(out)
            self.before_doc = Document(tgt_src)
        except Exception as e:
            self.raised_exc = e

    # ---- 文档合并 ----
    def _run_merge(self):
        inp = self.input
        master_path = self._resolve_path(inp["master_path"])
        part_paths = [self._resolve_path(p) for p in inp["part_paths"]]
        out = self._resolve_path(inp.get("output_path")) or master_path
        os.makedirs(os.path.dirname(out), exist_ok=True)

        # 构造 part 文档（如需 build_part）
        if inp.get("build_part"):
            part_paths = self._build_merge_parts(inp["build_part"], out)

        try:
            kw = {}
            if "insert_page_break" in inp:
                kw["insert_page_break"] = inp["insert_page_break"]
            if "strip_source_heading_numbers" in inp:
                kw["strip_source_heading_numbers"] = inp["strip_source_heading_numbers"]
            self.ret = self.func(master_path, part_paths, out, **kw)
            self.xdoc_output = out
            self.after_doc = Document(out)
            self.before_doc = Document(master_path)
        except Exception as e:
            self.raised_exc = e

    def _build_merge_parts(self, spec, out_dir):
        """根据 spec 列表构造 part docx，返回路径列表。
        spec 元素: {"kind": "copy_base"|"copy_plain"|"writer_part", "path": ..., "paragraphs": [...]}
        """
        parts = []
        for i, s in enumerate(spec):
            p = os.path.join(OUTPUT_DIR, f"_{self.tid}_part_{i}.docx")
            if s["kind"] == "copy_base":
                shutil.copy(self._resolve_path(s["path"]), p)
            elif s["kind"] == "writer_part":
                # 用 writer 在 base 上构造若干段落后另存
                doc = Document(BASE)
                anchor = 7
                for para in s.get("paragraphs", []):
                    writer.insert_paragraph_after(doc, anchor, para, inherit_style=True)
                    anchor += 1
                doc.save(p)
            parts.append(p)
        return parts

    # ---- verifier.validate_openable ----
    def _run_validate_openable(self):
        inp = self.input
        path = inp["path"]
        if not os.path.isabs(path):
            path = os.path.join(ROOT, path)
        if "content" in inp:
            # 损坏文件测试
            with open(path, "wb") as f:
                f.write(inp["content"].encode("utf-8"))
            self.xdoc_output = path
        try:
            self.ret = self.func(path)
        except Exception as e:
            self.raised_exc = e

    # ---- verifier.compare_documents ----
    def _run_compare_documents(self):
        inp = self.input
        scenario = inp.get("scenario")
        if scenario == "modify_size_28_to_32":
            # 制造一个改字号的文档
            doc = Document(BASE)
            p = doc.paragraphs[inp["paragraph"]]
            rpr = p.runs[0]._r.find(_w("rPr"))
            sz = rpr.find(_w("sz"))
            sz.set(_w("val"), "32")
            # 只改 sz 不改 szCs，使 expected 放行精确（仅 runs[0].rPr.sz）
            tmp = os.path.join(OUTPUT_DIR, f"_{self.tid}_modified.docx")
            doc.save(tmp)
            expected = inp.get("expected")
            try:
                self.ret = compare_documents(BASE, tmp, expected_changes=expected)
                self.xdoc_output = tmp
                self.after_doc = doc
                self.before_doc = Document(BASE)
            except Exception as e:
                self.raised_exc = e
        else:
            # 自我对比
            before = inp.get("doc_before", BASE)
            after = inp.get("doc_after", BASE)
            if not os.path.isabs(before): before = os.path.join(ROOT, before)
            if not os.path.isabs(after): after = os.path.join(ROOT, after)
            expected = inp.get("expected_changes")
            try:
                self.ret = compare_documents(before, after, expected_changes=expected)
            except Exception as e:
                self.raised_exc = e

    # ---- verifier.extract_style_fingerprint ----
    def _run_fingerprint(self):
        doc = Document(BASE)
        p = doc.paragraphs[self.input["paragraph"]]
        self.ret = {
            "fp1": extract_style_fingerprint(p),
            "fp2": extract_style_fingerprint(p),
        }

    # ---- 保存 result.docx ----
    def save_result(self, out_dir: str):
        if self.func_name == "verifier.compare_documents":
            return None  # 无文档产出
        if self.func_name == "verifier.extract_style_fingerprint":
            return None
        # 跨文档/合并类：函数已保存输出到 xdoc_output，不重复保存
        if self.func_name in (
            "clipboard.copy_paragraph_across_docs",
            "clipboard.copy_table_across_docs",
            "clipboard.copy_range_across_docs",
            "structure.merge_documents",
        ):
            return self.xdoc_output
        if self.after_doc is not None and self.raised_exc is None:
            path = os.path.join(out_dir, "result.docx")
            self.after_doc.save(path)
            self.result_path = path
            return path
        return None

    # ---- 生成 verifier 样式校验报告 ----
    def gen_style_report(self):
        """对标准流程：对比 base 与 result.docx，得出样式校验报告。"""
        if self.raised_exc is not None:
            self.style_report = {"skipped": True, "reason": "函数抛异常"}
            return
        # verifier 类测试：不产生文档改动，样式校验不适用
        if self.func_name.startswith("verifier."):
            self.style_report = {"not_applicable": True,
                                 "reason": "verifier 类测试，无文档改动"}
            return
        if self.result_path is None and self.xdoc_output is None:
            # 纯定位类：无文档改动
            self.style_report = {"not_applicable": True,
                                 "reason": "无文档产出或纯查询操作"}
            return
        # 批注/读取类：不改段落样式（只改 comments part 或纯读取）
        if self.func_name in (
            "comments.add_comment", "comments.delete_comment",
            "comments.list_comments",
            "locator.extract_outline",
            "reader.extract_all_text", "reader.to_markdown",
            "reader.get_header_text", "reader.get_footer_text",
        ):
            self.style_report = {"not_applicable": True,
                                 "reason": "批注/读取类操作，不涉及段落样式校验"}
            return
        # 跨文档：既记录依赖注入元信息，又做前缀零差异判定
        XDOC_FUNCS = (
            "clipboard.copy_paragraph_across_docs",
            "clipboard.copy_table_across_docs",
            "clipboard.copy_range_across_docs",
            "structure.merge_documents",
        )
        if self.func_name in XDOC_FUNCS:
            prefix_report = self._style_report_for_count_changed()
            self.style_report = {
                "type": "xdoc",
                "copied_images": self.ret.get("copied_images") if self.ret else None,
                "style_map": self.ret.get("style_map") if self.ret else None,
                "num_map": self.ret.get("num_map") if self.ret else None,
                "prefix_unchanged": prefix_report.get("prefix_unchanged"),
                "prefix_detail": prefix_report.get("prefix_detail"),
                "styles_xml_changed": prefix_report.get("styles_xml_changed"),
                # 用前缀判定的结论覆盖 unexpected_changes/summary，使总览准确
                "unexpected_changes": prefix_report.get("unexpected_changes", []),
                "summary": prefix_report.get("summary", ""),
            }
            return
        # 改段落数的操作（插入/删除段落）：verifier 索引对齐失效，改用前缀零差异判定
        if self._is_paragraph_count_changed():
            self.style_report = self._style_report_for_count_changed()
            return
        # 改 run 数量（不改段落数）的操作：verifier 按 run 位置对齐会误报，
        # 改用"段落级 pPr 零差异 + styles.xml 未变"判定
        if self._is_run_count_changed():
            self.style_report = self._style_report_for_run_changed()
            return

        # P1-9 create_paragraph_style：主动改 styles.xml（预期行为）
        if self.func_name == "writer.create_paragraph_style":
            self.style_report = {
                "styles_xml_changed": True,
                "unexpected_changes": [],
                "summary": "create_paragraph_style 主动改 styles.xml（预期）",
            }
            return

        # P0-5 insert_image：追加 drawing run（不改段落数、不改 pPr）
        # P1-9 apply_style：改 pPr/pStyle；set_run_font：改 run rPr
        # P1-6 表格格式：改 tblPr/tcPr/trPr（不改段落数、不改 run）
        # 这些操作的 changes.paragraph 可能为 None（表格类），_expected_for_verifier
        # 返回 None 导致全量对比。改用段落级零差异 + styles.xml 未变判定
        # （create_paragraph_style 的 pre_setup 已在上面处理）。
        if self.func_name in (
            "writer.insert_image", "writer.apply_style", "writer.set_run_font",
            "writer.set_table_column_widths", "writer.set_row_height",
            "writer.shade_cell", "writer.set_table_borders",
            "writer.set_repeat_header_row",
        ):
            self.style_report = self._style_report_for_format_change()
            return
        # 标准流程：base vs result.docx（doc_path 测试用 before_doc 作基线）
        baseline = BASE
        if "doc_path" in self.input:
            # 自定义文档基线：用 before_doc 的保存路径或 before_doc 对象
            baseline = self.before_doc
        try:
            report = compare_documents(baseline, self.result_path,
                                       expected_changes=self._expected_for_verifier())
            self.style_report = report
        except Exception as e:
            self.style_report = {"error": str(e)}

    def _is_run_count_changed(self) -> bool:
        """判断是否改了某段落的 run 数量（删 run / 复制 run / 追加 run 到非末尾）。
        通过 ret['changes'] 的 path 形如 runs[N] 且不含段落数变化来识别。"""
        if self.ret is None or not isinstance(self.ret, dict):
            return False
        changes = self.ret.get("changes", [])
        if not changes:
            return False
        # 已被 _expected_for_verifier 放行的追加 run（path=runs[N] 且不改段落数）
        # 走标准流程即可；这里只针对"删 run / 开头插 run"等导致 run 位置错位的
        for c in changes:
            note = c.get("note", "")
            if "删除文本为" in note or "粘贴 run" in note:
                return True
        return False

    def _style_report_for_run_changed(self) -> dict:
        """对改 run 数量的操作：判定段落级 pPr 零差异 + styles.xml 未变。"""
        report = {"_method": "paragraph_level_check"}
        try:
            styles_changed = _styles_xml_changed(BASE, self.result_path)
        except Exception:
            styles_changed = True
        report["styles_xml_changed"] = styles_changed

        # 找涉及的段落索引
        para_idx = None
        if self.ret and isinstance(self.ret, dict):
            para_idx = (self.ret.get("paragraph_index")
                        or self.ret.get("target_paragraph_index"))
        if para_idx is None:
            report["unexpected_changes"] = [{"reason": "无法确定涉及段落"}]
            report["summary"] = "无法判定"
            return report

        # 比对该段落的 pPr 与所有其它段落指纹
        db = Document(BASE)
        da = self.after_doc
        ppr_ok = True
        detail = ""
        # 该段 pPr 应不变
        try:
            fpb = extract_style_fingerprint(db.paragraphs[para_idx])
            fpa = extract_style_fingerprint(da.paragraphs[para_idx])
            if fpb["pPr"] != fpa["pPr"] or fpb["pPr_rPr"] != fpa["pPr_rPr"]:
                ppr_ok = False
                detail = f"段落{para_idx} pPr/pPr_rPr 变化"
        except Exception as e:
            ppr_ok = False
            detail = f"段落级检查异常: {e}"
        report["prefix_unchanged"] = ppr_ok  # 复用该字段表示段落级 OK
        report["prefix_detail"] = detail

        if not styles_changed and ppr_ok:
            report["unexpected_changes"] = []
            report["summary"] = "无意外改动（段落级 pPr 零差异，styles.xml 未变）"
        else:
            report["unexpected_changes"] = [
                {"reason": "段落级判定未通过",
                 "styles_xml_changed": styles_changed, "detail": detail}]
            report["summary"] = f"styles_changed={styles_changed}, ppr_ok={ppr_ok}"
        return report

    def _style_report_for_format_change(self) -> dict:
        """对表格格式 / 样式应用 / 图片插入类操作：判定除目标格式子元素外
        段落指纹零差异 + styles.xml 未变（create_paragraph_style 除外）。
        这些操作改 tblPr/tcPr/trPr/pPr.pStyle/run.rFonts/runs[].drawing，
        但不改段落数、不改非目标段落的样式。
        """
        report = {"_method": "format_change_check"}
        # styles.xml：apply_style 不应改 styles.xml（pStyle 引用已有样式）；
        # insert_image / 表格格式不改 styles.xml。
        # 但若 pre_setup 含 create_paragraph_style，styles.xml 会变（预期）。
        styles_changed = False
        if self.result_path:
            try:
                styles_changed = _styles_xml_changed(BASE, self.result_path)
            except Exception:
                styles_changed = True
        # pre_setup 含 create_paragraph_style 时 styles.xml 变化属预期
        if self.input.get("pre_setup"):
            has_style_create = any(
                s.get("op") == "create_paragraph_style"
                for s in self.input["pre_setup"])
            if has_style_create and styles_changed:
                styles_changed = False  # 预期变化，不计为异常
        report["styles_xml_changed"] = styles_changed

        # 段落零差异：除目标段落外，其它段落指纹应一致
        # 目标段落：apply_style/set_run_font/insert_image 的 paragraph_index
        db = Document(BASE)
        da = self.after_doc
        target_pidx = None
        if self.ret and isinstance(self.ret, dict):
            target_pidx = self.ret.get("paragraph_index")
        prefix_ok = True
        prefix_detail = ""
        n = min(len(db.paragraphs), len(da.paragraphs))
        for i in range(n):
            if target_pidx is not None and i == target_pidx:
                continue  # 目标段落允许变化
            fpb = extract_style_fingerprint(db.paragraphs[i])
            fpa = extract_style_fingerprint(da.paragraphs[i])
            if fpb["fingerprint_sha1"] != fpa["fingerprint_sha1"]:
                prefix_ok = False
                prefix_detail = f"段落{i}样式指纹变化"
                break
        report["prefix_unchanged"] = prefix_ok
        report["prefix_detail"] = prefix_detail

        if not styles_changed and prefix_ok:
            report["unexpected_changes"] = []
            report["summary"] = "无意外改动（非目标段落零差异，styles.xml 未变）"
        else:
            report["unexpected_changes"] = [
                {"reason": "格式操作针对性判定未通过",
                 "styles_xml_changed": styles_changed,
                 "prefix_unchanged": prefix_ok, "detail": prefix_detail}]
            report["summary"] = f"styles_changed={styles_changed}, prefix_ok={prefix_ok}"
        return report

    def _expected_for_verifier(self):
        """把函数返回的 changes 转成 verifier 可用的放行清单。

        对不改段落数的操作（追加 run / 删 run / 复制 run），用 ret['changes']
        的 paragraph + path 放行，避免新增/删除 run 被误报为意外改动。
        对改段落数的操作（插入/删除段落），verifier 索引对齐失效，返回 None，
        由断言器针对性判定（prefix_unchanged 等）。
        """
        if self.ret is None or not isinstance(self.ret, dict):
            return None
        changes = self.ret.get("changes", [])
        if not changes:
            return None
        # 仅当所有 change 都有明确 paragraph（非 None）时才放行
        expected = []
        for c in changes:
            para = c.get("paragraph")
            path = c.get("path")
            if para is None:
                return None  # 含表格类改动（paragraph=None），不适用全量放行
            expected.append({"paragraph": para, "path": path, "note": c.get("note", "")})
        return expected

    def _is_paragraph_count_changed(self) -> bool:
        """判断本次操作是否改变了 body 段落数（用于决定样式校验的判定方式）。"""
        if self.after_doc is None or self.raised_exc is not None:
            return False
        XDOC_FUNCS = (
            "clipboard.copy_paragraph_across_docs",
            "clipboard.copy_table_across_docs",
            "clipboard.copy_range_across_docs",
            "structure.merge_documents",
        )
        if self.func_name in XDOC_FUNCS:
            return True  # 跨文档/合并：目标段落数变化
        try:
            baseline = self.before_doc if "doc_path" in self.input else Document(BASE)
            return len(self.after_doc.paragraphs) != len(baseline.paragraphs)
        except Exception:
            return False

    def _style_report_for_count_changed(self) -> dict:
        """对改段落数的操作，用针对性判定生成样式校验结论：
        - styles.xml 未变；
        - 插入/复制点之前的段落指纹全部一致（前缀零差异）；
        - 删除点之前的段落指纹全部一致。
        满足则记为"无意外改动（前缀零差异）"，否则记录差异。
        """
        report = {"_method": "prefix_check"}
        # styles.xml：跨文档用目标前后对比；其它用 base vs result
        XDOC_FUNCS = (
            "clipboard.copy_paragraph_across_docs",
            "clipboard.copy_table_across_docs",
            "clipboard.copy_range_across_docs",
            "structure.merge_documents",
        )
        try:
            if self.func_name in XDOC_FUNCS:
                # 跨文档/合并：目标 styles.xml 新增依赖属预期，对比 before/after
                if self.func_name == "structure.merge_documents":
                    tgt_src = self.input.get("master_path")
                else:
                    tgt_src = self.input.get("tgt_path")
                if tgt_src:
                    if not os.path.isabs(tgt_src):
                        tgt_src = os.path.join(ROOT, tgt_src)
                    styles_changed = _styles_xml_changed(tgt_src, self.xdoc_output)
                else:
                    styles_changed = True
            else:
                styles_changed = _styles_xml_changed(BASE, self.result_path or self.xdoc_output)
        except Exception:
            styles_changed = True
        report["styles_xml_changed"] = styles_changed

        # 前缀零差异检查
        anchor_idx = None
        if self.ret and isinstance(self.ret, dict):
            anchor_idx = (self.ret.get("anchor_paragraph_index")
                          or self.ret.get("new_paragraph_index")
                          or self.ret.get("first_new_index")
                          or self.ret.get("deleted_paragraph_index"))
        # 跨文档：用目标前后对比
        if self.func_name in XDOC_FUNCS:
            db = self.before_doc
            da = self.after_doc
            # 目标新增段落插在 tgt_anchor 后； tgt_anchor 之前应零差异
            if self.func_name == "structure.merge_documents":
                # merge 不改 master 已有内容，整个 master 前缀都应零差异
                up_to = len(db.paragraphs) - 1 if db else 0
            else:
                tgt_anchor = self.input.get("tgt_anchor", 0)
                up_to = tgt_anchor if isinstance(tgt_anchor, int) else 0
        else:
            db = Document(BASE)
            da = self.after_doc
            up_to = (anchor_idx - 1) if anchor_idx else 0
            # 插入类：anchor 之后新增，前缀=anchor；删除类：前缀=deleted-1
            if self.ret and "new_paragraph_index" in (self.ret or {}):
                up_to = self.ret.get("anchor_paragraph_index", up_to)
            elif self.ret and "deleted_paragraph_index" in (self.ret or {}):
                up_to = self.ret.get("deleted_paragraph_index", 0) - 1

        prefix_ok = True
        prefix_detail = ""
        try:
            for i in range(up_to + 1):
                if i >= len(da.paragraphs):
                    prefix_ok = False
                    prefix_detail = f"段落数不足: after 仅 {len(da.paragraphs)}"
                    break
                fpb = extract_style_fingerprint(db.paragraphs[i])
                fpa = extract_style_fingerprint(da.paragraphs[i])
                if fpb["fingerprint_sha1"] != fpa["fingerprint_sha1"]:
                    prefix_ok = False
                    prefix_detail = f"段落{i}样式指纹变化"
                    break
        except Exception as e:
            prefix_ok = False
            prefix_detail = f"前缀检查异常: {e}"

        report["prefix_unchanged"] = prefix_ok
        report["prefix_detail"] = prefix_detail
        # 跨文档复制/合并：目标 styles.xml/numbering.xml 新增样式与编号定义属预期行为，
        # 只要前缀段落指纹零差异即视为无意外改动
        if self.func_name in XDOC_FUNCS:
            if prefix_ok:
                report["unexpected_changes"] = []
                report["summary"] = "无意外改动（前缀零差异；目标 styles/numbering 新增依赖属预期）"
            else:
                report["unexpected_changes"] = [
                    {"reason": "跨文档前缀段落指纹不一致", "prefix_detail": prefix_detail}]
                report["summary"] = f"前缀差异: {prefix_detail}"
            return report
        if not styles_changed and prefix_ok:
            report["unexpected_changes"] = []
            report["summary"] = "无意外改动（前缀零差异，styles.xml 未变）"
        else:
            report["unexpected_changes"] = [
                {"reason": "改段落数操作的针对性判定未通过",
                 "styles_xml_changed": styles_changed,
                 "prefix_unchanged": prefix_ok, "prefix_detail": prefix_detail}]
            report["summary"] = f"styles_changed={styles_changed}, prefix_ok={prefix_ok}"
        return report


# ============================================================================
# AssertionChecker：断言判定器
# ============================================================================
class AssertionChecker:
    def __init__(self, runner: TestRunner):
        self.r = runner
        self.case = runner.case
        self.results = []  # [{"assertion":..., "pass":bool, "detail":str}]

    def check_all(self):
        for a in self.case["assertions"]:
            self._check_one(a)
        return self.results

    def _check_one(self, a: dict):
        t = a["type"]
        method = getattr(self, f"_a_{t}", None)
        if method is None:
            self.results.append({"assertion": t, "pass": False,
                                 "detail": f"未实现的断言类型: {t}"})
            return
        try:
            ok, detail = method(a)
        except Exception as e:
            ok, detail = False, f"断言执行异常: {e}"
        self.results.append({"assertion": t, "pass": bool(ok),
                             "detail": str(detail), "raw": a})

    # ---- 辅助：取 new_paragraph 对应的 <w:p> ----
    def _new_p(self):
        if self.r.ret is None:
            return None
        idx = self.r.ret.get("new_paragraph_index")
        if idx is None:
            return None
        doc = self.r.after_doc
        if doc is None:
            return None
        if idx < len(doc.paragraphs):
            return doc.paragraphs[idx]
        return None

    # ===================== 断言实现 =====================

    # --- raises ---
    def _a_raises(self, a):
        if self.r.raised_exc is None:
            return False, f"未抛异常（期望 {a['exception']}）"
        got = type(self.r.raised_exc).__name__
        # 也支持基类匹配（如 LocateError 是各 Error 的基类）
        want = a["exception"]
        ok = (got == want) or want in type(self.r.raised_exc).__m__.__name__ if False else (got == want)
        # 宽松匹配：若期望 LocateError，实际是它的子类也算
        if not ok and want == "LocateError":
            ok = isinstance(self.r.raised_exc, locator.LocateError)
        if not ok:
            # 检查异常类是否在对应模块
            for mod in [locator, writer, deleter, clipboard, comments, reader]:
                cls = getattr(mod, want, None)
                if cls and isinstance(self.r.raised_exc, cls):
                    ok = True
                    break
        return ok, f"抛出 {got}（期望 {want}）"

    # --- openable ---
    def _a_openable(self, a):
        path = self.r.result_path or self.r.xdoc_output
        if path is None:
            return False, "无产出文档路径"
        return validate_openable(path), f"validate_openable({os.path.basename(path)})"

    def _a_openable_true(self, a):
        path = self.r.input["path"]
        if not os.path.isabs(path): path = os.path.join(ROOT, path)
        return validate_openable(path), f"{path} 可打开"

    def _a_openable_false(self, a):
        path = self.r.input["path"]
        if not os.path.isabs(path): path = os.path.join(ROOT, path)
        ok = not validate_openable(path)
        return ok, f"{path} 应不可打开"

    # --- no_modify ---
    def _a_no_modify(self, a):
        # locator 类：操作不应改动文档。对比 base 与 result（若有保存）
        if self.r.result_path is None:
            return True, "查询操作，无文档保存（视为未改动）"
        report = compare_documents(BASE, self.r.result_path, expected_changes=None)
        ok = (not report["unexpected_changes"]) and (not report["styles_xml_changed"])
        return ok, f"unexpected={len(report['unexpected_changes'])} styles_changed={report['styles_xml_changed']}"

    # --- located_* ---
    def _a_located_text(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        # located_text 可能在 ret['text'] 或断言直接给 value
        loc = a.get("location")
        if loc and loc.startswith("new_paragraph"):
            p = self._new_p()
            txt = _p_text(p._p) if p else ""
        else:
            txt = ret.get("text", "")
        want = a["value"]
        return (txt == want) if a.get("exact", True) else (want in txt), \
               f"定位文本={txt!r} 期望={want!r}"

    def _a_located_index(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        loc = a.get("location")
        idx = ret.get("paragraph_index") or ret.get("new_paragraph_index")
        if loc and loc.startswith("new_paragraph"):
            idx = ret.get("new_paragraph_index")
        return idx == a["value"], f"索引={idx} 期望={a['value']}"

    def _a_located_pstyle(self, a):
        loc = a.get("location")
        if loc and loc.startswith("new_paragraph"):
            p = self._new_p()
            ppr = p._p.find(_w("pPr")) if p else None
        else:
            ret = self.r.ret
            p_elem = ret.get("p_elem") if ret else None
            ppr = p_elem.find(_w("pPr")) if p_elem is not None else None
        if ppr is None:
            return False, "无 pPr"
        ps = ppr.find(_w("pStyle"))
        got = ps.get(_w("val")) if ps is not None else None
        return got == a["value"], f"pStyle={got} 期望={a['value']}"

    def _a_match_count_gte(self, a):
        ret = self.r.ret
        cnt = ret.get("match_count", 0) if ret else 0
        return cnt >= a["value"], f"match_count={cnt} >= {a['value']}"

    # --- located_table_index：locate_table_by_header 返回的 table_index ---
    def _a_located_table_index(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("table_index")
        return got == a["value"], f"table_index={got} 期望={a['value']}"

    # --- located_header_cells：locate_table_by_header 的 header_cells ---
    def _a_located_header_cells(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("header_cells", [])
        return got == a["value"], f"header_cells={got} 期望={a['value']}"

    # --- text_contains / text_not_contains ---
    def _a_text_contains(self, a):
        loc = a.get("location")
        txt = self._location_text(loc)
        if txt is None:
            return False, f"无法取文本: {loc}"
        return a["value"] in txt, f"{loc} 文本={txt!r} 应含 {a['value']!r}"

    def _a_text_not_contains(self, a):
        loc = a.get("location")
        txt = self._location_text(loc)
        if txt is None:
            # 段落不存在视为「不含」（缺段不可能含目标文本）
            return True, f"{loc} 不存在（视为不含 {a['value']!r}）"
        return a["value"] not in txt, f"{loc} 文本={txt!r} 不应含 {a['value']!r}"

    def _location_text(self, loc):
        if loc is None:
            return None
        if loc.startswith("new_paragraph"):
            p = self._new_p()
            return _p_text(p._p) if p else None
        if loc.startswith("paragraph["):
            idx = int(loc[len("paragraph["):-1])
            doc = self.r.after_doc
            if doc and idx < len(doc.paragraphs):
                return _p_text(doc.paragraphs[idx]._p)
        if loc.startswith("table["):
            return self._table_cell_text_from_loc(loc)
        # 从返回值 dict 取文本（reader/locator 类函数）
        if loc in ("ret_text", "ret_markdown") and self.r.ret:
            return self.r.ret.get("text" if loc == "ret_text" else "markdown", "")
        return None

    def _table_cell_text_from_loc(self, loc):
        # 解析 table[T].tr[R].tc[C]
        import re
        m = re.match(r"table\[(\d+)\]\.tr\[(\d+)\]\.tc\[(\d+)\]", loc)
        if not m:
            return None
        t, r, c = int(m.group(1)), int(m.group(2)), int(m.group(3))
        doc = self.r.after_doc
        if not doc or t >= len(doc.tables):
            return None
        try:
            tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
            return _tc_text(tc)
        except Exception:
            return None

    # --- prefix_unchanged / others_unchanged / all_body_paragraphs_unchanged ---
    def _a_prefix_unchanged(self, a):
        up_to = a["up_to"]
        if self.r.after_doc is None:
            return False, "无 after_doc"
        db = Document(BASE)
        da = self.r.after_doc
        for i in range(up_to + 1):
            if i >= len(da.paragraphs):
                return False, f"段落数不足: after 仅 {len(da.paragraphs)} 段"
            fpb = extract_style_fingerprint(db.paragraphs[i])
            fpa = extract_style_fingerprint(da.paragraphs[i])
            if fpb["fingerprint_sha1"] != fpa["fingerprint_sha1"]:
                return False, f"段落{i}样式指纹变化"
        return True, f"段落0~{up_to} 样式指纹完全一致"

    def _a_others_unchanged(self, a):
        # 不改段落数的操作：除新增 run 外全段指纹一致
        if self.r.result_path is None:
            return False, "无 result.docx"
        report = compare_documents(BASE, self.r.result_path, expected_changes=None)
        # 允许新增 run 导致的 runs 数量变化，但 pPr 与既有 run 的 rPr 不应变
        # 简化判定：unexpected 中不应有 pPr 级或既有 run 的 rPr 变化
        bad = [d for d in report["unexpected_changes"]
               if d["path"].startswith("pPr") or d["path"].startswith("pPr_rPr")]
        if bad:
            return False, f"段落级样式被改动: {bad[:3]}"
        # styles.xml 不应变
        if report["styles_xml_changed"]:
            return False, "styles.xml 被改动"
        return True, "段落级样式与 styles.xml 未变"

    def _a_all_body_paragraphs_unchanged(self, a):
        if self.r.after_doc is None:
            return False, "无 after_doc"
        db = Document(BASE)
        da = self.r.after_doc
        n = min(len(db.paragraphs), len(da.paragraphs))
        for i in range(n):
            fpb = extract_style_fingerprint(db.paragraphs[i])
            fpa = extract_style_fingerprint(da.paragraphs[i])
            if fpb["fingerprint_sha1"] != fpa["fingerprint_sha1"]:
                return False, f"段落{i}样式指纹变化"
        return True, f"全部 {n} 个 body 段落样式指纹一致"

    # --- styles_xml_unchanged ---
    def _a_styles_xml_unchanged(self, a):
        if self.r.result_path is None and self.r.xdoc_output is None:
            # 纯查询/verifier 类：styles.xml 本就无改动
            return True, "无文档产出，styles.xml 未涉及"
        path = self.r.result_path or self.r.xdoc_output
        XDOC_FUNCS = (
            "clipboard.copy_paragraph_across_docs",
            "clipboard.copy_table_across_docs",
            "clipboard.copy_range_across_docs",
            "structure.merge_documents",
        )
        # 跨文档复制/合并会把源样式加到目标 styles.xml，属预期，不在此断言
        if self.r.func_name in XDOC_FUNCS:
            return True, "跨文档复制/合并：目标 styles.xml 新增样式属预期"
        changed = _styles_xml_changed(BASE, path)
        return not changed, f"styles.xml changed={changed}"

    # --- style_equals_source ---
    def _a_style_equals_source(self, a):
        # source 形如 "paragraph[7]"；location 为 new_paragraph
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        src = a["source"]
        idx = int(src[len("paragraph["):-1])
        db = Document(BASE)
        if idx >= len(db.paragraphs):
            return False, f"源段落{idx}不存在"
        fp_src = extract_style_fingerprint(db.paragraphs[idx])
        fp_new = extract_style_fingerprint(p)
        ok = (fp_src["pPr"] == fp_new["pPr"] and
              fp_src["pPr_rPr"] == fp_new["pPr_rPr"] and
              fp_src["runs"][0]["rPr"] == fp_new["runs"][0]["rPr"]) if fp_new["runs"] else \
             (fp_src["pPr"] == fp_new["pPr"] and fp_src["pPr_rPr"] == fp_new["pPr_rPr"])
        return ok, f"新段落样式 vs 源段落{idx}: pPr/rPr {'一致' if ok else '不一致'}"

    # --- run rPr 相关 ---
    def _a_run_rpr_inherited(self, a):
        # 新 run 的 rPr 应与源 run 一致
        loc = a["location"]
        idx = int(loc[len("paragraph["):-1])
        run_idx = a["run"]
        src_run = a["source_run"]
        doc = self.r.after_doc
        if doc is None or idx >= len(doc.paragraphs):
            return False, "段落不存在"
        p = doc.paragraphs[idx]
        if run_idx < 0:
            run_idx = len(p.runs) + run_idx
        if run_idx >= len(p.runs) or src_run >= len(p.runs):
            return False, f"run 索引越界 (run={run_idx}, src={src_run}, 共{len(p.runs)})"
        rpr_new = p.runs[run_idx]._r.find(_w("rPr"))
        rpr_src = p.runs[src_run]._r.find(_w("rPr"))
        ok = _rpr_equal(rpr_new, rpr_src)
        return ok, f"新run rPr 与源run[{src_run}] {'一致' if ok else '不一致'}"

    def _a_run_rpr_preserved(self, a):
        loc = a["location"]
        idx = int(loc[len("paragraph["):-1])
        run_idx = a["run"]
        attr = a["attr"]
        val = a["value"]
        doc = self.r.after_doc
        if doc is None or idx >= len(doc.paragraphs):
            return False, "段落不存在"
        p = doc.paragraphs[idx]
        if run_idx < 0:
            run_idx = len(p.runs) + run_idx
        if run_idx >= len(p.runs):
            return False, f"run 索引越界 (run={run_idx}, 共{len(p.runs)})"
        rpr = p.runs[run_idx]._r.find(_w("rPr"))
        if rpr is None:
            return False, "run 无 rPr"
        el = rpr.find(_w(attr))
        got = el.get(_w("val")) if el is not None else None
        # b/bCs 等无 val 时存在即视为 true
        if val in ("true",) and el is not None and el.get(_w("val")) is None:
            got = "true"
        return got == val, f"run[{run_idx}].rPr.{attr}={got} 期望={val}"

    def _a_new_run_no_rpr(self, a):
        loc = a.get("location", "")
        if loc.startswith("table["):
            import re
            m = re.match(r"table\[(\d+)\]\.tr\[(\d+)\]\.tc\[(\d+)\]", loc)
            if not m:
                return False, "无法解析表格坐标"
            t, r, c = int(m.group(1)), int(m.group(2)), int(m.group(3))
            doc = self.r.after_doc
            tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
            ps = tc.findall(_w("p"))
            if not ps:
                return False, "单元格无段落"
            runs = ps[0].findall(_w("r"))
            rpr = runs[-1].find(_w("rPr")) if runs else None
            ok = rpr is None or len(rpr) == 0
            return ok, f"单元格新run rPr={'空' if ok else '非空'}"
        idx = int(loc[len("paragraph["):-1])
        doc = self.r.after_doc
        p = doc.paragraphs[idx]
        rpr = p.runs[-1]._r.find(_w("rPr"))
        ok = rpr is None or len(rpr) == 0
        return ok, f"新run rPr={'空' if ok else '非空'}"

    def _a_no_inherited_rpr(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        runs = p._p.findall(_w("r"))
        if not runs:
            return True, "新段落无 run（空段落）"
        rpr = runs[0].find(_w("rPr"))
        ok = rpr is None or len(rpr) == 0
        return ok, f"新段落 run rPr={'空' if ok else '非空'}"

    # --- sectPr 相关 ---
    def _a_sectpr_is_last(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        body = doc.element.body
        return _local(body[-1].tag) == "sectPr", f"body 末尾元素={_local(body[-1].tag)}"

    def _a_new_p_before_sectpr(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        body = doc.element.body
        last2 = [_local(c.tag) for c in list(body)[-2:]]
        return last2 == ["p", "sectPr"], f"body 末两元素={last2}"

    # --- paragraph_removed ---
    def _a_paragraph_removed(self, a):
        idx = a["index"]
        removed_text = a.get("removed_text")
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        db = Document(BASE)
        # 验证原索引处的文本已不是 removed_text
        if idx < len(doc.paragraphs):
            cur = doc.paragraphs[idx].text
            if removed_text and cur == removed_text:
                return False, f"段落{idx}文本仍是 {removed_text!r}"
        return len(doc.paragraphs) == len(db.paragraphs) - 1, \
               f"段落数 {len(db.paragraphs)} -> {len(doc.paragraphs)}"

    # --- 表格相关 ---
    def _a_table_row_count(self, a):
        doc = self.r.after_doc
        t = a["table"]
        if doc is None or t >= len(doc.tables):
            return False, "表格不存在"
        got = len(doc.tables[t].rows)
        return got == a["value"], f"表格{t}行数={got} 期望={a['value']}"

    def _a_table_cell_text(self, a):
        doc = self.r.after_doc
        t, r, c = a["table"], a["row"], a["col"]
        if doc is None or t >= len(doc.tables):
            return False, "表格不存在"
        try:
            tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
            got = _tc_text(tc)
        except Exception as e:
            return False, f"取单元格失败: {e}"
        return got == a["value"], f"({t},{r},{c})={got!r} 期望={a['value']!r}"

    def _a_table_cell_text_contains(self, a):
        doc = self.r.after_doc
        t, r, c = a["table"], a["row"], a["col"]
        try:
            tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
            got = _tc_text(tc)
        except Exception as e:
            return False, f"取单元格失败: {e}"
        return a["value"] in got, f"({t},{r},{c})={got!r} 应含 {a['value']!r}"

    def _a_table_row_text(self, a):
        doc = self.r.after_doc
        t, r = a["table"], a["row"]
        if doc is None or t >= len(doc.tables):
            return False, "表格不存在"
        try:
            tcs = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))
            got = [_tc_text(tc) for tc in tcs]
        except Exception as e:
            return False, f"取行失败: {e}"
        return got == a["value"], f"表{t}行{r}={got} 期望={a['value']}"

    def _a_tcPr_preserved(self, a):
        doc = self.r.after_doc
        t, r, c = a["table"], a["row"], a["col"]
        tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
        ok = tc.find(_w("tcPr")) is not None
        return ok, f"({t},{r},{c}) tcPr {'保留' if ok else '丢失'}"

    def _a_new_row_tcPr_preserved(self, a):
        doc = self.r.after_doc
        t, r = a["table"], a["row"]
        tcs = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))
        all_ok = all(tc.find(_w("tcPr")) is not None for tc in tcs)
        return all_ok, f"新行所有单元格 tcPr {'均保留' if all_ok else '有丢失'}"

    def _a_cell_has_paragraph(self, a):
        doc = self.r.after_doc
        t, r, c = a["table"], a["row"], a["col"]
        tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
        cnt = len(tc.findall(_w("p")))
        return cnt >= 1, f"({t},{r},{c}) 段落数={cnt}"

    # --- 图片相关 ---
    def _a_image_count_in_paragraph(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        blips = list(p._p.iter(f"{{{A_NS}}}blip"))
        return len(blips) == a["value"], f"图片blip数={len(blips)} 期望={a['value']}"

    def _a_image_embed(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        embeds = [b.get(_r("embed")) for b in p._p.iter(f"{{{A_NS}}}blip")]
        ok = all(e == a["value"] for e in embeds) if embeds else False
        return ok, f"embeds={embeds} 期望全为 {a['value']}"

    def _a_image_embed_not(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        embeds = [b.get(_r("embed")) for b in p._p.iter(f"{{{A_NS}}}blip")]
        ok = all(e and e != a["value"] for e in embeds) if embeds else False
        return ok, f"embeds={embeds} 均不等于 {a['value']}"

    def _a_copied_images_gte(self, a):
        ret = self.r.ret or {}
        got = ret.get("copied_images", 0)
        return got >= a["value"], f"copied_images={got} >= {a['value']}"

    def _a_media_added_in_target(self, a):
        path = self.r.xdoc_output
        if not path:
            return False, "无跨文档输出"
        media = [n for n in zipfile.ZipFile(path).namelist()
                 if n.startswith("word/media/")]
        return len(media) >= 1, f"目标 media 文件数={len(media)}"

    # --- 书签相关 ---
    def _a_remapped_bookmarks_gte(self, a):
        ret = self.r.ret or {}
        got = ret.get("remapped_bookmarks", 0)
        return got >= a["value"], f"remapped_bookmarks={got} >= {a['value']}"

    def _a_bookmark_name_suffix(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        bms = p._p.findall(_w("bookmarkStart"))
        if not bms:
            return False, "新段落无书签"
        ok = all((bm.get(_w("name")) or "").endswith(a["suffix"]) for bm in bms)
        names = [bm.get(_w("name")) for bm in bms]
        return ok, f"书签名={names} 均以 {a['suffix']} 结尾"

    def _a_bookmark_id_gt(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        bms = p._p.findall(_w("bookmarkStart"))
        ids = [int(bm.get(_w("id"))) for bm in bms if bm.get(_w("id")).isdigit()]
        if not ids:
            return False, "新段落无有效书签id"
        ok = all(i > a["min"] for i in ids)
        return ok, f"书签ids={ids} 均 > {a['min']}"

    # --- 跨文档 numId ---
    def _a_num_map_has(self, a):
        ret = self.r.ret or {}
        num_map = ret.get("num_map", {})
        return a["src"] in num_map, f"num_map={num_map} 含 src={a['src']}"

    def _a_new_paragraph_numid(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        ppr = p._p.find(_w("pPr"))
        if ppr is None:
            return False, "新段落无 pPr"
        numpr = ppr.find(_w("numPr"))
        if numpr is None:
            return False, "新段落无 numPr"
        nid_el = numpr.find(_w("numId"))
        got = nid_el.get(_w("val")) if nid_el is not None else None
        # value="mapped" 表示只要在 num_map 中即可
        if a["value"] == "mapped":
            ret = self.r.ret or {}
            return got in ret.get("num_map", {}).values(), f"新段落 numId={got} 属重映射值"
        return got == a["value"], f"新段落 numId={got} 期望={a['value']}"

    # --- run rPr 跨文档一致 ---
    def _a_run_rpr_equals_source(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        src_idx = int(a["source"][len("paragraph["):-1])
        db = Document(BASE)
        src_p = db.paragraphs[src_idx]
        run_idx = a["run"]
        if run_idx >= len(p.runs) or run_idx >= len(src_p.runs):
            return False, "run 索引越界"
        rpr_new = p.runs[run_idx]._r.find(_w("rPr"))
        rpr_src = src_p.runs[run_idx]._r.find(_w("rPr"))
        ok = _rpr_equal(rpr_new, rpr_src)
        return ok, f"新段落 run[{run_idx}].rPr vs 源段落{src_idx} {'一致' if ok else '不一致'}"

    def _a_ppr_rpr_equals_source(self, a):
        p = self._new_p()
        if p is None:
            return False, "无新段落"
        src_idx = int(a["source"][len("paragraph["):-1])
        db = Document(BASE)
        fp_src = extract_style_fingerprint(db.paragraphs[src_idx])
        fp_new = extract_style_fingerprint(p)
        ok = fp_src["pPr_rPr"] == fp_new["pPr_rPr"]
        return ok, f"pPr_rPr 与源段落{src_idx} {'一致' if ok else '不一致'}"

    # --- verifier 类断言 ---
    def _a_unexpected_empty(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        ok = len(ret.get("unexpected_changes", [])) == 0
        return ok, f"unexpected_changes 数={len(ret.get('unexpected_changes', []))}"

    def _a_styles_xml_unchanged_verifier(self, a):
        # 复用 _a_styles_xml_unchanged
        return self._a_styles_xml_unchanged(a)

    def _a_summary_is(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        return ret.get("summary") == a["value"], f"summary={ret.get('summary')!r} 期望={a['value']!r}"

    def _a_unexpected_contains(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        hits = [d for d in ret.get("unexpected_changes", [])
                if d.get("path") == a["path"]]
        if not hits:
            return False, f"未找到 path={a['path']} 的意外改动"
        # 校验 expected/actual
        ok = (hits[0].get("expected") == a["expected"] and
              hits[0].get("actual") == a["actual"])
        return ok, f"命中: {hits[0]}"

    def _a_expected_applied_contains(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        hits = [d for d in ret.get("expected_applied", [])
                if d.get("path") == a["path"]]
        return len(hits) >= 1, f"expected_applied 中 path={a['path']} 命中{len(hits)}次"

    def _a_fingerprint_stable(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        ok = ret["fp1"]["fingerprint_sha1"] == ret["fp2"]["fingerprint_sha1"]
        return ok, f"两次指纹哈希{'一致' if ok else '不一致'}"

    # ===================== 语义层断言 =====================

    # --- h1_count：H1 段落数 == value ---
    def _a_h1_count(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        # check_structure 返回 h1_count；其它函数返回值可能无此字段
        if "h1_count" in ret:
            got = ret["h1_count"]
        else:
            # 兜底：实时统计 after_doc 的 H1
            doc = self.r.after_doc
            if doc is None:
                return False, "无文档"
            from src.locator import _heading_level_of, _style_id_to_name
            sim = _style_id_to_name(doc)
            got = sum(1 for p in doc.element.body
                      if _local(p.tag) == "p" and _heading_level_of(p, sim) == 1)
        return got == a["value"], f"h1_count={got} 期望={a['value']}"

    # --- page_break_before：某段含 pageBreakBefore ---
    def _a_page_break_before(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        idx = a["paragraph"]
        if idx >= len(doc.paragraphs):
            return False, f"段落{idx}不存在"
        ppr = doc.paragraphs[idx]._p.find(_w("pPr"))
        has = ppr is not None and ppr.find(_w("pageBreakBefore")) is not None
        expect = a.get("value", True)
        return has == expect, f"段落{idx} pageBreakBefore={has} 期望={expect}"

    # --- no_inline_section_breaks：全文无内嵌 sectPr ---
    def _a_no_inline_section_breaks(self, a):
        doc = self.r.after_doc
        if doc is None:
            # 若是 check_structure 返回结果，看 ret['violations']
            ret = self.r.ret
            if ret and "violations" in ret:
                bad = [v for v in ret["violations"]
                       if v.get("check") == "no_inline_section_breaks"]
                return len(bad) == 0, f"violations 中 no_inline_section_breaks={len(bad)}"
            return False, "无文档"
        bad = 0
        for c in doc.element.body:
            if _local(c.tag) == "p":
                ppr = c.find(_w("pPr"))
                if ppr is not None and ppr.find(_w("sectPr")) is not None:
                    bad += 1
        return bad == 0, f"内嵌 sectPr 段数={bad} 期望=0"

    # --- toc_field_present：body 含 TOC instrText ---
    def _a_toc_field_present(self, a):
        doc = self.r.after_doc
        if doc is None:
            ret = self.r.ret
            if ret and "violations" in ret:
                bad = [v for v in ret["violations"]
                       if v.get("check") == "toc_field"]
                return len(bad) == 0, f"violations 中 toc_field={len(bad)}"
            return False, "无文档"
        found = False
        for c in doc.element.body:
            if _local(c.tag) != "p":
                continue
            for it in c.iter(_w("instrText")):
                if it.text and "TOC" in it.text:
                    found = True
                    break
            if found:
                break
        return found, f"body 含 TOC instrText={found}"

    # --- cell_adjacent_value：label 单元格相邻单元格文本 == value ---
    def _a_cell_adjacent_value(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t = a["table"]
        # 用 label 文本找单元格，取方向相邻单元格文本
        label = a["label"]
        direction = a.get("direction", "right")
        strip_colon = a.get("strip_colon", True)
        tbl = doc.tables[t]._tbl
        rows = tbl.findall(_w("tr"))

        def _norm(s):
            s = s.strip()
            return s.rstrip("：：") if strip_colon else s

        label_norm = _norm(label)
        found = False
        got = None
        for ri, r in enumerate(rows):
            tcs = r.findall(_w("tc"))
            for ci, tc in enumerate(tcs):
                tc_text = " / ".join(
                    "".join((t.text or "") for t in p.iter(_w("t")))
                    for p in tc.findall(_w("p")))
                if _norm(tc_text) == label_norm:
                    vr, vc = (ri, ci + 1) if direction == "right" else (ri + 1, ci)
                    if vr < len(rows):
                        vtcs = rows[vr].findall(_w("tc"))
                        if vc < len(vtcs):
                            got = " / ".join(
                                "".join((t.text or "") for t in p.iter(_w("t")))
                                for p in vtcs[vc].findall(_w("p")))
                            found = True
                    break
            if found:
                break
        if not found:
            return False, f"未找到 label={label!r} 的值单元格"
        return got == a["value"], f"相邻单元格={got!r} 期望={a['value']!r}"

    # --- replaced_count：replace_all_placeholders 替换数 == value ---
    def _a_replaced_count(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = len(ret.get("replaced", []))
        return got == a["value"], f"replaced 数={got} 期望={a['value']}"

    # --- paragraph_text：指定段落文本 == value（整段替换校验）---
    def _a_paragraph_text(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        idx = a["paragraph"]
        if idx >= len(doc.paragraphs):
            return False, f"段落{idx}不存在"
        txt = _p_text(doc.paragraphs[idx]._p)
        if a.get("exact", True):
            return txt == a["value"], f"段落{idx}文本={txt!r} 期望={a['value']!r}"
        return a["value"] in txt, f"段落{idx}文本={txt!r} 应含 {a['value']!r}"

    # --- deleted_paragraphs：delete_range 删除段落数 >= value ---
    def _a_deleted_paragraphs(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("deleted_paragraphs", 0)
        return got >= a["value"], f"deleted_paragraphs={got} >= {a['value']}"

    # --- removed_count：remove_section_break 移除数 == value ---
    def _a_removed_count(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("removed_count", 0)
        return got == a["value"], f"removed_count={got} 期望={a['value']}"

    # --- structure_passed：check_structure passed == value ---
    def _a_structure_passed(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("passed")
        expect = a["value"]
        return got == expect, f"check_structure passed={got} 期望={expect}"

    # --- structure_violation_check：check_structure violations 含某 check ---
    def _a_structure_violation_check(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        checks = [v.get("check") for v in ret.get("violations", [])]
        want = a["check"]
        has = want in checks
        expect_present = a.get("present", True)
        return has == expect_present, f"violations 含 {want}={has} 期望 present={expect_present}"

    # --- removed_br / removed_pbb：remove_page_break 标志位 ---
    def _a_removed_flag(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        key = a["flag"]  # "removed_pbb" or "removed_br"
        got = ret.get(key)
        expect = a["value"]
        return got == expect, f"{key}={got} 期望={expect}"

    # ===================== P0-1/P0-2 跨文档/合并断言 =====================

    # --- blip_count：文档 body 内 a:blip 数 >= value ---
    def _a_blip_count(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        blips = list(doc.element.body.iter(f"{{{A_NS}}}blip"))
        got = len(blips)
        cmp = a.get("cmp", ">=")
        if cmp == ">=":
            ok = got >= a["value"]
        elif cmp == "==":
            ok = got == a["value"]
        else:
            ok = got >= a["value"]
        return ok, f"blip数={got} {cmp} {a['value']}"

    # --- table_count：文档表格数 == value ---
    def _a_table_count(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        got = len(doc.tables)
        return got == a["value"], f"table_count={got} 期望={a['value']}"

    # --- paragraph_count：文档段落数 == value ---
    def _a_paragraph_count(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        got = len(doc.paragraphs)
        return got == a["value"], f"paragraph_count={got} 期望={a['value']}"

    # --- total_inserted：merge_documents 返回的 total_inserted == value ---
    def _a_total_inserted(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("total_inserted", 0)
        return got == a["value"], f"total_inserted={got} 期望={a['value']}"

    # --- inserted_count：copy_range_across_docs 返回的 inserted_count >= value ---
    def _a_inserted_count(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("inserted_count", 0)
        return got >= a["value"], f"inserted_count={got} >= {a['value']}"

    # --- page_break_present：文档 body 含 <w:br type=page> ---
    def _a_page_break_present(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        brs = [br for br in doc.element.body.iter(_w("br"))
               if br.get(_w("type")) == "page"]
        got = len(brs)
        return got >= a["value"], f"page_break数={got} >= {a['value']}"

    # --- merged_parts：merge_documents 返回的 merged_parts == value ---
    def _a_merged_parts(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("merged_parts", 0)
        return got == a["value"], f"merged_parts={got} 期望={a['value']}"

    # ===================== P0-4 断言 =====================

    # --- renumbered_count：renumber_headings 返回的 count == value ---
    def _a_renumbered_count(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("count", 0)
        return got == a["value"], f"count={got} 期望={a['value']}"

    # --- renumbered_count_gte：renumber_headings 返回的 count >= value ---
    def _a_renumbered_count_gte(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("count", 0)
        return got >= a["value"], f"count={got} >= {a['value']}"

    # --- first_renumbered_prefix：首个重编号标题文本以 value 开头 ---
    def _a_first_renumbered_prefix(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        renumbered = ret.get("renumbered", [])
        if not renumbered:
            return False, "无重编号标题"
        new_text = renumbered[0]["new"]
        return new_text.startswith(a["value"]), f"首个重编号={new_text!r} 应以 {a['value']!r} 开头"

    # ===================== P0-5 / P1-6 / P1-9 断言 =====================

    # --- has_drawing：锚点段含 a:blip ---
    def _a_has_drawing(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        ret = self.r.ret
        p_idx = ret.get("paragraph_index") if ret else None
        if p_idx is None or p_idx >= len(doc.paragraphs):
            return False, "无法定位段落"
        p = doc.paragraphs[p_idx]._p
        blips = list(p.iter(f"{{{A_NS}}}blip"))
        return len(blips) >= 1, f"段{p_idx} blip数={len(blips)}"

    # --- image_extent_set：锚点段图片 wp:extent cx/cy 已设 ---
    def _a_image_extent_set(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        ret = self.r.ret
        p_idx = ret.get("paragraph_index") if ret else None
        if p_idx is None or p_idx >= len(doc.paragraphs):
            return False, "无法定位段落"
        p = doc.paragraphs[p_idx]._p
        WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
        extent = None
        for ext in p.iter(f"{{{WP_NS}}}extent"):
            extent = ext
            break
        if extent is None:
            return False, "无 wp:extent"
        cx = extent.get("cx")
        cy = extent.get("cy")
        if not cx or not cy:
            return False, f"cx/cy 未设 (cx={cx}, cy={cy})"
        return True, f"extent cx={cx} cy={cy}"

    # --- tbl_grid_col_count：表格 tblGrid gridCol 数 == value ---
    def _a_tbl_grid_col_count(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t = a["table"]
        if t >= len(doc.tables):
            return False, "表格不存在"
        tblGrid = doc.tables[t]._tbl.find(_w("tblGrid"))
        if tblGrid is None:
            return False, "无 tblGrid"
        got = len(tblGrid.findall(_w("gridCol")))
        return got == a["value"], f"tbl[{t}] gridCol数={got} 期望={a['value']}"

    # --- tbl_layout_fixed：表格 tblPr 含 tblLayout type=fixed ---
    def _a_tbl_layout_fixed(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t = a["table"]
        if t >= len(doc.tables):
            return False, "表格不存在"
        tblLayout = doc.tables[t]._tbl.find(_w("tblPr")).find(_w("tblLayout"))
        if tblLayout is None:
            return False, "无 tblLayout"
        got = tblLayout.get(_w("type"))
        return got == "fixed", f"tblLayout type={got}"

    # --- row_has_trheight：行 trPr 含 trHeight 且 hRule 匹配 ---
    def _a_row_has_trheight(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t = a["table"]
        r = a["row"]
        try:
            tr = doc.tables[t]._tbl.findall(_w("tr"))[r]
        except (IndexError, KeyError):
            return False, "行不存在"
        trPr = tr.find(_w("trPr"))
        if trPr is None:
            return False, "无 trPr"
        trHeight = trPr.find(_w("trHeight"))
        if trHeight is None:
            return False, "无 trHeight"
        val = trHeight.get(_w("val"))
        hRule = trHeight.get(_w("hRule"))
        want_rule = a.get("rule")
        ok = val is not None and (want_rule is None or hRule == want_rule)
        return ok, f"trHeight val={val} hRule={hRule}"

    # --- cell_shaded：单元格 tcPr 含 shd fill 匹配 ---
    def _a_cell_shaded(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t, r, c = a["table"], a["row"], a["col"]
        try:
            tc = doc.tables[t]._tbl.findall(_w("tr"))[r].findall(_w("tc"))[c]
        except (IndexError, KeyError):
            return False, "单元格不存在"
        shd = tc.find(_w("tcPr")).find(_w("shd")) if tc.find(_w("tcPr")) is not None else None
        if shd is None:
            return False, "无 shd"
        fill = shd.get(_w("fill"))
        return fill == a["fill"], f"shd fill={fill} 期望={a['fill']}"

    # --- tbl_borders_count：tblBorders side 子元素数 == value ---
    def _a_tbl_borders_count(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t = a["table"]
        if t >= len(doc.tables):
            return False, "表格不存在"
        tblBorders = doc.tables[t]._tbl.find(_w("tblPr")).find(_w("tblBorders"))
        if tblBorders is None:
            return False, "无 tblBorders"
        got = len(list(tblBorders))
        return got == a["value"], f"tblBorders 子元素数={got} 期望={a['value']}"

    # --- row_has_tblheader：行 trPr 含 tblHeader ---
    def _a_row_has_tblheader(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        t = a["table"]
        r = a["row"]
        try:
            tr = doc.tables[t]._tbl.findall(_w("tr"))[r]
        except (IndexError, KeyError):
            return False, "行不存在"
        trPr = tr.find(_w("trPr"))
        if trPr is None:
            return False, "无 trPr"
        has = trPr.find(_w("tblHeader")) is not None
        return has, f"trPr tblHeader={'有' if has else '无'}"

    # --- style_exists：styles.xml 含指定 styleId 且 name 匹配 ---
    def _a_style_exists(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        style_id = a["style_id"]
        for s in doc.styles:
            if s.style_id == style_id:
                name = s.name
                want_name = a.get("name")
                if want_name is not None:
                    return name == want_name, f"style {style_id!r} name={name!r} 期望={want_name!r}"
                return True, f"style {style_id!r} 存在"
        return False, f"style {style_id!r} 不存在"

    # --- paragraph_pstyle：段落 pPr/pStyle w:val == value ---
    def _a_paragraph_pstyle(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        idx = a.get("paragraph")
        if idx is None:
            ret = self.r.ret
            idx = ret.get("paragraph_index") if ret else None
        if idx is None or idx >= len(doc.paragraphs):
            return False, f"段落{idx}不存在"
        ppr = doc.paragraphs[idx]._p.find(_w("pPr"))
        if ppr is None:
            return False, "无 pPr"
        pStyle = ppr.find(_w("pStyle"))
        got = pStyle.get(_w("val")) if pStyle is not None else None
        return got == a["value"], f"段落{idx} pStyle={got} 期望={a['value']}"

    # --- run_fonts_set：段落所有 run 的 rFonts 含四属性且 eastAsia 匹配 ---
    def _a_run_fonts_set(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        idx = a.get("paragraph")
        if idx is None:
            ret = self.r.ret
            idx = ret.get("paragraph_index") if ret else None
        if idx is None or idx >= len(doc.paragraphs):
            return False, f"段落{idx}不存在"
        p = doc.paragraphs[idx]._p
        want_ea = a.get("east_asia")
        want_ascii = a.get("ascii")
        checked = 0
        for r in p.findall(_w("r")):
            rpr = r.find(_w("rPr"))
            if rpr is None:
                continue
            rfonts = rpr.find(_w("rFonts"))
            if rfonts is None:
                continue
            checked += 1
            ea = rfonts.get(_w("eastAsia"))
            asc = rfonts.get(_w("ascii"))
            if want_ea and ea != want_ea:
                return False, f"run rFonts eastAsia={ea} 期望={want_ea}"
            if want_ascii and asc != want_ascii:
                return False, f"run rFonts ascii={asc} 期望={want_ascii}"
            # 检查四属性齐全
            for attr in ("ascii", "hAnsi", "eastAsia", "cs"):
                if rfonts.get(_w(attr)) is None:
                    return False, f"rFonts 缺 {attr}"
        if checked == 0:
            return False, "段落无带 rFonts 的 run"
        return True, f"段落{idx} {checked} 个 run rFonts 四属性齐全"

    # ===================== P1-8 批注断言 =====================

    # --- comment_count：comments.xml 中 <w:comment> 数 == value ---
    def _a_comment_count(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        try:
            cp = doc.part.part_related_by(
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments")
            root = cp.element
            got = len(root.findall(_w("comment")))
        except Exception:
            got = 0
        return got == a["value"], f"comment count={got} 期望={a['value']}"

    # --- no_dangling_comment_ref：document.xml 无 commentReference ---
    def _a_no_dangling_comment_ref(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        refs = list(doc.element.body.iter(_w("commentReference")))
        got = len(refs)
        return got == 0, f"commentReference 数={got} 期望=0"

    # ===================== P2-10/11 大纲/导出断言 =====================

    # --- outline_count_gte：extract_outline 返回的 count >= value ---
    def _a_outline_count_gte(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("count", 0)
        return got >= a["value"], f"outline count={got} >= {a['value']}"

    # --- outline_has_entry：outline 含指定 level + paragraph_index 的条目 ---
    def _a_outline_has_entry(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        outline = ret.get("outline", [])
        want_level = a["level"]
        want_idx = a["paragraph_index"]
        for e in outline:
            if e.get("level") == want_level and e.get("paragraph_index") == want_idx:
                return True, f"outline 含 level={want_level} paragraph_index={want_idx}"
        return False, f"outline 不含 level={want_level} paragraph_index={want_idx}"

    # --- ret_paragraph_count_gt：返回值 paragraph_count > value ---
    def _a_ret_paragraph_count_gt(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("paragraph_count", 0)
        return got > a["value"], f"paragraph_count={got} > {a['value']}"

    # --- ret_table_count：返回值 table_count == value ---
    def _a_ret_table_count(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get("table_count", 0)
        return got == a["value"], f"table_count={got} 期望={a['value']}"

    # --- ret_field_equals：返回值任意字段 == value（读取类函数断言用）
    def _a_ret_field_equals(self, a):
        ret = self.r.ret
        if ret is None:
            return False, "无返回值"
        got = ret.get(a["field"])
        want = a["value"]
        return got == want, f"ret[{a['field']!r}]={got!r} 期望={want!r}"

    # --- hf_text：读回 header/footer 文本断言（非 mutate，用于 set_*_text 写入测试）
    def _a_hf_text(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        kind = a["kind"]  # "header" | "footer"
        which = a.get("which", "default")
        section_index = a.get("section_index", 0)
        if kind == "header":
            ret = reader.get_header_text(doc, section_index=section_index,
                                         which=which)
        elif kind == "footer":
            ret = reader.get_footer_text(doc, section_index=section_index,
                                         which=which)
        else:
            return False, f"未知 kind: {kind}"
        got = ret["text"]
        want = a["value"]
        if a.get("exact", True):
            ok = got == want
        else:
            ok = want in got
        return ok, f"{kind}.{which} text={got!r} 期望={want!r}"

    # --- hf_has_part：读回 header/footer 是否有自有 part（has_part 字段）
    def _a_hf_has_part(self, a):
        doc = self.r.after_doc
        if doc is None:
            return False, "无文档"
        kind = a["kind"]
        which = a.get("which", "default")
        section_index = a.get("section_index", 0)
        fn = reader.get_header_text if kind == "header" else reader.get_footer_text
        ret = fn(doc, section_index=section_index, which=which)
        got = ret["has_part"]
        want = a["value"]
        return got is want, f"{kind}.{which} has_part={got} 期望={want}"


def _p_text(p_elem) -> str:
    """用 lxml 直接拼接段落文本（不依赖 python-docx 的 .text 属性，
    后者在 run 含非 <w:t> 子元素时会返回 None 导致 join 异常）。"""
    if p_elem is None:
        return ""
    parts = []
    for r in p_elem.findall(_w("r")):
        for t in r.findall(_w("t")):
            parts.append(t.text or "")
    for hl in p_elem.findall(_w("hyperlink")):
        for r in hl.findall(_w("r")):
            for t in r.findall(_w("t")):
                parts.append(t.text or "")
    return "".join(parts)


def _tc_text(tc_elem) -> str:
    """单元格内所有段落文本拼接（lxml 方式）。"""
    if tc_elem is None:
        return ""
    return " / ".join(_p_text(p) for p in tc_elem.findall(_w("p")))


def _rpr_equal(rpr_a, rpr_b) -> bool:
    """比较两个 rPr 节点是否相等。

    用与 verifier.extract_style_fingerprint 一致的规范化方式：只比对
    w: 命名空间下的子元素及其属性，忽略命名空间声明差异（跨文档时
    源/目标的 ns 声明集合不同，裸序列化会误判不等）。
    """
    def norm(rpr):
        if rpr is None:
            return {}
        out = {}
        for child in rpr:
            q = etree.QName(child.tag)
            if q.namespace != W_NS:
                continue
            attrs = {}
            for k, v in child.attrib.items():
                aq = etree.QName(k)
                if aq.namespace == W_NS:
                    attrs[aq.localname] = str(v)
            out[q.localname] = attrs
        return out
    return norm(rpr_a) == norm(rpr_b)


# ============================================================================
# 产物生成：before_after.xml / style_report.json / summary.md
# ============================================================================
def gen_before_after_xml(runner: TestRunner, out_dir: str):
    """生成操作前后关键区域 XML 对比。"""
    path = os.path.join(out_dir, "before_after.xml")

    def dump_doc(doc, label):
        lines = [f"  <!-- {label} -->"]
        if doc is None:
            lines.append("  <none/>")
            return "\n".join(lines)
        # 取前 12 个段落 + 表格作为关键区域
        body = doc.element.body
        cnt = 0
        for c in body:
            tag = _local(c.tag)
            if tag in ("p", "tbl") and cnt < 15:
                xml = etree.tostring(c, pretty_print=True, encoding="unicode")
                lines.append(xml.rstrip())
                cnt += 1
            elif tag == "sectPr":
                lines.append("  <!-- sectPr 省略 -->")
        return "\n".join(lines)

    before_xml = dump_doc(runner.before_doc, "BEFORE (base.docx)")
    after_xml = dump_doc(runner.after_doc, "AFTER (result)")

    content = f"<before_after>\n{before_xml}\n{after_xml}\n</before_after>\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def gen_style_report_json(runner: TestRunner, out_dir: str):
    path = os.path.join(out_dir, "style_report.json")
    report = runner.style_report if runner.style_report is not None else \
             {"not_applicable": True, "reason": "无样式校验"}
    # 序列化前清理不可序列化对象
    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, list):
            return [clean(x) for x in o]
        if isinstance(o, (str, int, float, bool)) or o is None:
            return o
        return str(o)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean(report), f, ensure_ascii=False, indent=2)
    return path


def gen_summary_md(runner: TestRunner, checker: AssertionChecker, out_dir: str):
    path = os.path.join(out_dir, "summary.md")
    case = runner.case
    lines = []
    lines.append(f"# {runner.tid} {case['name']}")
    lines.append("")
    lines.append(f"- **描述**：{case['description']}")
    lines.append(f"- **被测函数**：`{case['target_function']}`")
    lines.append(f"- **场景**：{case.get('category', '?')}")
    lines.append("")
    lines.append("## 输入参数")
    lines.append("```json")
    lines.append(json.dumps(case["input"], ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")

    # 执行情况
    if runner.raised_exc is not None:
        lines.append("## 执行结果")
        lines.append(f"- ❌ 函数抛异常：`{type(runner.raised_exc).__name__}: {runner.raised_exc}`")
    else:
        lines.append("## 执行结果")
        lines.append("- ✅ 函数正常执行")
        if runner.ret and isinstance(runner.ret, dict):
            meta = {k: v for k, v in runner.ret.items()
                    if k in ("new_paragraph_index", "deleted_paragraph_index",
                             "new_row_index", "copied_images", "remapped_bookmarks",
                             "num_map", "output_path", "summary")}
            if meta:
                lines.append(f"- 元信息：`{meta}`")
    lines.append("")

    # 断言
    lines.append("## 断言结果")
    lines.append("| 断言 | 结果 | 说明 |")
    lines.append("|------|------|------|")
    all_pass = True
    for r in checker.results:
        mark = "✅" if r["pass"] else "❌"
        if not r["pass"]:
            all_pass = False
        lines.append(f"| `{r['assertion']}` | {mark} | {r['detail']} |")
    lines.append("")

    # 样式校验结论
    lines.append("## 样式校验结论")
    sr = runner.style_report
    if sr is None:
        lines.append("- 未生成样式校验报告")
    elif sr.get("not_applicable"):
        lines.append(f"- 不适用：{sr.get('reason', '')}")
    elif sr.get("skipped"):
        lines.append(f"- 跳过：{sr.get('reason', '')}")
    elif sr.get("type") == "xdoc":
        lines.append("- 跨文档复制，依赖注入情况：")
        lines.append(f"  - 复制图片：{sr.get('copied_images')}")
        lines.append(f"  - 复制样式：{sr.get('copied_styles')}")
        lines.append(f"  - 编号映射：{sr.get('num_map')}")
        lines.append(f"  - 重映射书签：{sr.get('remapped_bookmarks')}")
    elif sr.get("error"):
        lines.append(f"- ❌ 校验出错：{sr.get('error')}")
    else:
        unexpected = sr.get("unexpected_changes", [])
        styles_changed = sr.get("styles_xml_changed", False)
        prefix_ok = sr.get("prefix_unchanged")
        if not unexpected and not styles_changed:
            if prefix_ok is True:
                lines.append("- ✅ 无意外样式改动（前缀零差异，styles.xml 未变）")
            else:
                lines.append("- ✅ 无意外样式改动，styles.xml 未变")
        else:
            if prefix_ok is False:
                lines.append(f"- ❌ 前缀零差异判定未通过：{sr.get('prefix_detail', '')}")
            lines.append(f"- ❌ 发现 {len(unexpected)} 处意外改动，styles.xml changed={styles_changed}")
            for d in unexpected[:5]:
                lines.append(f"  - {d}")
    lines.append("")

    # 人工确认点
    lines.append("## 需人工重点确认")
    hints = _human_hints(runner)
    for h in hints:
        lines.append(f"- {h}")
    lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path, all_pass


def _human_hints(runner: TestRunner):
    """根据测试类型生成人工确认提示。"""
    hints = []
    fn = runner.func_name
    name = runner.case["name"]

    if runner.raised_exc is not None and runner.case.get("category") == "exception":
        hints.append("异常类测试：函数按预期抛出异常，无需打开文档。")
        return hints

    if runner.result_path:
        hints.append(f"请用 Word 打开 `result.docx`，确认修改符合预期、视觉样式无损。")

    if "insert" in name or "copy" in name or "xdoc" in name:
        hints.append("重点确认：新增/粘贴内容的字体、字号、加粗等与源段落视觉一致。")
    if "image" in name or "图片" in runner.case["description"]:
        hints.append("重点确认：图片正常显示（非红叉），尺寸位置正确。")
    if "table" in fn or "cell" in fn:
        hints.append("重点确认：表格边框、单元格宽度、行高未被破坏。")
    if "list" in name or "编号" in runner.case["description"] or "numId" in runner.case["description"]:
        hints.append("重点确认：列表编号/项目符号显示正常，序号连续。")
    if "bookmark" in name or "书签" in runner.case["description"]:
        hints.append("重点确认：书签未产生重复 id 冲突，文档无错误提示。")
    if "delete" in fn:
        hints.append("重点确认：删除后剩余内容排版未错乱。")
    if not hints:
        hints.append("确认整体文档可正常打开、无明显异常。")
    return hints


def _ensure_test_image():
    """从 base.docx 的 word/media/image1.png 提取一张测试图片到 output/_test_img.png。
    供 insert_image 测试用。幂等（已存在则跳过）。"""
    test_img = os.path.join(OUTPUT_DIR, "_test_img.png")
    if os.path.exists(test_img):
        return test_img
    with zipfile.ZipFile(BASE) as z:
        with z.open("word/media/image1.png") as src, \
             open(test_img, "wb") as dst:
            dst.write(src.read())
    return test_img


# ============================================================================
# 主流程
# ============================================================================
def main():
    with open(CASES_PATH, encoding="utf-8") as f:
        all_cases = json.load(f)
    cases = {k: v for k, v in all_cases.items() if not k.startswith("_")}

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    _ensure_test_image()
    overview_rows = []
    pass_count = 0
    fail_count = 0

    print(f"共 {len(cases)} 条测试用例，开始执行...\n")

    for tid, case in cases.items():
        name = case["name"]
        out_dir = os.path.join(OUTPUT_DIR, f"{tid}_{name}")
        os.makedirs(out_dir, exist_ok=True)

        runner = TestRunner(tid, case)
        runner.run_function()

        # 保存 result.docx
        runner.save_result(out_dir)

        # 生成 before_after.xml（仅标准流程）
        if runner.before_doc is not None or runner.after_doc is not None:
            gen_before_after_xml(runner, out_dir)

        # 样式校验报告
        runner.gen_style_report()
        gen_style_report_json(runner, out_dir)

        # 断言
        checker = AssertionChecker(runner)
        checker.check_all()
        assertion_pass = all(r["pass"] for r in checker.results)
        if assertion_pass:
            pass_count += 1
        else:
            fail_count += 1

        # summary.md
        _, _ = gen_summary_md(runner, checker, out_dir)

        # 样式校验结论
        sr = runner.style_report
        if sr is None:
            style_conclusion = "未校验"
        elif sr.get("not_applicable"):
            style_conclusion = "不适用"
        elif sr.get("skipped"):
            style_conclusion = "跳过(异常)"
        elif sr.get("type") == "xdoc":
            prefix_ok = sr.get("prefix_unchanged")
            dep = f"图{sr.get('copied_images')}/样式{len(sr.get('copied_styles', {}))}/编号{len(sr.get('num_map', {}))}"
            # 跨文档：目标 styles/numbering 新增依赖属预期，只看前缀零差异
            if prefix_ok:
                style_conclusion = f"✅跨文档无意外({dep})"
            else:
                style_conclusion = f"❌跨文档({dep})前缀差异"
        elif sr.get("error"):
            style_conclusion = "❌校验出错"
        else:
            unexpected = sr.get("unexpected_changes", [])
            sc = sr.get("styles_xml_changed", False)
            prefix_ok = sr.get("prefix_unchanged")
            if not unexpected:
                # 无意外改动（styles.xml 变化可能属预期，如 create_paragraph_style）
                if prefix_ok is True:
                    style_conclusion = "✅无意外(前缀零差异)"
                elif sc:
                    style_conclusion = "✅无意外(styles.xml预期变化)"
                else:
                    style_conclusion = "✅无意外改动"
            else:
                style_conclusion = f"❌{len(unexpected)}处意外"

        # 人工确认要点（取第一条提示）
        hints = _human_hints(runner)
        human_hint = hints[0] if hints else ""

        overview_rows.append({
            "id": tid, "name": name, "category": case.get("category", ""),
            "assertion": "✅ 通过" if assertion_pass else "❌ 失败",
            "style": style_conclusion,
            "human": human_hint,
        })

        mark = "✅" if assertion_pass else "❌"
        print(f"  {mark} {tid} {name}  [{assertion_pass and 'PASS' or 'FAIL'}]  样式:{style_conclusion}")

    # 生成 OVERVIEW.md
    _gen_overview(overview_rows, pass_count, fail_count)
    print(f"\n完成：{pass_count} 通过 / {fail_count} 失败 / 共 {len(cases)} 条")
    print(f"汇总：{os.path.join(OUTPUT_DIR, 'OVERVIEW.md')}")


def _gen_overview(rows, pass_count, fail_count):
    path = os.path.join(OUTPUT_DIR, "OVERVIEW.md")
    lines = []
    lines.append("# 测试执行总览（OVERVIEW）")
    lines.append("")
    lines.append(f"- **总用例数**：{len(rows)}")
    lines.append(f"- **通过**：{pass_count} ✅")
    lines.append(f"- **失败**：{fail_count} ❌")
    lines.append("")
    lines.append("> 说明：自动断言通过 ≠ 视觉正确。最终以人工审查 summary.md 与 result.docx 为准。")
    lines.append("")
    lines.append("| 测试项 | 名称 | 场景 | 自动断言 | 样式校验 | 需人工确认 |")
    lines.append("|--------|------|------|---------|---------|-----------|")
    for r in rows:
        lines.append(f"| {r['id']} | {r['name']} | {r['category']} | {r['assertion']} | {r['style']} | {r['human']} |")
    lines.append("")
    # 失败清单
    fails = [r for r in rows if "失败" in r["assertion"]]
    if fails:
        lines.append("## 失败用例清单")
        lines.append("")
        for r in fails:
            lines.append(f"- **{r['id']} {r['name']}** — {r['style']}")
        lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


if __name__ == "__main__":
    main()
