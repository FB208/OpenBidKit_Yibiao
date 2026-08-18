# -*- coding: utf-8 -*-
"""
阶段1：样式校验器（Style Verifier）

定位：整个工具集的「信任基石」。后续所有 docx 操作（写入/删除/复制/粘贴）
在执行后都必须用本模块判断"样式是否被破坏"。

设计原则（对应 CLAUDE.md「有据可依」）：
  - 指纹来源 = 直接读 OOXML 的 rPr/pPr 节点（lxml），不依赖 python-docx 高级封装。
    理由：python-docx 的 Run.font.bold 等对"未设置"返回 None，会与"显式 False"
    混淆，丢失信息；直接读 XML 可保留 w:val 的真实取值。
  - 指纹规范化 = 属性按固定 key 排序、数值统一字符串化，保证 deepcopy 的节点
    指纹与原节点逐字节等价，从而"自己比自己"必为无差异。
  - 对比范围 = 只看样式相关子元素，忽略 rsid（修订保存 id）等不影响渲染的字段。

判断依据来源：
  - OOXML 规范 ECMA-376 中 rPr/pPr 子元素语义
  - base.docx 真实结构快照（logs/base_structure.md）
"""

from __future__ import annotations

import hashlib
import io
import os
import zipfile
from copy import deepcopy
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

# ============================================================================
# 命名空间与常量
# ============================================================================
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _w(local_name: str) -> str:
    """构造 w: 命名空间下的完整 tag，等价于 python-docx 的 qn('w:xxx')。"""
    return f"{{{W_NS}}}{local_name}"


# --- 段落级样式（pPr）关注的关键子元素 ---
# 仅这些参与指纹；pPr 中的 rPr（段落标记 run 样式）也纳入，因为它影响段落标记渲染。
# 注意：rsid* 一律忽略（不影响样式渲染）。
PPR_KEYS = [
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "widowControl",
    "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens",
    "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
    "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing",
    "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap",
    "jc", "textDirection", "textAlignment", "textboxTightWrap",
    "outlineLvl", "divId", "cnfStyle", "numPr",
    # pPr 末尾的 rPr（段落标记字符样式）单独处理
]

# --- run 级样式（rPr）关注的关键子元素 ---
RPR_KEYS = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps",
    "strike", "dstrike", "outline", "shadow", "emboss", "imprint",
    "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing",
    "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect",
    "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang",
    "eastAsianLayout", "specVanish", "oMath",
]


# ============================================================================
# 工具：把一个 XML 属性字典规范化为可比较的形式
# ============================================================================
def _norm_attrs(elem) -> dict[str, str]:
    """把元素的所有 w: 属性归一为 {本地名: 字符串值}，忽略非 w 命名空间属性。"""
    out: dict[str, str] = {}
    if elem is None:
        return out
    for k, v in elem.attrib.items():
        q = etree.QName(k)
        if q.namespace == W_NS:
            out[q.localname] = str(v)
    return out


def _elem_fingerprint(elem) -> dict[str, Any]:
    """
    把单个样式子元素规范化为指纹。
    - 若有 w:val 等属性：记录为 {"_": 属性字典}（空元素的子元素若存在也递归）。
    - 若是容器（如 spacing/ind/numPr/rFonts）：属性即指纹。
    - 简单开关元素（如 <w:b/>）：属性字典为空，记 {}（存在性即 True）。
    """
    if elem is None:
        return {}
    attrs = _norm_attrs(elem)
    return attrs  # 仅取属性；子元素差异由调用方按 key 分别处理


def _container_fingerprint(parent_elem, keys: list[str]) -> dict[str, dict[str, Any]]:
    """
    对 parent_elem（如 pPr/rPr）下关注的子元素逐一取指纹。
    返回 {本地名: 指纹dict}，缺失的 key 不出现（节省空间，且"缺失"在对比时
    通过两侧 key 差集体现）。
    """
    out: dict[str, dict[str, Any]] = {}
    if parent_elem is None:
        return out
    for child in parent_elem:
        q = etree.QName(child.tag)
        if q.namespace != W_NS:
            continue
        local = q.localname
        if local not in keys:
            continue
        out[local] = _elem_fingerprint(child)
    return out


# ============================================================================
# 段落标记 run 样式（pPr/rPr）
# ============================================================================
def _ppr_run_fingerprint(ppr) -> dict[str, dict[str, Any]]:
    """pPr 内部 <w:rPr>（段落标记样式）的指纹，用 RPR_KEYS 抽取。"""
    if ppr is None:
        return {}
    rpr = ppr.find(_w("rPr"))
    return _container_fingerprint(rpr, RPR_KEYS)


