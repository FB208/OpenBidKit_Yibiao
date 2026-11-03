import type { OfficialAccountState } from '../../../shared/types/officialAccount';

// 邮箱账户可切换查看本人历史个人来源；匿名账户或没有历史来源时不显示。
export default function OfficialSourceSelect({ account, value, defaultLabel, disabled, onChange }: {
  account: OfficialAccountState;
  value: string;
  defaultLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  if (account.identityType !== 'email' || !account.sources.length) return null;
  return (
    <select className="official-source-select" aria-label="查询范围" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{defaultLabel}</option>
      {account.sources.map((source) => (
        <option value={source.sourceAccountId} key={source.sourceAccountId}>
          {source.merged ? '已合并设备' : '个人历史'} · 账户 {source.sourceAccountId}
        </option>
      ))}
    </select>
  );
}
