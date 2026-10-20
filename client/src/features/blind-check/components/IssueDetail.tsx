import type { ReactNode } from 'react';

/**
 * 问题卡片展开后的统一排版（检查结果与修复结果共用）：左列灰色标签、右列内容的说明行，
 * "出现位置"也是其中一行，每处一条：行首是位置标签，后面是原文摘录，附注（补充说明、格式来源、AI 结论）写在摘录下方。
 */

export function DetailRows({ children }: { children: ReactNode }) {
  return <dl className="blind-check-detail-rows">{children}</dl>;
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function OccurrenceList({ children, more }: { children: ReactNode; /** 未逐一列出的处数说明 */ more?: string }) {
  return (
    <>
      <ul className="blind-check-occurrence-list">{children}</ul>
      {more && <p className="blind-check-sample-more">{more}</p>}
    </>
  );
}

export function Occurrence({ where, text, dismissed, children }: { where: string; text?: ReactNode; dismissed?: boolean; children?: ReactNode }) {
  return (
    <li className={`blind-check-occurrence${dismissed ? ' is-dismissed' : ''}`}>
      <span className="blind-check-occurrence-where" title={where || '全文'}>{where || '全文'}</span>
      <div className="blind-check-occurrence-body">
        {text && <p className="blind-check-occurrence-text">{text}</p>}
        {children}
      </div>
    </li>
  );
}

/** 出现位置下的附注：补充说明、格式来源、各处不同的修改方法。 */
export function OccurrenceNote({ children }: { children: ReactNode }) {
  return <p className="blind-check-occurrence-note">{children}</p>;
}