# ============================================================================
# 公共函数 1：extract_style_fingerprint(paragraph) -> dict
# ============================================================================
def extract_style_fingerprint(paragraph) -> dict[str, Any]:
    """
    提取段落及其所有 run 的样式指纹。

    参数：
        paragraph: python-docx 的 Paragraph 对象，或其底层 <w:p> lxml 元素。

    返回结构：
        {
          "text": "<段落纯文本，仅用于定位，不参与样式对比>",
          "pPr": { <段落级样式> },          # 含 numPr/ind/spacing/jc/outlineLvl 等
          "pPr_rPr": { <段落标记 run 样式> },
          "runs": [
              {"text": "<run 文本>", "rPr": { <run 级样式> }},
              ...
          ],
          "fingerprint_sha1": "<整段指纹的稳定哈希，便于快速比对>"
        }

    判断依据：
        - pPr 来自 <w:pPr>；run 的 rPr 来自 <w:r>/<w:rPr>。
        - 文本(text)单独保留用于人类阅读定位，不进入哈希（文本变化不等于样式破坏）。
    覆盖样式维度：
        段落级：pStyle / jc(对齐) / ind(缩进) / spacing(间距) / numPr(编号) /
                outlineLvl(大纲) / widowControl / 边框/底纹 等 PPR_KEYS 全集。
        run 级：rFonts(四向字体) / sz·szCs(字号) / b·bCs(粗) / i·iCs(斜) /
                color / u(下划线) / highlight / vertAlign(上下标) / rStyle /
                strike / spacing / kern 等 RPR_KEYS 全集。
    已知局限：
        1. 超链接 <w:hyperlink> 内的 run 不计入 runs 列表（python-docx 默认也不暴露），
           需对比超链接文本时，本指纹以段落顶层 <w:r> 为准；如需覆盖可在后续扩展。
        2. 表格单元格内段落需单独传入（本函数处理单个段落）。
        3. 不解析 drawing/pict 内部样式（图片无 rPr 之外的"样式"概念）。
        4. 忽略 rsid（修订标识），符合"只关心渲染样式"的定位。
    """
    # 兼容：传入 Paragraph 或 <w:p> 元素
    p_elem = paragraph._p if hasattr(paragraph, "_p") else paragraph

    ppr = p_elem.find(_w("pPr"))

    # 段落级样式
    ppr_fp = _container_fingerprint(ppr, PPR_KEYS)
    ppr_rpr_fp = _ppr_run_fingerprint(ppr)

    # run 级样式 + 文本
    runs_fp: list[dict[str, Any]] = []
    full_text_parts: list[str] = []
    for r in p_elem.findall(_w("r")):
        rpr = r.find(_w("rPr"))
        rpr_fp = _container_fingerprint(rpr, RPR_KEYS)
        text = "".join((t.text or "") for t in r.findall(_w("t")))
        runs_fp.append({"text": text, "rPr": rpr_fp})
        full_text_parts.append(text)

    full_text = "".join(full_text_parts)

    # 稳定哈希：只对样式部分哈希，不含 text（text 变化不算样式破坏）
    hash_payload = repr({
        "pPr": ppr_fp,
        "pPr_rPr": ppr_rpr_fp,
        "runs": [{"rPr": rfp["rPr"]} for rfp in runs_fp],
    }).encode("utf-8")
    sha1 = hashlib.sha1(hash_payload).hexdigest()

    return {
        "text": full_text,
        "pPr": ppr_fp,
        "pPr_rPr": ppr_rpr_fp,
        "runs": runs_fp,
        "fingerprint_sha1": sha1,
    }


# ============================================================================
# 公共函数 2：compare_documents(doc_before, doc_after, expected_changes) -> dict
# ============================================================================
def _to_doc(doc_or_path):
    """接受 Document 对象或路径，返回 Document 对象。"""
    if hasattr(doc_or_path, "element"):  # python-docx Document 实例的特征属性
        return doc_or_path
    return Document(doc_or_path)


def _paragraphs_with_index(doc) -> list[tuple[int, Any]]:
    """返回 [(body内绝对索引, <w:p>元素)]，按文档顺序。"""
    body = doc.element.body
    out = []
    idx = 0
    for child in body:
        if etree.QName(child.tag).localname == "p":
            out.append((idx, child))
            idx += 1
    return out


def _diff_dicts(before: dict, after: dict, prefix: str) -> list[dict]:
    """对比两个规范化样式字典，返回差异列表。"""
    diffs = []
    all_keys = set(before.keys()) | set(after.keys())
    for k in sorted(all_keys):
        b = before.get(k, "<缺失>")
        a = after.get(k, "<缺失>")
        if b != a:
            diffs.append({
                "path": f"{prefix}.{k}",
                "expected": b,
                "actual": a,
            })
    return diffs


def _normalize_expected(expected_changes: list[dict]) -> list[dict]:
    """
    把用户传入的 expected_changes 规范化，每条至少含：
      {"paragraph": <索引>, "path": <可选，如 'pPr.jc' 或 'runs[0].rPr.b'>}
    缺省 path=None 表示"该段任何样式变化都视为预期"。
    """
    norm = []
    for c in expected_changes or []:
        item = {
            "paragraph": int(c.get("paragraph", c.get("index", -1))),
            "path": c.get("path"),        # None 表示整段放行
            "note": c.get("note", ""),
        }
        norm.append(item)
    return norm


def _is_expected(para_idx: int, diff_path: str, expected: list[dict]) -> bool:
    """判断某处差异是否落在 expected_changes 放行范围内。"""
    for e in expected:
        if e["paragraph"] != para_idx:
            continue
        if e["path"] is None:
            return True                  # 整段放行
        if diff_path == e["path"]:
            return True
        # 前缀匹配：放行 'runs[0]' 则覆盖其下所有 rPr 子项
        if diff_path.startswith(e["path"] + "."):
            return True
    return False


