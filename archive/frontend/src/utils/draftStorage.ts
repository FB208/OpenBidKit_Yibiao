/**
 * 本地草稿持久化（localStorage）
 * 目标：刷新页面不丢失“标书解析/目录/正文”关键中间结果，方便调试与续写。
 *
 * 注意：localStorage 容量有限（通常 5-10MB），大正文可能触发 QUOTA_EXCEEDED_ERR。
 * 这里做了 try/catch，失败时不影响主流程。
 */

import type { AppState, OutlineItem } from '../types';

const DRAFT_KEY = 'yibiao:draft:v1';
const CONTENT_BY_ID_KEY = 'yibiao:contentById:v1';

export type DraftState = Pick<
  AppState,
  'currentStep' | 'fileContent' | 'projectOverview' | 'techRequirements' | 'outlineData'
>;

export type ContentById = Record<string, string>; // 章节id -> content

const safeJsonParse = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const draftStorage = {
  loadDraft(): Partial<DraftState> | null {
    return safeJsonParse<Partial<DraftState>>(localStorage.getItem(DRAFT_KEY));
  },

  saveDraft(partial: Partial<DraftState>) {
    try {
      const prev = safeJsonParse<Partial<DraftState>>(localStorage.getItem(DRAFT_KEY)) || {};
      const next = { ...prev, ...partial };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('保存草稿失败（可能是 localStorage 空间不足）:', e);
    }
  },

  clearAll() {
    try {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(CONTENT_BY_ID_KEY);
    } catch (e) {
      console.warn('清空 localStorage 失败:', e);
    }
  },

  loadContentById(): ContentById {
    return safeJsonParse<ContentById>(localStorage.getItem(CONTENT_BY_ID_KEY)) || {};
  },

  saveContentById(contentById: ContentById) {
    try {
      localStorage.setItem(CONTENT_BY_ID_KEY, JSON.stringify(contentById));
    } catch (e) {
      console.warn('保存正文内容失败（可能是 localStorage 空间不足）:', e);
    }
  },

  upsertChapterContent(chapterId: string, content: string) {
    try {
      const map = draftStorage.loadContentById();
      map[chapterId] = content;
      draftStorage.saveContentById(map);
    } catch (e) {
      console.warn('保存章节内容失败:', e);
    }
  },

  /**
   * 按当前 outline 的叶子节点过滤 contentById，避免目录变更后错误回填。
   */
  filterContentByOutlineLeaves(outline: OutlineItem[]): ContentById {
    const map = draftStorage.loadContentById();
    const leafIds = new Set<string>();
    const walk = (items: OutlineItem[]) => {
      items.forEach((it) => {
        if (!it.children || it.children.length === 0) {
          leafIds.add(it.id);
          return;
        }
        walk(it.children);
      });
    };
    walk(outline);

    const filtered: ContentById = {};
    Object.keys(map).forEach((id) => {
      if (leafIds.has(id)) filtered[id] = map[id];
    });
    return filtered;
  },
};


