/**
 * 目录编辑页面
 */
import React, { useState } from 'react';
import { OutlineData, OutlineItem, OutlineMode } from '../types';
import { expandApi, getErrorMessage, outlineApi, readSseStream } from '../services/api';
import { ChevronRightIcon, ChevronDownIcon, DocumentTextIcon, PencilIcon, TrashIcon, PlusIcon } from '@heroicons/react/24/outline';

interface OutlineEditProps {
  projectOverview: string;
  techRequirements: string;
  outlineData: OutlineData | null;
  onOutlineGenerated: (outline: OutlineData) => void;
}

const OutlineEdit: React.FC<OutlineEditProps> = ({
  projectOverview,
  techRequirements,
  outlineData,
  onOutlineGenerated,
}) => {
  const [generating, setGenerating] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [expandFile, setExpandFile] = useState<File | null>(null);
  const [uploadedExpand, setUploadedExpand] = useState(false);
  const [oldOutline, setOldOutline] = useState<string | null>(null);
  const [oldDocument, setOldDocument] = useState<string | null>(null);
  const [outlineMode, setOutlineMode] = useState<OutlineMode>('free');

  // 处理方案扩写文件上传
  const handleExpandUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setUploadedExpand(true);
      setMessage(null);

      const response = await expandApi.uploadExpandFile(file);

      if (response.data.success) {
        setExpandFile(file);
        setOldOutline(response.data.old_outline || null);
        setOldDocument(response.data.file_content || null);
        setMessage({ type: 'success', text: `方案扩写文件上传成功：${file.name}` });
      } else {
        throw new Error(response.data.message || '文件上传失败');
      }
    } catch (error) {
      setUploadedExpand(false);
      setMessage({ type: 'error', text: getErrorMessage(error, '文件上传失败') });
    }
  };

  const handleGenerateOutline = async () => {
    if (!projectOverview || !techRequirements) {
      setMessage({ type: 'error', text: '请先完成文档分析' });
      return;
    }

    try {
      setGenerating(true);
      setMessage(null);
      setProgressLogs([]);

      const response = await outlineApi.generateOutlineStream({
        overview: projectOverview,
        requirements: techRequirements,
        mode: outlineMode,
        uploaded_expand: uploadedExpand,
        old_outline: oldOutline || undefined,
        old_document: oldDocument || undefined,
      });

      let outlineResult: OutlineData | null = null;
      await readSseStream(
        response,
        (event) => {
          if (event.error) {
            throw new Error(event.message || '目录生成失败');
          }

          if (event.type === 'progress' && event.message) {
            setProgressLogs(prev => [...prev, event.message || '']);
            return;
          }

          if (event.type === 'result' && event.outline) {
            outlineResult = event.outline;
          }
        },
        '目录生成失败'
      );

      if (!outlineResult) {
        throw new Error('未收到目录生成结果');
      }

      const finalOutline: OutlineData = {
        outline: (outlineResult as OutlineData).outline ?? (outlineResult as unknown as OutlineItem[]),
        project_overview: projectOverview,
      };

      onOutlineGenerated(finalOutline);
      setMessage({ type: 'success', text: '目录结构生成完成' });

      // 默认展开所有项目
      const allIds = new Set<string>();
      const collectIds = (items: OutlineItem[]) => {
        items.forEach(item => {
          allIds.add(item.id);
          if (item.children) {
            collectIds(item.children);
          }
        });
      };
      collectIds(finalOutline.outline);
      setExpandedItems(allIds);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error, '目录生成失败') });
    } finally {
      setGenerating(false);
    }
  };


  const toggleExpanded = (itemId: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(itemId)) {
      newExpanded.delete(itemId);
    } else {
      newExpanded.add(itemId);
    }
    setExpandedItems(newExpanded);
  };

  // 开始编辑目录项
  const startEditing = (item: OutlineItem) => {
    setEditingItem(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  // 取消编辑
  const cancelEditing = () => {
    setEditingItem(null);
    setEditTitle('');
    setEditDescription('');
  };

  // 保存编辑
  const saveEdit = () => {
    if (!outlineData || !editingItem) return;

    const updateItem = (items: OutlineItem[]): OutlineItem[] => {
      return items.map(item => {
        if (item.id === editingItem) {
          return {
            ...item,
            title: editTitle.trim(),
            description: editDescription.trim()
          };
        }
        if (item.children) {
          return {
            ...item,
            children: updateItem(item.children)
          };
        }
        return item;
      });
    };

    const updatedData = {
      ...outlineData,
      outline: updateItem(outlineData.outline)
    };

    onOutlineGenerated(updatedData);
    cancelEditing();
    setMessage({ type: 'success', text: '目录项更新成功' });
  };

  // 重新分配序号的函数
  const reorderItems = (items: OutlineItem[], parentPrefix: string = ''): OutlineItem[] => {
    return items.map((item, index) => {
      const newId = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
      return {
        ...item,
        id: newId,
        children: item.children ? reorderItems(item.children, newId) : undefined
      };
    });
  };

  // 删除目录项
  const deleteItem = (itemId: string) => {
    if (!outlineData) return;

    if (window.confirm('确定要删除这个目录项吗？')) {
      const deleteFromItems = (items: OutlineItem[]): OutlineItem[] => {
        return items.flatMap(item => {
          if (item.id === itemId) {
            return [];
          }
          const nextItem = item.children
            ? { ...item, children: deleteFromItems(item.children) }
            : item;
          return [nextItem];
        });
      };

      // 删除项目后重新排序
      const filteredItems = deleteFromItems(outlineData.outline);
      const reorderedItems = reorderItems(filteredItems);

      const updatedData = {
        ...outlineData,
        outline: reorderedItems
      };

      onOutlineGenerated(updatedData);
      setMessage({ type: 'success', text: '目录项删除成功' });
    }
  };

  // 添加子目录项
  const addChildItem = (parentId: string) => {
    if (!outlineData) return;

    // 查找父项并计算下一个编号
    const findParentAndGetNextId = (items: OutlineItem[], targetParentId: string): string | null => {
      for (const item of items) {
        if (item.id === targetParentId) {
          // 找到父项，计算下一个子项编号
          const existingChildren = item.children || [];
          let maxChildNum = 0;
          
          existingChildren.forEach(child => {
            const childIdParts = child.id.split('.');
            const lastPart = childIdParts[childIdParts.length - 1];
            const num = parseInt(lastPart);
            if (!isNaN(num)) {
              maxChildNum = Math.max(maxChildNum, num);
            }
          });
          
          return `${parentId}.${maxChildNum + 1}`;
        }
        
        if (item.children) {
          const result = findParentAndGetNextId(item.children, targetParentId);
          if (result) return result;
        }
      }
      return null;
    };

    const newId = findParentAndGetNextId(outlineData.outline, parentId) || `${parentId}.1`;
    const newItem: OutlineItem = {
      id: newId,
      title: '新目录项',
      description: '请编辑描述'
    };

    const addToItems = (items: OutlineItem[]): OutlineItem[] => {
      return items.map(item => {
        if (item.id === parentId) {
          return {
            ...item,
            children: [...(item.children || []), newItem]
          };
        }
        if (item.children) {
          return {
            ...item,
            children: addToItems(item.children)
          };
        }
        return item;
      });
    };

    const updatedData = {
      ...outlineData,
      outline: addToItems(outlineData.outline)
    };

    onOutlineGenerated(updatedData);
    
    // 展开父项
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      newSet.add(parentId);
      return newSet;
    });
    
    // 自动开始编辑新项
    setTimeout(() => {
      startEditing(newItem);
    }, 100);
    
    setMessage({ type: 'success', text: '子目录添加成功' });
  };

  // 添加根目录项
  const addRootItem = () => {
    if (!outlineData) return;

    // 计算下一个根目录编号
    let maxRootNum = 0;
    outlineData.outline.forEach(item => {
      const idParts = item.id.split('.');
      const firstPart = idParts[0];
      const num = parseInt(firstPart);
      if (!isNaN(num)) {
        maxRootNum = Math.max(maxRootNum, num);
      }
    });

    const newId = `${maxRootNum + 1}`;
    const newItem: OutlineItem = {
      id: newId,
      title: '新目录项',
      description: '请编辑描述'
    };

    const updatedData = {
      ...outlineData,
      outline: [...outlineData.outline, newItem]
    };

    onOutlineGenerated(updatedData);
    
    // 自动开始编辑新项
    setTimeout(() => {
      startEditing(newItem);
    }, 100);
    
    setMessage({ type: 'success', text: '目录项添加成功' });
  };

  const renderOutlineItem = (item: OutlineItem, level: number = 0) => {
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expandedItems.has(item.id);
    const isLeaf = !hasChildren;
    const isEditing = editingItem === item.id;

    return (
      <div key={item.id} className={`${level > 0 ? 'ml-6' : ''}`}>
        <div className="group flex items-start space-x-2 py-2 hover:bg-gray-50 rounded px-2">
          {hasChildren ? (
            <button
              onClick={() => toggleExpanded(item.id)}
              className="mt-1 p-0.5 rounded hover:bg-gray-200"
            >
              {isExpanded ? (
                <ChevronDownIcon className="h-4 w-4 text-gray-400" />
              ) : (
                <ChevronRightIcon className="h-4 w-4 text-gray-400" />
              )}
            </button>
          ) : (
            <DocumentTextIcon className="mt-1 h-4 w-4 text-gray-400" />
          )}
          
          <div className="flex-1 min-w-0">
            {isEditing ? (
              // 编辑模式
              <div className="space-y-2">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                  placeholder="目录标题"
                />
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={2}
                  className="w-full px-2 py-1 border border-gray-300 rounded text-xs resize-none"
                  placeholder="目录描述"
                />
                <div className="flex space-x-2">
                  <button
                    onClick={saveEdit}
                    className="inline-flex items-center px-2 py-1 border border-transparent text-xs font-medium rounded text-white bg-green-600 hover:bg-green-700"
                  >
                    保存
                  </button>
                  <button
                    onClick={cancelEditing}
                    className="inline-flex items-center px-2 py-1 border border-gray-300 text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              // 正常显示模式
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className={`text-sm font-medium ${
                      level === 0 ? 'text-blue-600' :
                      level === 1 ? 'text-green-600' :
                      'text-gray-700'
                    }`}>
                      {item.id} {item.title}
                    </span>
                    {item.content && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        已生成内容
                      </span>
                    )}
                  </div>
                  
                  {/* 操作按钮组 */}
                  <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => startEditing(item)}
                      className="p-1 rounded hover:bg-blue-100 text-blue-600"
                      title="编辑"
                    >
                      <PencilIcon className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => addChildItem(item.id)}
                      className="p-1 rounded hover:bg-green-100 text-green-600"
                      title="添加子目录"
                    >
                      <PlusIcon className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => deleteItem(item.id)}
                      className="p-1 rounded hover:bg-red-100 text-red-600"
                      title="删除"
                    >
                      <TrashIcon className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-1">{item.description}</p>
                
                {/* 显示生成的内容（如果有） */}
                {item.content && isLeaf && (
                  <div className="mt-2 p-3 bg-gray-50 rounded-md border-l-4 border-blue-200">
                    <div className="text-xs text-gray-600 whitespace-pre-wrap">{item.content}</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        
        {hasChildren && isExpanded && (
          <div>
            {item.children!.map(child => renderOutlineItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 操作按钮 */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">📋 目录管理</h2>
        
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">目录生成模式</p>
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setOutlineMode('free')}
                disabled={generating}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  outlineMode === 'free'
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <div className="text-sm font-medium">AI自行理解</div>
                <p className="mt-1 text-xs leading-5 text-gray-500">
                  AI 根据项目概述和技术评分要求自由组织一级目录。
                </p>
              </button>
              <button
                type="button"
                onClick={() => setOutlineMode('aligned')}
                disabled={generating}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  outlineMode === 'aligned'
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <div className="text-sm font-medium">与技术评分项一一对应</div>
                <p className="mt-1 text-xs leading-5 text-gray-500">
                  一级目录将严格按技术评分大类生成，标题和顺序固定，二三级目录由 AI 自动展开。
                </p>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
          {/* 方案扩写按钮 */}
          <div className="relative">
            <input
              type="file"
              id="expand-file-upload"
              accept=".pdf,.doc,.docx"
              onChange={handleExpandUpload}
              className="hidden"
              disabled={uploadedExpand}
            />
            <label
              htmlFor="expand-file-upload"
              className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white cursor-pointer ${
                uploadedExpand
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-green-600 hover:bg-green-700'
              } focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500`}
            >
              {uploadedExpand ? (
                <>
                  <div className="animate-spin -ml-1 mr-3 h-4 w-4 text-white">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  </div>
                  正在分析...
                </>
              ) : (
                '方案扩写'
              )}
            </label>
          </div>

          <button
            onClick={handleGenerateOutline}
            disabled={generating || !projectOverview || !techRequirements}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400"
          >
            {generating ? (
              <>
                <div className="animate-spin -ml-1 mr-3 h-4 w-4 text-white">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
                正在生成目录...
              </>
            ) : (
              '生成目录结构'
            )}
          </button>
          </div>
        </div>

        {/* 显示已上传的方案扩写文件 */}
        {expandFile && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-md">
            <div className="flex items-center">
              <DocumentTextIcon className="h-5 w-5 text-green-600 mr-2" />
              <span className="text-sm text-green-800">
                已上传方案扩写文件：<span className="font-medium">{expandFile.name}</span>
              </span>
            </div>
          </div>
        )}

        {!projectOverview && !techRequirements && (
          <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
            <p className="text-sm text-yellow-800">
              请先在"标书解析"步骤中完成文档分析，获取项目概述和技术评分要求。
            </p>
          </div>
        )}

        {/* 生成过程显示 */}
        {progressLogs.length > 0 && (
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
            <h4 className="text-sm font-medium text-blue-800 mb-2">
              {generating ? '正在生成目录结构...' : '本次生成过程'}
            </h4>
            <div className="bg-white p-3 rounded border max-h-48 overflow-y-auto">
              <div className="space-y-2 text-xs text-gray-700">
                {progressLogs.map((log, index) => (
                  <p key={`${index}-${log}`} className="whitespace-pre-wrap leading-5">
                    {log}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 目录结构显示 */}
      {outlineData && (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">目录结构</h3>
            <button
              onClick={addRootItem}
              className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
            >
              <PlusIcon className="h-4 w-4 mr-1" />
              添加目录项
            </button>
          </div>
          <div className="border rounded-lg p-4 max-h-96 overflow-y-auto">
            {outlineData.outline.map(item => renderOutlineItem(item))}
          </div>
        </div>
      )}

      {/* 消息提示 */}
      {message && (
        <div className={`p-4 rounded-md ${
          message.type === 'success' 
            ? 'bg-green-100 text-green-700 border border-green-200' 
            : 'bg-red-100 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}
    </div>
  );
};

export default OutlineEdit;