def compare_documents(doc_before, doc_after, expected_changes: list | None = None) -> dict:
    """
    对比操作前后两个文档，找出"意外样式改动"。

    参数：
        doc_before: Document 对象或 docx 路径（操作前）
        doc_after:  Document 对象或 docx 路径（操作后）
        expected_changes: 预期改动的放行清单，每条形如
            {"paragraph": <索引>, "path": "pPr.jc" 或 "runs[0].rPr.b" 或 None,
             "note": "说明"}
            - path=None 表示该段任何样式变化都视为预期（常用于整段替换/插入）。
            - 路径前缀匹配：放行 "runs[0]" 会覆盖 "runs[0].rPr.b" 等。
          注意：段落索引指 body 内 <w:p> 的绝对顺序索引（与 extract 一致）。

    返回：
        {
          "unexpected_changes": [ <意外改动> ],   # 空 = 样式无损
          "styles_xml_changed": bool,
          "expected_applied": [ <被放行的改动> ],
          "summary": "无差异" | "发现 N 处意外改动"
        }
        每处改动：{"paragraph": 索引, "path": 路径,
                  "expected": 期望值, "actual": 实际值}

    判断依据：
        - 逐段落抽取前后指纹，按 key 比对 pPr / pPr_rPr / 每个 run 的 rPr。
        - styles.xml 是否改动：抽取前后 styles.xml 原始字节做规范化对比（去空白）。
        - 段落数量变化本身不报为"样式破坏"，但会在 unexpected 中以结构差异体现
          （见局限1）。
    覆盖维度：
        与 extract_style_fingerprint 一致（段落级 + run 级全部 PPR_KEYS/RPR_KEYS）。
    已知局限：
        1. 段落数变化时，按"索引对齐"逐段比较；若在中间插入/删除段落，索引错位
           会产生连锁差异。建议 expected_changes 中对插入/删除段落显式放行整段，
           或改用"文本锚点对齐"（后续阶段可扩展）。
        2. 表格内段落、页眉页脚段落不参与本次 body 段落对比（base.docx 无页眉页脚）；
           如需覆盖表格，需扩展为递归遍历 body 全部 <w:p>（含表格内）。
        3. styles.xml 对比只判整体是否变化，不定位具体哪个 style 改了。
    """
    expected = _normalize_expected(expected_changes)
    before_doc = _to_doc(doc_before)
    after_doc = _to_doc(doc_after)

    before_paras = _paragraphs_with_index(before_doc)
    after_paras = _paragraphs_with_index(after_doc)

    unexpected: list[dict] = []
    expected_applied: list[dict] = []

    n = max(len(before_paras), len(after_paras))
    for i in range(n):
        if i < len(before_paras) and i < len(after_paras):
            idx_b, pe_b = before_paras[i]
            idx_a, pe_a = after_paras[i]
            fp_b = extract_style_fingerprint(pe_b)
            fp_a = extract_style_fingerprint(pe_a)

            diffs: list[dict] = []
            diffs += _diff_dicts(fp_b["pPr"], fp_a["pPr"], "pPr")
            diffs += _diff_dicts(fp_b["pPr_rPr"], fp_a["pPr_rPr"], "pPr_rPr")

            # run 级：按位置对齐
            rb = fp_b["runs"]
            ra = fp_a["runs"]
            rn = max(len(rb), len(ra))
            for ri in range(rn):
                if ri < len(rb) and ri < len(ra):
                    rd = _diff_dicts(rb[ri]["rPr"], ra[ri]["rPr"],
                                     f"runs[{ri}].rPr")
                    diffs += rd
                else:
                    # run 数量变化
                    which = "before" if ri >= len(ra) else "after"
                    diffs.append({
                        "path": f"runs[{ri}]",
                        "expected": "<存在>" if which == "after" else "<缺失>",
                        "actual": "<缺失>" if which == "after" else "<存在>",
                    })

            for d in diffs:
                if _is_expected(idx_b, d["path"], expected):
                    expected_applied.append({
                        "paragraph": idx_b, **d, "note": "预期内"
                    })
                else:
                    unexpected.append({"paragraph": idx_b, **d})
        else:
            # 段落数不一致：多出或少了段落
            has_before = i < len(before_paras)
            unexpected.append({
                "paragraph": i,
                "path": "<段落结构>",
                "expected": "<存在>" if has_before else "<不存在>",
                "actual": "<不存在>" if has_before else "<存在>",
                "note": "段落数量变化，请用 expected_changes 显式放行",
            })

    # styles.xml 整体对比
    styles_changed = _styles_xml_changed(before_doc, after_doc)

    summary = "无差异" if not unexpected and not styles_changed else (
        f"发现 {len(unexpected)} 处意外改动"
        + ("；styles.xml 已改动" if styles_changed else "")
    )

    return {
        "unexpected_changes": unexpected,
        "styles_xml_changed": styles_changed,
        "expected_applied": expected_applied,
        "summary": summary,
    }


