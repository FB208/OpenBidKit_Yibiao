import { useEffect, useState, type FormEvent } from 'react';
import type { OfficialInvoiceInfo } from '../../../shared/types/officialAccount';
import { useToast } from '../../../shared/ui';

/** 加载并保存本地开票信息。 */
export default function OfficialInvoicePanel() {
  const [info, setInfo] = useState<OfficialInvoiceInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    setLoadError('');
    window.yibiao.officialAccount.getInvoiceInfo().then((value) => {
      if (active) setInfo(value);
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : '开票信息加载失败');
    });
    return () => { active = false; };
  }, [reload]);

  /** 保存成功后提示；失败时保留填写内容。 */
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!info || saving) return;
    setSaving(true);
    try {
      await window.yibiao.officialAccount.saveInvoiceInfo({
        ...info, buyer: info.buyer.trim(),
        taxNumber: info.titleType === 'enterprise' ? info.taxNumber.trim() : '',
        email: info.email.trim(),
      });
      showToast('开票信息已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '开票信息保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="settings-row">
    <span role="alert">{loadError}</span>
    <button type="button" className="secondary-action" onClick={() => setReload((value) => value + 1)}>重新加载</button>
  </div>;
  if (!info) return <div className="settings-row" role="status">正在加载开票信息…</div>;

  return (
    <form className="settings-list" onSubmit={save} aria-busy={saving}>
      <label className="settings-row">
        <div className="settings-row-copy"><strong>抬头类型</strong></div>
        <select value={info.titleType} disabled={saving} onChange={(event) => setInfo({ ...info, titleType: event.target.value as OfficialInvoiceInfo['titleType'] })}>
          <option value="enterprise">企业单位</option>
          <option value="individual">个人</option>
        </select>
      </label>
      <label className="settings-row">
        <div className="settings-row-copy"><strong>购买方</strong></div>
        <input value={info.buyer} disabled={saving} onChange={(event) => setInfo({ ...info, buyer: event.target.value })} />
      </label>
      {info.titleType === 'enterprise' && (
        <label className="settings-row">
          <div className="settings-row-copy"><strong>公司税号</strong></div>
          <input value={info.taxNumber} disabled={saving} onChange={(event) => setInfo({ ...info, taxNumber: event.target.value })} />
        </label>
      )}
      <label className="settings-row">
        <div className="settings-row-copy"><strong>邮箱</strong></div>
        <input type="email" value={info.email} disabled={saving} onChange={(event) => setInfo({ ...info, email: event.target.value })} />
      </label>
      <div className="settings-row">
        <div className="settings-row-copy" />
        <button type="submit" className="primary-action" disabled={saving}>{saving ? '正在保存…' : '保存开票信息'}</button>
      </div>
    </form>
  );
}
