"""目录生成服务。"""

import json
from typing import Any, Dict

from ..models.schemas import (
    OutlineChildrenResponse,
    OutlineMode,
    OutlineResponse,
    OutlineReviewResponse,
    TechnicalRequirementGroupResponse,
)
from ..utils.openai_util import OpenAIUtil, ProgressCallback
from ..utils.errors import AppError
from ..utils.prompts.outline_prompts import (
    extract_requirement_groups_messages,
    generate_aligned_children_outline_prompt,
    generate_aligned_children_outline_with_old_prompt,
    generate_children_outline_prompt,
    generate_children_outline_with_old_prompt,
    generate_outline_prompt,
    generate_outline_with_old_prompt,
    generate_top_level_outline_prompt,
    generate_top_level_outline_with_old_prompt,
    review_aligned_outline_messages,
    review_outline_messages,
)


class OutlineService:
    """负责目录生成、审核与技术评分项对齐。"""

    def __init__(self, ai: OpenAIUtil | None = None):
        self.ai = ai or OpenAIUtil()

    async def generate_outline(
        self,
        overview: str,
        requirements: str,
        mode: OutlineMode = OutlineMode.FREE,
        uploaded_expand: bool = False,
        old_outline: str | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> Dict[str, Any]:
        """生成目录结构。"""
        if mode == OutlineMode.ALIGNED:
            return await self._generate_aligned_outline_workflow(
                overview=overview,
                requirements=requirements,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                progress_callback=progress_callback,
            )

        return await self._generate_outline_workflow(
            overview=overview,
            requirements=requirements,
            uploaded_expand=uploaded_expand,
            old_outline=old_outline,
            progress_callback=progress_callback,
        )

    async def _generate_outline_workflow(
        self,
        overview: str,
        requirements: str,
        uploaded_expand: bool,
        old_outline: str | None,
        progress_callback: ProgressCallback | None = None,
    ) -> Dict[str, Any]:
        """执行目录生成、审核与回退工作流。"""
        await self.ai.emit_progress(progress_callback, "开始生成目录结构。")
        first_outline, generation_mode = await self._generate_outline_by_mode(
            overview=overview,
            requirements=requirements,
            uploaded_expand=uploaded_expand,
            old_outline=old_outline,
            mode="auto",
            progress_callback=progress_callback,
        )

        await self.ai.emit_progress(
            progress_callback, "首次目录生成完成，开始审核目录质量。"
        )
        first_review = await self._review_outline(
            overview=overview,
            requirements=requirements,
            outline=first_outline,
            progress_callback=progress_callback,
            stage_label="首次审核",
        )
        if first_review["passed"]:
            await self.ai.emit_progress(
                progress_callback, "目录审核通过，准备返回结果。"
            )
            return first_outline

        suggestions = first_review.get("suggestions") or [
            "请根据项目概述和技术评分要求补全目录覆盖范围，并修正不合理章节。"
        ]
        await self.ai.emit_progress(
            progress_callback,
            "目录审核未通过，正在根据修改建议重新生成。",
        )

        try:
            second_outline, _ = await self._generate_outline_by_mode(
                overview=overview,
                requirements=requirements,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                mode=generation_mode,
                progress_callback=progress_callback,
                suggestions=suggestions,
            )
        except AppError:
            await self.ai.emit_progress(
                progress_callback,
                "根据审核建议重新生成失败，已回退到首次生成结果。",
            )
            return first_outline

        await self.ai.emit_progress(progress_callback, "二次生成完成，开始最终审核。")
        second_review = await self._review_outline(
            overview=overview,
            requirements=requirements,
            outline=second_outline,
            progress_callback=progress_callback,
            stage_label="最终审核",
        )
        if second_review["passed"]:
            await self.ai.emit_progress(
                progress_callback, "最终审核通过，准备返回修正后的结果。"
            )
        else:
            await self.ai.emit_progress(
                progress_callback,
                "最终审核未完全通过，已返回修正后的第二次结果。",
            )

        return second_outline

    async def _generate_aligned_outline_workflow(
        self,
        overview: str,
        requirements: str,
        uploaded_expand: bool,
        old_outline: str | None,
        progress_callback: ProgressCallback | None = None,
    ) -> Dict[str, Any]:
        """按技术评分大类一一对应生成目录。"""
        await self.ai.emit_progress(progress_callback, "开始提取技术评分大类。")
        groups = await self._extract_requirement_groups(
            requirements=requirements,
            progress_callback=progress_callback,
        )

        await self.ai.emit_progress(
            progress_callback, "技术评分大类提取完成，正在构建一级目录。"
        )
        first_outline = await self._generate_aligned_outline(
            overview=overview,
            requirements=requirements,
            groups=groups,
            uploaded_expand=uploaded_expand,
            old_outline=old_outline,
            progress_callback=progress_callback,
        )

        await self.ai.emit_progress(
            progress_callback,
            "目录生成完成，正在审核与技术评分项的对应关系。",
        )
        first_review = await self._review_aligned_outline(
            overview=overview,
            requirements=requirements,
            groups=groups,
            outline=first_outline,
            progress_callback=progress_callback,
            stage_label="首次审核",
        )
        if first_review["passed"]:
            await self.ai.emit_progress(
                progress_callback, "目录审核通过，准备返回结果。"
            )
            return first_outline

        suggestions = first_review.get("suggestions") or [
            "请保持一级目录与技术评分大类标题完全一致，并补全各大类下遗漏的评分细项。"
        ]
        await self.ai.emit_progress(
            progress_callback,
            "目录审核未通过，正在根据修改建议重新提取技术评分大类并重新生成目录。",
        )

        try:
            revised_groups = await self._extract_requirement_groups(
                requirements=requirements,
                progress_callback=progress_callback,
                suggestions=suggestions,
            )
            second_outline = await self._generate_aligned_outline(
                overview=overview,
                requirements=requirements,
                groups=revised_groups,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                progress_callback=progress_callback,
                suggestions=suggestions,
            )
        except AppError:
            await self.ai.emit_progress(
                progress_callback,
                "根据审核建议重新生成失败，已回退到首次生成结果。",
            )
            return first_outline

        await self.ai.emit_progress(progress_callback, "二次生成完成，开始最终审核。")
        second_review = await self._review_aligned_outline(
            overview=overview,
            requirements=requirements,
            groups=revised_groups,
            outline=second_outline,
            progress_callback=progress_callback,
            stage_label="最终审核",
        )
        if second_review["passed"]:
            await self.ai.emit_progress(
                progress_callback, "最终审核通过，准备返回修正后的结果。"
            )
        else:
            await self.ai.emit_progress(
                progress_callback,
                "最终审核未完全通过，已返回修正后的第二次结果。",
            )

        return second_outline

    async def _extract_requirement_groups(
        self,
        requirements: str,
        progress_callback: ProgressCallback | None = None,
        suggestions: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """提取适合作为一级目录的技术评分大类。"""
        response = await self.ai.collect_json_response(
            messages=extract_requirement_groups_messages(
                requirements=requirements,
                suggestions=suggestions,
            ),
            temperature=0.3,
            schema=TechnicalRequirementGroupResponse,
            validator=self._validate_requirement_groups,
            progress_callback=progress_callback,
            progress_label="技术评分大类",
            failure_message="模型返回的技术评分大类格式无效",
        )
        return response.get("groups") or []

    @staticmethod
    def _validate_requirement_groups(payload: Dict[str, Any]) -> None:
        """校验技术评分大类提取结果。"""
        groups = payload.get("groups") or []
        if not groups:
            raise ValueError("技术评分大类不能为空")

        requirement_ids: list[str] = []
        titles: list[str] = []
        for index, group in enumerate(groups, start=1):
            requirement_id = str(group.get("requirement_id") or "").strip()
            title = str(group.get("title") or "").strip()
            description = str(group.get("description") or "").strip()
            if not requirement_id:
                raise ValueError(f"第 {index} 个技术评分大类缺少 requirement_id")
            if not title:
                raise ValueError(f"第 {index} 个技术评分大类缺少标题")
            if not description:
                raise ValueError(f"第 {index} 个技术评分大类缺少描述")
            requirement_ids.append(requirement_id)
            titles.append(title)

        if len(set(requirement_ids)) != len(requirement_ids):
            raise ValueError("技术评分大类 requirement_id 不能重复")
        if len(set(titles)) != len(titles):
            raise ValueError("技术评分大类标题不能重复")

    @staticmethod
    def _build_top_level_outline_from_groups(
        groups: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """根据技术评分大类直接构造一级目录。"""
        outline: list[dict[str, Any]] = []
        for index, group in enumerate(groups, start=1):
            title = str(group.get("title") or "").strip()
            outline.append(
                {
                    "id": str(index),
                    "title": title,
                    "description": str(group.get("description") or title).strip(),
                    "source_requirement_id": str(
                        group.get("requirement_id") or f"R{index}"
                    ).strip(),
                    "source_requirement_title": title,
                }
            )
        return outline

    @staticmethod
    def _validate_aligned_top_level_mapping(
        outline_items: list[dict[str, Any]],
        groups: list[dict[str, Any]],
    ) -> None:
        """校验一级目录与技术评分大类是否严格对齐。"""
        if len(outline_items) != len(groups):
            raise ValueError("一级目录数量必须与技术评分大类数量一致")

        for index, (item, group) in enumerate(zip(outline_items, groups), start=1):
            expected_title = str(group.get("title") or "").strip()
            actual_title = str(item.get("title") or "").strip()
            if actual_title != expected_title:
                raise ValueError(
                    f"第 {index} 个一级目录标题必须严格等于技术评分大类标题：{expected_title}"
                )

            expected_requirement_id = str(group.get("requirement_id") or "").strip()
            actual_requirement_id = str(item.get("source_requirement_id") or "").strip()
            if actual_requirement_id != expected_requirement_id:
                raise ValueError(
                    f"第 {index} 个一级目录映射的技术评分大类ID不正确：{expected_requirement_id}"
                )

    async def _generate_aligned_outline(
        self,
        overview: str,
        requirements: str,
        groups: list[dict[str, Any]],
        uploaded_expand: bool,
        old_outline: str | None,
        progress_callback: ProgressCallback | None,
        suggestions: list[str] | None = None,
    ) -> Dict[str, Any]:
        """基于技术评分大类生成严格对齐的完整目录。"""
        top_level_items = self._build_top_level_outline_from_groups(groups)
        self._validate_aligned_top_level_mapping(top_level_items, groups)

        assembled_items: list[dict[str, Any]] = []
        for index, (item, group) in enumerate(zip(top_level_items, groups), start=1):
            await self.ai.emit_progress(
                progress_callback,
                f"正在生成第 {index}/{len(top_level_items)} 个评分大类的二三级目录：{item.get('title', '未命名章节')}。",
            )
            merged_item = dict(item)
            children_response = await self._generate_outline_children_for_group(
                overview=overview,
                requirements=requirements,
                parent_item=item,
                requirement_group=group,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                suggestions=suggestions,
                progress_callback=progress_callback,
            )
            children = children_response.get("children") or []
            if children:
                merged_item["children"] = children
            assembled_items.append(merged_item)

        outline = self._renumber_outline({"outline": assembled_items})
        validated = OutlineResponse.model_validate(outline)
        normalized = validated.model_dump(exclude_none=True)
        self._validate_complete_outline(normalized)
        self._validate_aligned_top_level_mapping(
            normalized.get("outline") or [], groups
        )
        return normalized

    async def _generate_outline_children_for_group(
        self,
        overview: str,
        requirements: str,
        parent_item: Dict[str, Any],
        requirement_group: Dict[str, Any],
        uploaded_expand: bool,
        old_outline: str | None,
        suggestions: list[str] | None,
        progress_callback: ProgressCallback | None,
    ) -> Dict[str, Any]:
        """为指定技术评分大类生成二三级目录。"""
        if uploaded_expand:
            messages = generate_aligned_children_outline_with_old_prompt(
                overview=overview,
                requirements=requirements,
                parent_item=parent_item,
                requirement_group=requirement_group,
                old_outline=old_outline,
                suggestions=suggestions,
            )
        else:
            messages = generate_aligned_children_outline_prompt(
                overview=overview,
                requirements=requirements,
                parent_item=parent_item,
                requirement_group=requirement_group,
                suggestions=suggestions,
            )

        return await self.ai.collect_json_response(
            messages=messages,
            temperature=0.7,
            schema=OutlineChildrenResponse,
            validator=self._validate_children_outline,
            progress_callback=progress_callback,
            progress_label=f"章节 {parent_item.get('title', '未命名章节')} 子目录",
            failure_message="模型返回的目录数据格式无效",
        )

    async def _review_aligned_outline(
        self,
        overview: str,
        requirements: str,
        groups: list[dict[str, Any]],
        outline: Dict[str, Any],
        progress_callback: ProgressCallback | None,
        stage_label: str,
    ) -> Dict[str, Any]:
        """审核目录是否与技术评分大类一一对应。"""
        messages = review_aligned_outline_messages(
            overview=overview,
            requirements=requirements,
            groups_json=json.dumps({"groups": groups}, ensure_ascii=False),
            outline_json=json.dumps(outline, ensure_ascii=False),
        )
        return await self.ai.collect_json_response(
            messages=messages,
            temperature=0.3,
            schema=OutlineReviewResponse,
            progress_callback=progress_callback,
            progress_label=stage_label,
            failure_message="模型返回的审核结果格式无效",
        )

    async def _generate_outline_by_mode(
        self,
        overview: str,
        requirements: str,
        uploaded_expand: bool,
        old_outline: str | None,
        mode: str,
        progress_callback: ProgressCallback | None = None,
        suggestions: list[str] | None = None,
    ) -> tuple[Dict[str, Any], str]:
        """根据指定模式生成目录。"""
        if mode == "full":
            outline = await self._generate_outline_full(
                overview=overview,
                requirements=requirements,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                suggestions=suggestions,
                progress_callback=progress_callback,
            )
            return outline, "full"

        if mode == "fallback":
            outline = await self._generate_outline_fallback(
                overview=overview,
                requirements=requirements,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                suggestions=suggestions,
                progress_callback=progress_callback,
            )
            return outline, "fallback"

        try:
            outline = await self._generate_outline_full(
                overview=overview,
                requirements=requirements,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                suggestions=suggestions,
                progress_callback=progress_callback,
            )
            return outline, "full"
        except AppError as exc:
            if exc.message != "模型返回的目录数据格式无效":
                raise
            await self.ai.emit_progress(
                progress_callback,
                "一次性生成完整目录失败，切换为分步生成模式。",
            )
            outline = await self._generate_outline_fallback(
                overview=overview,
                requirements=requirements,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                suggestions=suggestions,
                progress_callback=progress_callback,
            )
            return outline, "fallback"

    async def _generate_outline_full(
        self,
        overview: str,
        requirements: str,
        uploaded_expand: bool,
        old_outline: str | None,
        suggestions: list[str] | None,
        progress_callback: ProgressCallback | None,
    ) -> Dict[str, Any]:
        """一次性生成完整目录。"""
        await self.ai.emit_progress(progress_callback, "正在一次性生成完整目录。")
        if uploaded_expand:
            messages = generate_outline_with_old_prompt(
                overview,
                requirements,
                old_outline,
                suggestions=suggestions,
            )
        else:
            messages = generate_outline_prompt(
                overview,
                requirements,
                suggestions=suggestions,
            )

        return await self.ai.collect_json_response(
            messages=messages,
            temperature=0.7,
            schema=OutlineResponse,
            validator=self._validate_complete_outline,
            progress_callback=progress_callback,
            progress_label="完整目录",
            failure_message="模型返回的目录数据格式无效",
        )

    async def _generate_outline_fallback(
        self,
        overview: str,
        requirements: str,
        uploaded_expand: bool,
        old_outline: str | None,
        suggestions: list[str] | None,
        progress_callback: ProgressCallback | None,
    ) -> Dict[str, Any]:
        """分步生成目录：先一级目录，再逐个生成二三级目录。"""
        await self.ai.emit_progress(
            progress_callback, "正在分步生成目录，先生成一级目录。"
        )
        top_level_outline = await self._generate_top_level_outline(
            overview=overview,
            requirements=requirements,
            uploaded_expand=uploaded_expand,
            old_outline=old_outline,
            suggestions=suggestions,
            progress_callback=progress_callback,
        )

        top_level_items = top_level_outline.get("outline", [])
        assembled_items: list[dict[str, Any]] = []
        for index, item in enumerate(top_level_items, start=1):
            await self.ai.emit_progress(
                progress_callback,
                f"正在生成第 {index}/{len(top_level_items)} 个一级目录的二三级目录：{item.get('title', '未命名章节')}。",
            )
            merged_item = {
                "id": item.get("id", str(index)),
                "title": item.get("title", "未命名章节"),
                "description": item.get("description", ""),
            }
            children_response = await self._generate_outline_children(
                overview=overview,
                requirements=requirements,
                parent_item=item,
                uploaded_expand=uploaded_expand,
                old_outline=old_outline,
                suggestions=suggestions,
                progress_callback=progress_callback,
            )
            children = children_response.get("children") or []
            if children:
                merged_item["children"] = children
            assembled_items.append(merged_item)

        outline = self._renumber_outline({"outline": assembled_items})
        validated = OutlineResponse.model_validate(outline)
        normalized = validated.model_dump(exclude_none=True)
        self._validate_complete_outline(normalized)
        return normalized

    async def _generate_top_level_outline(
        self,
        overview: str,
        requirements: str,
        uploaded_expand: bool,
        old_outline: str | None,
        suggestions: list[str] | None,
        progress_callback: ProgressCallback | None,
    ) -> Dict[str, Any]:
        """生成一级目录。"""
        if uploaded_expand:
            messages = generate_top_level_outline_with_old_prompt(
                overview=overview,
                requirements=requirements,
                old_outline=old_outline,
                suggestions=suggestions,
            )
        else:
            messages = generate_top_level_outline_prompt(
                overview=overview,
                requirements=requirements,
                suggestions=suggestions,
            )

        return await self.ai.collect_json_response(
            messages=messages,
            temperature=0.7,
            schema=OutlineResponse,
            validator=self._validate_top_level_outline,
            progress_callback=progress_callback,
            progress_label="一级目录",
            failure_message="模型返回的目录数据格式无效",
        )

    async def _generate_outline_children(
        self,
        overview: str,
        requirements: str,
        parent_item: Dict[str, Any],
        uploaded_expand: bool,
        old_outline: str | None,
        suggestions: list[str] | None,
        progress_callback: ProgressCallback | None,
    ) -> Dict[str, Any]:
        """生成某个一级目录下的二三级目录。"""
        if uploaded_expand:
            messages = generate_children_outline_with_old_prompt(
                overview=overview,
                requirements=requirements,
                parent_item=parent_item,
                old_outline=old_outline,
                suggestions=suggestions,
            )
        else:
            messages = generate_children_outline_prompt(
                overview=overview,
                requirements=requirements,
                parent_item=parent_item,
                suggestions=suggestions,
            )

        return await self.ai.collect_json_response(
            messages=messages,
            temperature=0.7,
            schema=OutlineChildrenResponse,
            validator=self._validate_children_outline,
            progress_callback=progress_callback,
            progress_label=f"章节 {parent_item.get('title', '未命名章节')} 子目录",
            failure_message="模型返回的目录数据格式无效",
        )

    async def _review_outline(
        self,
        overview: str,
        requirements: str,
        outline: Dict[str, Any],
        progress_callback: ProgressCallback | None,
        stage_label: str,
    ) -> Dict[str, Any]:
        """审核目录是否符合招标要求。"""
        messages = review_outline_messages(
            overview=overview,
            requirements=requirements,
            outline_json=json.dumps(outline, ensure_ascii=False),
        )
        return await self.ai.collect_json_response(
            messages=messages,
            temperature=0.3,
            schema=OutlineReviewResponse,
            progress_callback=progress_callback,
            progress_label=stage_label,
            failure_message="模型返回的审核结果格式无效",
        )

    @classmethod
    def _renumber_outline(cls, outline: Dict[str, Any]) -> Dict[str, Any]:
        """统一重排目录编号，避免分步生成时编号错乱。"""
        return {"outline": cls._renumber_items(outline.get("outline", []))}

    @classmethod
    def _renumber_items(
        cls,
        items: list[dict[str, Any]],
        parent_prefix: str = "",
    ) -> list[dict[str, Any]]:
        """递归重排目录项编号。"""
        normalized_items: list[dict[str, Any]] = []
        for index, item in enumerate(items, start=1):
            item_id = f"{parent_prefix}.{index}" if parent_prefix else str(index)
            normalized_item = {**item, "id": item_id}
            children = item.get("children") or []
            if children:
                normalized_item["children"] = cls._renumber_items(children, item_id)
            else:
                normalized_item.pop("children", None)
            normalized_items.append(normalized_item)

        return normalized_items

    @staticmethod
    def _outline_depth(items: list[dict[str, Any]]) -> int:
        """计算目录的最大层级深度。"""
        if not items:
            return 0

        return 1 + max(
            OutlineService._outline_depth(item.get("children") or []) for item in items
        )

    @classmethod
    def _validate_complete_outline(cls, payload: Dict[str, Any]) -> None:
        """校验完整目录至少达到三级结构。"""
        outline = payload.get("outline") or []
        if not outline:
            raise ValueError("目录不能为空")

        if cls._outline_depth(outline) < 3:
            raise ValueError("完整目录至少需要三级结构")

    @staticmethod
    def _validate_top_level_outline(payload: Dict[str, Any]) -> None:
        """校验一级目录结果非空。"""
        outline = payload.get("outline") or []
        if not outline:
            raise ValueError("一级目录不能为空")

    @classmethod
    def _validate_children_outline(cls, payload: Dict[str, Any]) -> None:
        """校验一级目录下至少生成出二级目录。"""
        children = payload.get("children") or []
        if not children:
            raise ValueError("二级目录不能为空")