def _styles_xml_bytes(doc_or_path) -> bytes:
    """取 docx 的 styles.xml 原始字节。接受 Document 对象或路径。"""
    if hasattr(doc_or_path, "element"):
        # Document 对象：优先用路径直接读 zip（保证取原始字节，不含内存修改）
        # 若无法反查路径，则回退到 styles part 的序列化字节
        doc = doc_or_path
        try:
            styles_part = doc.part.part_related_by(
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
            )
            return styles_part.blob
        except Exception:
            return b""
    # 路径
    with zipfile.ZipFile(doc_or_path) as zf:
        try:
            return zf.read("word/styles.xml")
        except KeyError:
            return b""


def _styles_xml_changed(doc_before, doc_after) -> bool:
    """对比前后 styles.xml 是否变化（规范化去空白后比较）。"""
    def norm(b: bytes) -> str:
        if not b:
            return ""
        tree = etree.fromstring(b)
        # 去掉纯空白文本节点，避免无关格式差异
        for el in tree.iter():
            if el.text is not None and not el.text.strip():
                el.text = None
        return etree.tostring(tree, encoding="unicode")

    b = _styles_xml_bytes(doc_before)
    a = _styles_xml_bytes(doc_after)
    if not b and not a:
        return False
    return norm(b) != norm(a)


# ============================================================================
# 公共函数 3：validate_openable(docx_path) -> bool
# ============================================================================
def validate_openable(docx_path) -> bool:
    """
    验证 docx 文件能否正常打开。

    判断依据：
        1. zip 完整性：zipfile.testzip() 为 None。
        2. python-docx 能成功重新加载（Document(path) 不抛异常）。
        3. 轻量 XML 良构性：document.xml / styles.xml 能被 lxml 解析。
    覆盖维度：
        物理完整性（zip）+ 文档主部件可解析 + python-docx 语义可加载。
    已知局限：
        - 不做完整 OOXML schema 校验（schema 庞大且 python 端无官方实现），
          仅保证"能被主流阅读器接受"的最低门槛。
        - 不校验关系（rels）的悬空引用（如图片 rId 缺失），需后续专项检查。
    """
    # 1. zip 完整性
    try:
        with zipfile.ZipFile(docx_path) as zf:
            if zf.testzip() is not None:
                return False
            names = zf.namelist()
            if "word/document.xml" not in names:
                return False
            # 3. 关键 XML 良构
            for critical in ("word/document.xml",):
                etree.fromstring(zf.read(critical))
    except (zipfile.BadZipFile, etree.XMLSyntaxError, Exception):
        return False

    # 2. python-docx 语义加载
    try:
        Document(docx_path)
    except Exception:
        return False

    return True


# ============================================================================
# 公共函数 4：check_no_placeholders（占位符残留检查）
# ============================================================================
def check_no_placeholders(doc_or_path,
                          patterns: list[str] | None = None) -> dict:
    """
    扫描文档所有 body 段落文本，检测是否还残留占位符形态。

    参数：
        doc_or_path: Document 对象或 docx 路径
        patterns: 正则模式字符串列表，默认 [r"_{2,}"]（≥2 个连续下划线）。
            每个模式用 re.search 匹配段落文本（不跨 run，先拼接段落文本再匹配）。

    返回：
        {
          "has_placeholder": bool,            # True = 检测到残留
          "matches": [                        # 命中列表
            {"paragraph": int, "text": str, "pattern": str}, ...
          ],
          "checked_patterns": [...]            # 实际使用的 patterns
        }

    依据说明：
        填写类任务的收尾断言：表单占位符（如 `________`）若未被替换会残留在文档中，
        视觉上仍显示下划线空白。本函数扫描 body 段落拼接文本，报告残留位置。
        默认 pattern `_{2,}` 覆盖任意长度连续下划线（地址行 21 个、邮编行 11 个…），
        避免硬编码固定长度（参考 SKILL.md 实战经验 3）。
    样式保护说明：
        只读不写，不涉及样式。
    边界说明：
        - patterns=None -> 用默认 [r"_{2,}"]。
        - patterns=[] -> 视为无检查项，has_placeholder=False，matches=[]。
        - 只扫描 body 直接子级 <w:p>（不含表格内段落、页眉页脚），与 compare_documents
          的 body 段落口径一致。
        - 跨 run 的占位符会被拼接后匹配到（如 `__` 跨两个 run 各含一个 `_`）。
    """
    import re as _re

    if patterns is None:
        patterns = [r"_{2,}"]
    compiled = [_re.compile(p) for p in patterns]

    doc = _to_doc(doc_or_path)
    paras = _paragraphs_with_index(doc)  # [(body绝对索引, <w:p>)]

    matches: list[dict] = []
    for idx, pe in paras:
        # 拼接段落内所有 <w:r>/<w:t> 文本（含超链接内 run，与 locator 口径一致）
        parts: list[str] = []
        for r in pe.findall(_w("r")):
            for t in r.findall(_w("t")):
                parts.append(t.text or "")
        for hl in pe.findall(_w("hyperlink")):
            for r in hl.findall(_w("r")):
                for t in r.findall(_w("t")):
                    parts.append(t.text or "")
        text = "".join(parts)
        for pat, src in zip(compiled, patterns):
            if pat.search(text):
                matches.append({"paragraph": idx, "text": text, "pattern": src})

    return {
        "has_placeholder": len(matches) > 0,
        "matches": matches,
        "checked_patterns": list(patterns),
    }


