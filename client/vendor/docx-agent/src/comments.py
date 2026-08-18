# -*- coding: utf-8 -*-
"""
阶段2 模块：批注（Comments）读写

定位：提供批注的增删查能力，基于 python-docx 1.2 comments API + lxml。

================================================================
开发依据（基于 base.docx 真实结构，见 tools/inspect_base.py）
================================================================
1. base.docx P33 含一条批注：id=5, author=Eddy Zhang,
   initials=EZ, date=2026-07-09T10:43:00Z, text=「这是一条批注」。
2. 批注锚点结构（document.xml 内）：
   - <w:commentRangeStart w:id="5"/> 在 P33 段首
   - <w:commentRangeEnd w:id="5"/> 在 P33 段尾
   - <w:r><w:commentReference w:id="5"/></w:r> 在段内
3. 批注内容部件 word/comments.xml：根 <w:comments>，每条 <w:comment> 含
   属性 id/author/date/initials，子元素 <w:p> 含批注正文。
4. 扩展部件（base.docx 有）：
   - word/commentsExtended.xml：<w15:commentEx paraId=.. done=../>
   - word/commentsExtensible.xml：<w16cex:commentExtensible durableId=.. dateUtc=../>
   - word/commentsIds.xml：<w16cid:commentId paraId=.. durableId=../>
   这些扩展部件通过 paraId（批注首个 <w:p> 的 w14:paraId 属性）关联批注，
   删批注时需同步清理避免损坏。
5. python-docx 1.2 提供 doc.add_comment(run, text=, author=, initials=) API，
   会自动建 comments part（若不存在）、插入 commentRangeStart/End/Reference、
   在 comments.xml 中建 <w:comment>。但 add_comment 不管理扩展部件
   （commentsExtended/Extensible/Ids），新增批注时这些部件无新条目（属预期）。

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

from src.writer import _resolve_anchor, _first_text_run, WriterError
from src.locator import locate_by_paragraph_index, LocateError

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml"
W16CID_NS = "http://schemas.microsoft.com/office/word/2016/wordml/cid"
W16CEX_NS = "http://schemas.microsoft.com/office/word/2018/wordml/cex"

REL_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"


def _w(name: str) -> str:
    return f"{{{W_NS}}}{name}"


def _local(tag) -> str:
    return etree.QName(tag).localname


class CommentError(Exception):
    """批注操作失败统一异常。"""


# ============================================================================
# 内部工具
# ============================================================================
def _get_comments_part(doc):
    """取文档的 comments part；不存在返回 None。"""
    try:
        return doc.part.part_related_by(REL_COMMENTS)
    except Exception:
        return None


def _comment_text(comment_elem) -> str:
    """拼接 <w:comment> 内所有 <w:p> 的 <w:r>/<w:t> 文本。"""
    parts = []
    for p in comment_elem.findall(_w("p")):
        for r in p.findall(_w("r")):
            for t in r.findall(_w("t")):
                parts.append(t.text or "")
    return "".join(parts)


def _comment_paraid(comment_elem) -> str | None:
    """取批注首个 <w:p> 的 w14:paraId 属性值；无则 None。"""
    p = comment_elem.find(_w("p"))
    if p is None:
        return None
    return p.get(f"{{{W14_NS}}}paraId")


def _find_anchor_paragraph_index(doc, comment_id: str) -> int | None:
    """根据 comment_id 找到 body 中含对应 commentRangeStart 的段落索引。"""
    body = doc.element.body
    p_idx = 0
    for c in body:
        if _local(c.tag) != "p":
            continue
        for crs in c.findall(_w("commentRangeStart")):
            if crs.get(_w("id")) == comment_id:
                return p_idx
        p_idx += 1
    return None


def _clean_extended_parts(doc, para_id: str | None) -> int:
    """清理扩展部件中引用指定 paraId 的条目。
    返回清理的条目数。
    """
    if para_id is None:
        return 0
    cleaned = 0

    # commentsExtended.xml: <w15:commentEx paraId=..>
    cp = _get_comments_part(doc)
    if cp is None:
        return 0

    # 遍历 doc.part 的所有相关 part
    for rel in doc.part.rels.values():
        if "commentsExtended" in rel.reltype:
            try:
                ext_part = rel.target_part
                root = etree.fromstring(ext_part.blob)
                for elem in root.iter(f"{{{W15_NS}}}commentEx"):
                    if elem.get(f"{{{W14_NS}}}paraId") == para_id:
                        root.remove(elem)
                        cleaned += 1
                ext_part._element = root  # 更新 part 元素
            except Exception:
                pass
        elif "commentsIds" in rel.reltype:
            # commentsIds.xml: <w16cid:commentId paraId=.. durableId=..>
            # 先取 durableId 再删条目
            durable_id = None
            try:
                ids_part = rel.target_part
                root = etree.fromstring(ids_part.blob)
                for elem in root.iter(f"{{{W16CID_NS}}}commentId"):
                    if elem.get(f"{{{W14_NS}}}paraId") == para_id:
                        durable_id = elem.get(f"{{{W16CID_NS}}}durableId")
                        root.remove(elem)
                        cleaned += 1
                ids_part._element = root
            except Exception:
                pass
            # 用 durableId 清理 commentsExtensible.xml
            if durable_id is not None:
                for rel2 in doc.part.rels.values():
                    if "commentsExtensible" in rel2.reltype:
                        try:
                            ext_part2 = rel2.target_part
                            root2 = etree.fromstring(ext_part2.blob)
                            for elem2 in root2.iter(f"{{{W16CEX_NS}}}commentExtensible"):
                                if elem2.get(f"{{{W16CID_NS}}}durableId") == durable_id:
                                    root2.remove(elem2)
                                    cleaned += 1
                            ext_part2._element = root2
                        except Exception:
                            pass
    return cleaned


# ============================================================================
# 公共函数 1：add_comment（P1-8）
# ============================================================================
def add_comment(doc, anchor, text: str, *, author: str = "docx-agent",
                initials: str = "DA") -> dict:
    """
    在锚点段落挂批注（P1-8）。

    参数：
        doc: Document 对象
        anchor: 锚点，复用 writer._resolve_anchor 语义（dict / int / <w:p>）
        text: 批注正文
        author: 作者名（默认 "docx-agent"）
        initials: 缩写（默认 "DA"）

    返回：
        {comment_id, paragraph_index, locator:"add_comment", changes:[...]}

    依据说明：
        优先用 python-docx 1.2 的 doc.add_comment([run], text=, author=, initials=)，
        锚 run = 锚点段首个有文本 run（writer._first_text_run）。add_comment 会自动
        建 comments part（若不存在）、插入 commentRangeStart/End + commentReference、
        在 comments.xml 建 <w:comment>。参考 base.docx P33 批注结构与
        tools/inspect_base.py::collect_comments。
    样式保护说明：
        - 只在锚点段插入 commentRangeStart/End + commentReference run，不动已有
          run/pPr。
        - 批注正文在 comments.xml 的 <w:comment> 内，不影响文档正文样式。
        - styles.xml 不变。
    边界说明：
        - text 空 -> 抛 CommentError。
        - 锚点段无有文本 run -> 抛 CommentError（无锚 run 无法挂批注）。
        - 锚点不可识别 -> 抛 CommentError。
    """
    if not text:
        raise CommentError("text 不能为空")

    try:
        anchor_p = _resolve_anchor(doc, anchor)
    except (WriterError, LocateError) as e:
        raise CommentError(f"锚点解析失败: {e}")

    # _first_text_run 返回 lxml <w:r> 元素，但 python-docx add_comment 需要
    # Run 包装对象。用 _first_text_run 检测是否有文本 run，再用 python-docx
    # paragraphs API 取对应的 Run 包装对象。
    first_r = _first_text_run(anchor_p)
    if first_r is None:
        raise CommentError("锚点段落无有文本 run，无法挂批注")

    # 找到 anchor_p 对应的 python-docx Paragraph 与 Run 对象
    # anchor_p 可能不在 doc.paragraphs 中（如表格内段落），但 add_comment
    # 只需要 Run 对象——通过 Run(element, parent) 包装。
    from docx.text.run import Run
    # 找 parent（段落级别的 parent）
    run_obj = Run(first_r, anchor_p)

    # python-docx 1.2 API：doc.add_comment(run, text=, author=, initials=)
    comment = doc.add_comment(run_obj, text=text, author=author, initials=initials)
    comment_id = comment.comment_id

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
        "comment_id": comment_id,
        "paragraph_index": p_idx,
        "locator": "add_comment",
        "changes": [
            {"paragraph": p_idx, "path": "commentRangeStart/End + commentReference",
             "note": f"新增批注 id={comment_id}（author={author!r}, text={text!r}）"}
        ],
    }


# ============================================================================
# 公共函数 2：list_comments（P1-8）
# ============================================================================
def list_comments(doc) -> dict:
    """
    列出文档所有批注（P1-8）。

    参数：
        doc: Document 对象

    返回：
        {comments:[{id, author, date, initials, text, anchor_paragraph_index}],
         count, locator:"list_comments"}

    依据说明：
        解析 comments.xml 的每个 <w:comment>，取 id/author/date/initials 属性，
        拼接 <w:p> 内 <w:r>/<w:t> 文本。anchor_paragraph_index = body 中含
        匹配 commentRangeStart 的段落索引。参考 inspect_base.py::collect_comments。
    样式保护说明：
        只读不写，不涉及样式。
    边界说明：
        - 无 comments part -> count=0，不抛。
        - commentRangeStart 找不到（悬空批注）-> anchor_paragraph_index=None。
    """
    cp = _get_comments_part(doc)
    if cp is None:
        return {"comments": [], "count": 0, "locator": "list_comments"}

    root = cp.element  # <w:comments> 根元素
    comments = []
    for c_elem in root.findall(_w("comment")):
        cid = c_elem.get(_w("id"))
        author = c_elem.get(_w("author")) or ""
        date = c_elem.get(_w("date")) or ""
        initials = c_elem.get(_w("initials")) or ""
        text = _comment_text(c_elem)
        anchor_idx = _find_anchor_paragraph_index(doc, cid) if cid is not None else None
        comments.append({
            "id": cid,
            "author": author,
            "date": date,
            "initials": initials,
            "text": text,
            "anchor_paragraph_index": anchor_idx,
        })

    return {"comments": comments, "count": len(comments),
            "locator": "list_comments"}


# ============================================================================
# 公共函数 3：delete_comment（P1-8）
# ============================================================================
def delete_comment(doc, comment_id_or_text: str, *, by: str = "text") -> dict:
    """
    删除批注（P1-8）。

    参数：
        doc: Document 对象
        comment_id_or_text: 按 by 模式匹配的值
        by: "text"=子串匹配批注文本；"id"=精确匹配批注 id

    返回：
        {deleted_count, locator:"delete_comment", changes:[...]}

    依据说明：
        从 comments.xml 中找匹配的 <w:comment>，删除之；同时从 document.xml 中
        删除对应的 commentRangeStart/commentRangeEnd/commentReference（避免悬空引用）。
        同步清理 commentsExtended/commentsExtensible/commentsIds 扩展部件中引用
        该批注 paraId 的条目（base.docx 有这些部件，参考 inspect_base.py）。
    样式保护说明：
        - 只删批注相关元素（commentRangeStart/End/commentReference/<w:comment>），
          不动段落正文 run/pPr。
        - styles.xml 不变。
    边界说明：
        - by="text" 子串匹配；by="id" 精确匹配。
        - 未命中 -> deleted_count=0，不抛。
        - 批注的 commentReference 在 run 内时，删 commentReference 后若 run 变空
          （无 <w:t>），则一并删该 run 避免空 run 残留。
    """
    if by not in ("text", "id"):
        raise CommentError(f"by 必须为 text/id，实得 {by!r}")

    cp = _get_comments_part(doc)
    if cp is None:
        return {"deleted_count": 0, "locator": "delete_comment", "changes": []}

    root = cp.element  # <w:comments>
    # 找匹配的 comment 元素
    to_delete = []
    for c_elem in root.findall(_w("comment")):
        cid = c_elem.get(_w("id"))
        ctext = _comment_text(c_elem)
        if by == "id":
            if cid == str(comment_id_or_text):
                to_delete.append(c_elem)
        else:  # by == "text"
            if comment_id_or_text in ctext:
                to_delete.append(c_elem)

    if not to_delete:
        return {"deleted_count": 0, "locator": "delete_comment", "changes": []}

    changes = []
    body = doc.element.body

    for c_elem in to_delete:
        cid = c_elem.get(_w("id"))
        para_id = _comment_paraid(c_elem)

        # 1. 从 comments.xml 删除 <w:comment>
        root.remove(c_elem)
        changes.append({"paragraph": None, "path": f"comments.xml/comment[@id={cid}]",
                        "note": f"删除批注 id={cid}"})

        # 2. 从 document.xml 删除 commentRangeStart/commentRangeEnd/commentReference
        removed_refs = 0
        for elem in list(body.iter()):
            tag = _local(elem.tag)
            if tag == "commentRangeStart":
                if elem.get(_w("id")) == cid:
                    parent = elem.getparent()
                    if parent is not None:
                        parent.remove(elem)
                    removed_refs += 1
            elif tag == "commentRangeEnd":
                if elem.get(_w("id")) == cid:
                    parent = elem.getparent()
                    if parent is not None:
                        parent.remove(elem)
                    removed_refs += 1
            elif tag == "commentReference":
                if elem.get(_w("id")) == cid:
                    # commentReference 在 <w:r> 内，删整个 run 若 run 无文本
                    run = elem.getparent()
                    if run is not None:
                        run.remove(elem)
                        # 若 run 现在无 <w:t>，删空 run
                        has_text = len(run.findall(_w("t"))) > 0
                        has_other = len(list(run)) > 0
                        if not has_text and not has_other:
                            run_parent = run.getparent()
                            if run_parent is not None:
                                run_parent.remove(run)
                    removed_refs += 1
        changes.append({"paragraph": None,
                        "path": f"document.xml/commentRangeStart/End/Reference[@id={cid}]",
                        "note": f"清理 {removed_refs} 个批注引用标记"})

        # 3. 清理扩展部件
        ext_cleaned = _clean_extended_parts(doc, para_id)
        if ext_cleaned > 0:
            changes.append({"paragraph": None,
                            "path": "commentsExtended/Extensible/Ids",
                            "note": f"清理 {ext_cleaned} 个扩展部件条目"})

    return {"deleted_count": len(to_delete),
            "locator": "delete_comment",
            "changes": changes}


# ============================================================================
# 自测
# ============================================================================
def _self_test():
    import os
    from docx import Document
    from src.verifier import validate_openable

    BASE = "input/base.docx"
    os.makedirs("output", exist_ok=True)

    # ---- 测试1：list_comments base.docx（已有 1 条 id=5）----
    doc = Document(BASE)
    r = list_comments(doc)
    assert r["count"] == 1, f"base.docx 应有 1 条批注，实得 {r['count']}"
    c0 = r["comments"][0]
    assert c0["id"] == "5", c0
    assert c0["author"] == "Eddy Zhang", c0
    assert c0["initials"] == "EZ", c0
    assert c0["text"] == "这是一条批注", c0
    assert c0["anchor_paragraph_index"] == 33, c0
    print(f"[测试1 通过] list_comments base.docx -> 1 条批注 id=5 P33")

    # ---- 测试2：add_comment 到 P7 ----
    doc = Document(BASE)
    r = add_comment(doc, 7, "测试批注内容", author="tester", initials="ts")
    out2 = "output/comments_test_2.docx"
    doc.save(out2)
    assert r["comment_id"] is not None, r
    assert r["paragraph_index"] == 7, r
    # list 验证
    doc2 = Document(out2)
    r2 = list_comments(doc2)
    assert r2["count"] == 2, f"应有 2 条批注，实得 {r2['count']}"
    new_c = [c for c in r2["comments"] if c["id"] != "5"]
    assert len(new_c) == 1, r2
    assert new_c[0]["text"] == "测试批注内容", new_c
    assert new_c[0]["author"] == "tester", new_c
    assert new_c[0]["anchor_paragraph_index"] == 7, new_c
    assert validate_openable(out2)
    print(f"[测试2 通过] add_comment P7 -> id={r['comment_id']}, list 确认 2 条")

    # ---- 测试3：delete_comment by text ----
    doc = Document(BASE)
    r = delete_comment(doc, "这是一条批注", by="text")
    out3 = "output/comments_test_3.docx"
    doc.save(out3)
    assert r["deleted_count"] == 1, f"应删 1 条，实得 {r['deleted_count']}"
    doc3 = Document(out3)
    r3 = list_comments(doc3)
    assert r3["count"] == 0, f"删后应 0 条，实得 {r3['count']}"
    # 检查无悬空 commentReference
    import zipfile
    zf = zipfile.ZipFile(out3)
    doc_root = etree.fromstring(zf.read("word/document.xml"))
    refs = doc_root.findall(f".//{_w('commentReference')}")
    assert len(refs) == 0, f"应无 commentReference，实得 {len(refs)} 个"
    ranges = doc_root.findall(f".//{_w('commentRangeStart')}")
    assert len(ranges) == 0, f"应无 commentRangeStart，实得 {len(ranges)} 个"
    assert validate_openable(out3)
    print(f"[测试3 通过] delete_comment by text -> 删 1 条，无悬空引用")

    # ---- 测试4：delete_comment by id ----
    doc = Document(BASE)
    r = delete_comment(doc, "5", by="id")
    assert r["deleted_count"] == 1, r
    doc.save("output/comments_test_4.docx")
    print(f"[测试4 通过] delete_comment by id=5 -> 删 1 条")

    # ---- 测试5：delete_comment 未命中 ----
    doc = Document(BASE)
    r = delete_comment(doc, "不存在的批注文本", by="text")
    assert r["deleted_count"] == 0, f"未命中应 0，实得 {r['deleted_count']}"
    r = delete_comment(doc, "999", by="id")
    assert r["deleted_count"] == 0, r
    print(f"[测试5 通过] delete_comment 未命中 -> deleted_count=0")

    # ---- 测试6：add_comment 空文本抛 CommentError ----
    doc = Document(BASE)
    try:
        add_comment(doc, 7, "")
        raised = False
    except CommentError:
        raised = True
    assert raised, "空文本应抛 CommentError"
    print(f"[测试6 通过] add_comment 空文本 -> CommentError")

    # ---- 测试7：add_comment 锚点无 run 抛 CommentError ----
    # base.docx P0 是空段落（无 run）
    doc = Document(BASE)
    try:
        add_comment(doc, 0, "测试")
        raised = False
    except CommentError:
        raised = True
    assert raised, "锚点无 run 应抛 CommentError"
    print(f"[测试7 通过] add_comment 锚点无 run -> CommentError")

    # ---- 测试8：delete 后文档可打开 + styles.xml 未变 ----
    doc = Document(BASE)
    delete_comment(doc, "这是一条批注", by="text")
    out8 = "output/comments_test_8.docx"
    doc.save(out8)
    assert validate_openable(out8), "删批注后文档应可打开"
    # comments.xml 应空
    zf8 = zipfile.ZipFile(out8)
    cmt_root = etree.fromstring(zf8.read("word/comments.xml"))
    cmts = cmt_root.findall(_w("comment"))
    assert len(cmts) == 0, f"comments.xml 应空，实得 {len(cmts)} 条"
    print(f"[测试8 通过] 删批注后 comments.xml 空，文档可打开")

    print()
    print("产出文件：output/comments_test_2~8.docx（供人工验证）")


if __name__ == "__main__":
    _self_test()
