import { useState } from 'react';
import { ChevronRightIcon } from '@radix-ui/react-icons';
import type { BlindCheckCategory, BlindCheckIssue, BlindCheckSeverity } from '../types';
import { DetailRow, DetailRows, Occurrence, OccurrenceList, OccurrenceNote } from './IssueDetail';

export const categoryLabels: Record<BlindCheckCategory, string> = {
  privacy: '隐私与匿名',
  structure: '结构',
  page: '页面',
  paragraph: '段落',
  font: '字体',
  text: '标点空格',
  table: '表格',
  consistency: '一致性',
  image: '图片',
  other: '其他',
};

export const severityLabels: Record<BlindCheckSeverity, string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

/**
 * 最终问题清单：标题行显示风险、结论和处数，需人工确认的加标记；展开后是招标要求、问题说明、修改方法和出现位置。
 * 清单由 Main 按复核后的结论产出，这里只负责显示，不区分程序还是 AI 发现的。
 */
export default function FindingGroupList({ issues }: { issues: BlindCheckIssue[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="blind-check-group-list">
      {issues.map((issue) => {
        const open = expanded.has(issue.id);
        return (
          <article className={`blind-check-group is-${issue.severity}${open ? ' is-expanded' : ''}`} key={issue.id}>
            <button type="button" className="blind-check-group-row" onClick={() => toggle(issue.id)} aria-expanded={open}>
              <ChevronRightIcon className="blind-check-group-chevron" aria-hidden="true" />
              <em className={`rejection-finding-severity is-${issue.severity}`}>{severityLabels[issue.severity]}</em>
              <strong title={issue.message}>{issue.message}</strong>
              {issue.uncertain && <em className="blind-check-group-tag">需人工确认</em>}
              <span className="blind-check-group-count">{`${issue.count} 处`}</span>
            </button>

            {open && (
              <div className="blind-check-group-detail">
                <DetailRows>
                  {issue.requirements.length > 0 && (
                    <DetailRow label="招标要求">
                      {issue.requirements.map((requirement) => (
                        <p className="blind-check-requirement" key={requirement.text}>
                          {requirement.text}
                          {requirement.unverified && <em className="blind-check-unverified">未在招标原文中核实</em>}
                        </p>
                      ))}
                    </DetailRow>
                  )}
                  {issue.explanation && <DetailRow label="问题说明">{issue.explanation}</DetailRow>}
                  {issue.hint && <DetailRow label="修改方法">{issue.hint}</DetailRow>}
                  {issue.occurrences.length > 0 && (
                    <DetailRow label="出现位置">
                      <OccurrenceList more={issue.more > 0 ? `另有 ${issue.more} 处同类问题未逐一列出，修改后重新检查即可确认。` : undefined}>
                        {issue.occurrences.map((occurrence, index) => (
                          <Occurrence where={occurrence.where} text={occurrence.text} key={`${occurrence.where}-${index}`}>
                            {occurrence.notes.map((note) => <OccurrenceNote key={note}>{note}</OccurrenceNote>)}
                          </Occurrence>
                        ))}
                      </OccurrenceList>
                    </DetailRow>
                  )}
                </DetailRows>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