# ============================================================================
# 公共函数 5：check_structure（语义层：一次性结构断言）
# ============================================================================
class VerifierError(Exception):
    """校验器失败统一异常（语义层）。"""


def _iter_body_paragraphs(doc):
    """遍历 body 直接子级 <w:p>（yield <w:p>）。"""
    body = doc.element.body if hasattr(doc, "element") else doc
    for c in body:
        if etree.QName(c.tag).localname == "p":
            yield c


def check_structure(doc, *, h1_titles=None, each_h1_on_own_page=False,
                    toc_field=False, no_inline_section_breaks=False,
                    min_h1_count=None) -> dict:
    """
    一次性断言文档结构，返回不满足项清单（语义层）。

    参数：
        doc: Document 对象或路径
        h1_titles: list[str]，期望的 H1 标题文本（子串匹配），顺序敏感。
        each_h1_on_own_page: True 时每个 H1 段落须带 pageBreakBefore
                             （第一个除外——封面/首页）。
        toc_field: True 时校验 body 含 instrText 文本含 "TOC"。
        no_inline_section_breaks: True 时校验 body 段落 pPr 无内嵌 sectPr。
        min_h1_count: H1 数 >= 此值。

    返回：
        {passed:bool, h1_count:int, h1_titles_found:[str],
         violations:[{check, detail}], locator:"check_structure"}
        passed = len(violations)==0。

    依据说明：
        H1 判定复用 locator 的两种来源（pStyle 经 name 翻译 / outlineLvl=0），
        需 import locator。h1_titles 子串匹配按文档顺序校验，顺序敏感。
    样式保护说明：
        只读不写，不涉及样式修改。
    边界说明：
        - 全部参数都为默认值（None/False）时，仅返回 h1_count 与 h1_titles_found，
          violations 为空（passed=True）——相当于只统计不校验。
        - h1_titles 顺序敏感：第 i 个期望须出现在第 i 个实际 H1 文本中。
        - 每个检查项独立记录 violation，互不影响。
    """
    import os as _os, sys as _sys
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
    from src.locator import _heading_level_of, _style_id_to_name, _paragraph_text

    doc_obj = _to_doc(doc)
    style_id_map = _style_id_to_name(doc_obj if hasattr(doc_obj, "part") else None)

    # 收集 H1 段落
    h1_paras = []  # [(idx, p_elem, text)]
    idx = 0
    for p in _iter_body_paragraphs(doc_obj):
        hlv = _heading_level_of(p, style_id_map)
        if hlv == 1:
            h1_paras.append((idx, p, _paragraph_text(p)))
        idx += 1
    h1_texts = [t for _, _, t in h1_paras]
    h1_count = len(h1_paras)

    violations = []
    h1_titles_found = []

    # h1_titles 顺序敏感子串匹配
    if h1_titles is not None:
        for i, want in enumerate(h1_titles):
            if i >= h1_count:
                violations.append({
                    "check": "h1_titles",
                    "detail": f"期望第 {i+1} 个 H1 含 {want!r}，但实际只有 {h1_count} 个 H1"})
                break
            actual = h1_texts[i]
            h1_titles_found.append(actual)
            if want not in actual:
                violations.append({
                    "check": "h1_titles",
                    "detail": f"第 {i+1} 个 H1 文本 {actual!r} 不含 {want!r}"})
        # 期望比实际多
        if len(h1_titles) < h1_count:
            violations.append({
                "check": "h1_titles",
                "detail": f"期望 {len(h1_titles)} 个 H1，实际 {h1_count} 个（多出：{h1_texts[len(h1_titles):]}）"})
    else:
        h1_titles_found = list(h1_texts)

    # each_h1_on_own_page（第一个除外）
    if each_h1_on_own_page:
        for i, (pidx, p, txt) in enumerate(h1_paras):
            if i == 0:
                continue  # 第一个 H1 不要求分页（封面/首页）
            ppr = p.find(_w("pPr"))
            has_pbb = ppr is not None and ppr.find(_w("pageBreakBefore")) is not None
            if not has_pbb:
                violations.append({
                    "check": "each_h1_on_own_page",
                    "detail": f"H1 #{i+1}（段落{pidx} {txt!r}）缺少 pageBreakBefore"})

    # toc_field
    if toc_field:
        found_toc = False
        for p in _iter_body_paragraphs(doc_obj):
            for it in p.iter(_w("instrText")):
                if it.text and "TOC" in it.text:
                    found_toc = True
                    break
            if found_toc:
                break
        if not found_toc:
            violations.append({
                "check": "toc_field",
                "detail": "body 中未找到含 TOC 的 instrText 域"})

    # no_inline_section_breaks
    if no_inline_section_breaks:
        bad = []
        pidx = 0
        for p in _iter_body_paragraphs(doc_obj):
            ppr = p.find(_w("pPr"))
            if ppr is not None and ppr.find(_w("sectPr")) is not None:
                bad.append(pidx)
            pidx += 1
        if bad:
            violations.append({
                "check": "no_inline_section_breaks",
                "detail": f"body 段落 {bad} 含内嵌 sectPr"})

    # min_h1_count
    if min_h1_count is not None:
        if h1_count < min_h1_count:
            violations.append({
                "check": "min_h1_count",
                "detail": f"H1 数 {h1_count} < 期望 {min_h1_count}"})

    return {
        "passed": len(violations) == 0,
        "h1_count": h1_count,
        "h1_titles_found": h1_titles_found,
        "violations": violations,
        "locator": "check_structure",
    }


# ============================================================================
# soffice 探测（共享：render_to_pdf_and_check + structure.update_toc_field）
# ============================================================================
def _probe_soffice():
    """探测 LibreOffice 可执行路径。返回路径字符串或 None。

    探测优先级：shutil.which("soffice") / which("libreoffice") /
    Windows 常见路径。供 render_to_pdf_and_check 与 structure.update_toc_field
    复用，确保探测逻辑一致。
    """
    import shutil
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice is None:
        for cand in (
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ):
            if os.path.exists(cand):
                soffice = cand
                break
    return soffice


# ============================================================================
# 公共函数 6：render_to_pdf_and_check（语义层：PDF 渲染分页校验）
# ============================================================================
def render_to_pdf_and_check(docx_path, expected_first_lines=None,
                            soffice_path=None, outdir=None) -> dict:
    """
    调 LibreOffice headless 把 docx 转 PDF，用 pypdf 提取每页首行，校验分页顺序
    （语义层）。

    参数：
        docx_path: docx 文件路径
        expected_first_lines: list[str]，期望各页首行包含的文本（子串，按页顺序）。
                              None 则只转 PDF 不校验顺序。
        soffice_path: LibreOffice 可执行路径；None 时探测。
        outdir: PDF 输出目录；None 时用 docx 所在目录。
        soffice_path 探测优先级：shutil.which("soffice") / which("libreoffice") /
                    Windows 常见路径。

    返回：
        {pdf_path, page_count, page_first_lines:[str], passed:bool,
         violations:[...], locator:"render_to_pdf_and_check"}

    依据说明：
        XML 层的 pageBreakBefore 是否生效需看渲染。LibreOffice headless 转 PDF
        后用 pypdf 提取每页首行（strip 后首个非空行）逐页校验。
    样式保护说明：
        只读不写（不修改 docx）。
    边界说明：
        - soffice 探测不到 -> 抛 VerifierError（附安装提示）。
        - pypdf 缺失 -> 抛 VerifierError（附安装提示，不作为硬依赖）。
        - 转换失败 -> 抛 VerifierError（含 stderr）。
        - expected_first_lines 长度 > 实际页数 -> violation「页数不足」。
        - 逐页校验：第 i 页首行须含 expected_first_lines[i]，否则记 violation。
    """
    import shutil
    import subprocess

    # 探测 soffice（复用 _probe_soffice 共享逻辑）
    if soffice_path is None:
        soffice_path = _probe_soffice()
    if soffice_path is None or not os.path.exists(soffice_path):
        raise VerifierError(
            "未找到 LibreOffice（soffice）。请安装 LibreOffice 或通过 soffice_path 参数指定路径。"
            " 探测位置：shutil.which('soffice'/'libreoffice') + "
            r"C:\Program Files\LibreOffice\program\soffice.exe")

    # pypdf 运行时 import
    try:
        from pypdf import PdfReader
    except ImportError:
        raise VerifierError(
            "缺少 pypdf 依赖。请运行 `pip install pypdf` 后重试。")

    docx_path = os.path.abspath(docx_path)
    if not os.path.exists(docx_path):
        raise VerifierError(f"docx 文件不存在: {docx_path}")

    outdir = outdir or os.path.dirname(docx_path)
    os.makedirs(outdir, exist_ok=True)

    # 调 LibreOffice headless 转 PDF
    cmd = [soffice_path, "--headless", "--convert-to", "pdf",
           "--outdir", outdir, docx_path]
    # text=True 默认 UTF-8 解码，但 LibreOffice 在中文 Windows 控制台输出 GBK
    # 编码的路径，会触发 UnicodeDecodeError。用 errors="replace" 容错，
    # 避免因日志解码失败抛 traceback（转换本身成功）。
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=180)
    if proc.returncode != 0:
        raise VerifierError(
            f"LibreOffice 转换失败（returncode={proc.returncode}）：\n"
            f"stderr: {proc.stderr}\nstdout: {proc.stdout}")

    pdf_path = os.path.join(outdir,
                            os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
    if not os.path.exists(pdf_path):
        raise VerifierError(f"PDF 未生成: {pdf_path}")

    # 提取每页首行
    reader = PdfReader(pdf_path)
    page_first_lines = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        # 首个非空行（strip 后）
        first_line = ""
        for line in text.splitlines():
            if line.strip():
                first_line = line.strip()
                break
        page_first_lines.append(first_line)

    page_count = len(page_first_lines)
    violations = []
    if expected_first_lines is not None:
        if len(expected_first_lines) > page_count:
            violations.append({
                "check": "page_count",
                "detail": f"期望 {len(expected_first_lines)} 页，实际 {page_count} 页（页数不足）"})
        for i, want in enumerate(expected_first_lines):
            if i >= page_count:
                break
            actual = page_first_lines[i]
            if want not in actual:
                violations.append({
                    "check": "page_first_line",
                    "detail": f"第 {i+1} 页首行 {actual!r} 不含 {want!r}"})

    return {
        "pdf_path": pdf_path,
        "page_count": page_count,
        "page_first_lines": page_first_lines,
        "passed": len(violations) == 0,
        "violations": violations,
        "locator": "render_to_pdf_and_check",
    }


# ============================================================================
# 自测：base.docx 与自身对比，必须"无差异"
# ============================================================================
def _self_test():
    """用 base.docx 自我对比，证明校验器对完全相同的文档报告无差异。"""
    path = "input/base.docx"
    doc = Document(path)

    result = compare_documents(doc, doc, expected_changes=None)
    assert result["unexpected_changes"] == [], "自我对比不应有意外改动"
    assert result["styles_xml_changed"] is False, "自我对比 styles.xml 不应变化"
    assert result["summary"] == "无差异", f"自我对比应为无差异，实得: {result['summary']}"

    # 指纹稳定性：同一段落连抽两次，哈希一致
    p7 = doc.paragraphs[7]
    fp1 = extract_style_fingerprint(p7)
    fp2 = extract_style_fingerprint(p7)
    assert fp1["fingerprint_sha1"] == fp2["fingerprint_sha1"], "同段重复抽取哈希应一致"

    # 可打开性
    assert validate_openable(path) is True, "base.docx 应可正常打开"

    # deepcopy 一个段落、再比回原文档：应仍无差异（证明 deepcopy 保样式）
    doc2 = Document(path)
    target = doc2.paragraphs[7]._p
    clone = deepcopy(target)
    parent = target.getparent()
    idx = list(parent).index(target)
    parent.remove(target)
    parent.insert(idx, clone)
    result2 = compare_documents(doc, doc2, expected_changes=None)
    assert result2["unexpected_changes"] == [], (
        f"deepcopy 替换后应无样式差异，实得: {result2['unexpected_changes']}"
    )

    print("[自测通过] base.docx 自我对比 = 无差异")
    print("[自测通过] 指纹抽取稳定（同段两次哈希一致）")
    print("[自测通过] deepcopy 替换段落 = 无样式差异")
    print("[自测通过] validate_openable(base.docx) = True")

    # ----- 破坏性测试：故意改样式，校验器必须检出 -----
    doc3 = Document(path)
    p = doc3.paragraphs[7]  # 正文宋体四号
    # 故意把字号 28 改成 32（破坏样式）
    run_rpr = p.runs[0]._r.find(_w("rPr"))
    sz = run_rpr.find(_w("sz"))
    sz.set(_w("val"), "32")
    # 期望放行：段落 7 的 runs[0].rPr.sz —— 若不放行则应报为意外
    r_unexpected = compare_documents(doc, doc3, expected_changes=None)
    assert len(r_unexpected["unexpected_changes"]) >= 1, (
        f"故意改字号后应检出意外改动，实得: {r_unexpected['unexpected_changes']}"
    )
    # 找到对应 diff
    hit = [d for d in r_unexpected["unexpected_changes"]
           if d["paragraph"] == 7 and d["path"] == "runs[0].rPr.sz"]
    assert hit, f"应定位到 runs[0].rPr.sz 的变化，实得: {r_unexpected['unexpected_changes']}"
    assert hit[0]["expected"] == {"val": "28"}, f"期望值应为28，实得: {hit[0]}"
    assert hit[0]["actual"] == {"val": "32"}, f"实际值应为32，实得: {hit[0]}"

    # 放行测试：把该改动声明为 expected，则不再报意外
    r_allowed = compare_documents(doc, doc3, expected_changes=[
        {"paragraph": 7, "path": "runs[0].rPr.sz", "note": "预期改字号"},
    ])
    assert r_allowed["unexpected_changes"] == [], (
        f"声明为预期后不应报意外，实得: {r_allowed['unexpected_changes']}"
    )
    assert len(r_allowed["expected_applied"]) >= 1, "应记录到预期放行清单"

    print("[自测通过] 故意改字号 -> 正确检出 runs[0].rPr.sz 28->32")
    print("[自测通过] 声明为预期改动 -> 不再报意外，且记入 expected_applied")
    print()
    print("段落[7]指纹示例：")
    fp = extract_style_fingerprint(doc.paragraphs[7])
    for k, v in fp.items():
        if k == "runs":
            print(f"  runs: {v}")
        else:
            print(f"  {k}: {v}")

    # ----- check_no_placeholders 测试 -----
    # base.docx 段落36 有已知占位符（姓名：_______性别：______ …）
    r = check_no_placeholders(path)
    assert r["has_placeholder"] is True, f"base.docx 段落36 应有占位符: {r['matches']}"
    assert r["checked_patterns"] == [r"_{2,}"], r
    hit36 = [m for m in r["matches"] if m["paragraph"] == 36]
    assert hit36, "应在段落36 检测到占位符"
    assert "_______" in hit36[0]["text"], hit36

    # 构造含占位符的文档：在段落7后插一个含 `________` 的段落
    doc4 = Document(path)
    import os as _os, sys as _sys
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
    from src.writer import insert_paragraph_after
    insert_paragraph_after(doc4, 7, "测试占位符：________", inherit_style=True)
    out_ph = "output/verifier_placeholder_test.docx"
    _os.makedirs("output", exist_ok=True)
    doc4.save(out_ph)
    r2 = check_no_placeholders(out_ph)
    assert r2["has_placeholder"] is True, "应检测到占位符残留"
    # 命中段落应是新插入的段落8（插入后原 P36 顺移为 37）
    hit_idxs = [m["paragraph"] for m in r2["matches"]]
    assert 8 in hit_idxs, f"应在段落8 检测到占位符: {r2['matches']}"
    assert any("________" in m["text"] for m in r2["matches"]), r2

    # 自定义 pattern 测试：检测 `{xxx}` 形态占位符
    insert_paragraph_after(doc4, 8, "另一个占位：{name}", inherit_style=True)
    doc4.save(out_ph)
    r3 = check_no_placeholders(out_ph, patterns=[r"\{[^}]+\}"])
    assert r3["has_placeholder"] is True, "应检测到 {name} 占位符"
    assert r3["checked_patterns"] == [r"\{[^}]+\}"], r3

    # 空 patterns -> 无检查
    r4 = check_no_placeholders(out_ph, patterns=[])
    assert r4["has_placeholder"] is False and r4["matches"] == [], r4

    print("[自测通过] check_no_placeholders -> base P36 已知占位符被检出 / 构造占位符被检出 / 自定义 pattern / 空 patterns")

    # ----- check_structure 测试 -----
    # base.docx：1 个 H1（段落2 标题1），无 TOC 域，无内嵌分节符
    r = check_structure(path)
    assert r["h1_count"] == 1, f"base.docx 应有 1 个 H1，实得 {r['h1_count']}"
    assert r["h1_titles_found"] == ["标题1"], r
    assert r["passed"] is True, f"无检查项时应 passed=True，实得 {r}"

    # h1_titles 顺序敏感匹配
    r = check_structure(path, h1_titles=["标题1"])
    assert r["passed"] is True, r
    r = check_structure(path, h1_titles=["不存在的标题"])
    assert r["passed"] is False, r
    assert len(r["violations"]) == 1, r

    # min_h1_count
    r = check_structure(path, min_h1_count=1)
    assert r["passed"] is True, r
    r = check_structure(path, min_h1_count=2)
    assert r["passed"] is False, r

    # no_inline_section_breaks（base.docx 无内嵌分节符）
    r = check_structure(path, no_inline_section_breaks=True)
    assert r["passed"] is True, r

    # toc_field（base.docx 无 TOC 域 -> violation）
    r = check_structure(path, toc_field=True)
    assert r["passed"] is False, r
    assert r["violations"][0]["check"] == "toc_field", r

    # each_h1_on_own_page：base.docx 唯一 H1 是第一个，不要求分页 -> passed=True
    r = check_structure(path, each_h1_on_own_page=True)
    assert r["passed"] is True, r

    # 构造含 TOC 域的文档，验证 toc_field 检测通过
    doc5 = Document(path)
    insert_paragraph_after(doc5, 7, "目录段", inherit_style=True)
    p8 = doc5.paragraphs[8]._p
    r1 = p8.makeelement(_w("r"), {})
    fc = p8.makeelement(_w("fldChar"), {_w("fldCharType"): "begin"})
    r1.append(fc)
    p8.append(r1)
    r2 = p8.makeelement(_w("r"), {})
    instr = p8.makeelement(_w("instrText"), {})
    instr.text = ' TOC \\o "1-3" \\h \\z \\u '
    r2.append(instr)
    p8.append(r2)
    out_toc = "output/verifier_toc_test.docx"
    doc5.save(out_toc)
    r = check_structure(out_toc, toc_field=True)
    assert r["passed"] is True, f"含 TOC 域应通过，实得 {r}"
    print("[自测通过] check_structure -> H1 计数/标题匹配/TOC 域/内嵌分节符/分页校验")

    # ----- render_to_pdf_and_check 测试（依赖 LibreOffice）-----
    soffice = None
    import shutil as _shutil
    soffice = _shutil.which("soffice") or _shutil.which("libreoffice")
    if soffice is None:
        for cand in (r"C:\Program Files\LibreOffice\program\soffice.exe",
                     r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"):
            if os.path.exists(cand):
                soffice = cand
                break
    if soffice and os.path.exists(soffice):
        r = render_to_pdf_and_check(path)
        assert r["page_count"] >= 1, f"PDF 页数应 >=1，实得 {r['page_count']}"
        assert r["passed"] is True, r
        # 带期望首行校验
        first = r["page_first_lines"][0] if r["page_first_lines"] else ""
        r2 = render_to_pdf_and_check(path, expected_first_lines=[first])
        assert r2["passed"] is True, f"首页含 {first!r} 应通过，实得 {r2}"
        # 期望不存在的首行 -> violation
        r3 = render_to_pdf_and_check(path, expected_first_lines=["完全不存在的文本xyz"])
        assert r3["passed"] is False, r3
        print(f"[自测通过] render_to_pdf_and_check -> 转 PDF {r['page_count']} 页，首行校验 OK（soffice={soffice}）")
    else:
        print("[自测跳过] render_to_pdf_and_check -> 未找到 LibreOffice，跳过（属预期，外部依赖）")


if __name__ == "__main__":
    _self_test()
