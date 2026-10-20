import { useEffect, useState, type KeyboardEvent } from 'react';
import { AppSwitch, useToast } from '../../../shared/ui';
import { fieldSourceNote, FONT_CHOICES, presetSections, readProfileValue, SIZE_CHOICES, sizeLabel, writeProfileValue } from '../presetFields';
import type { PresetField } from '../presetFields';
import type { BlindCheckCredentialWord, BlindCheckPresetSource, BlindCheckPresetTab, BlindCheckProfile } from '../types';

interface CredentialWordsProps {
  enabled: boolean;
  words: BlindCheckCredentialWord[];
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}

interface PresetEditorProps {
  tab: BlindCheckPresetTab;
  profile: BlindCheckProfile;
  readOnly: boolean;
  onCommit: (profile: BlindCheckProfile) => void;
  credential: CredentialWordsProps;
  /** AI 从招标文件生成的预设记录的出处，用于在字段下标注原文依据。 */
  source?: BlindCheckPresetSource;
}

/** 字段的 AI 出处：值未被用户改动时显示原文依据；招标文件未要求而设为不检查的，标出"招标文件未要求"。 */
function FieldSource({ field, profile, source }: { field: PresetField; profile: BlindCheckProfile; source?: BlindCheckPresetSource }) {
  const note = source ? fieldSourceNote(profile, source, field.path) : null;
  if (!note) return null;
  if (note.kind === 'evidence') {
    const { extracted } = note;
    const evidence = extracted.evidence ? `：「${extracted.evidence}」` : '';
    return (
      <small className={`blind-check-evidence${extracted.verified ? '' : ' is-unverified'}`}>
        <em>AI</em>
        {extracted.verified
          ? `依据：「${extracted.evidence}」`
          : extracted.issue
            ? `${extracted.issue}，请重点核对${evidence}`
            : `原文中未找到依据，请重点核对${evidence}`}
      </small>
    );
  }
  if (note.kind === 'related') {
    return <small className="blind-check-evidence is-unverified">{`原文有相关要求但没有对应设置，请核对后设置：「${note.sentence}」`}</small>;
  }
  return <small className="blind-check-evidence is-unspecified">招标文件未要求，不检查</small>;
}

function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') event.currentTarget.blur();
}

/** 数字输入：失焦或回车时提交，置空表示不检查。 */
function NumberField({ field, value, disabled, onCommit }: { field: PresetField; value: number | null; disabled: boolean; onCommit: (value: number | null) => void }) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));

  useEffect(() => {
    setDraft(value === null || value === undefined ? '' : String(value));
  }, [value]);

  const commit = () => {
    const text = draft.trim();
    if (!text) {
      if (value !== null) onCommit(null);
      return;
    }
    const number = Number(text);
    if (!Number.isFinite(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) {
      showToast(`${field.label}请输入 ${field.min ?? 0}～${field.max ?? ''} 之间的数字`, 'info');
      setDraft(value === null || value === undefined ? '' : String(value));
      return;
    }
    if (number !== value) onCommit(number);
  };

  return (
    <div className="blind-check-number-control">
      <input
        inputMode="decimal"
        value={draft}
        placeholder={field.nullLabel}
        disabled={disabled}
        aria-label={field.label}
        onChange={(event) => /^\d*(?:\.\d{0,2})?$/.test(event.target.value) && setDraft(event.target.value)}
        onKeyDown={blurOnEnter}
        onBlur={commit}
      />
      {field.unit && <em>{field.unit}</em>}
    </div>
  );
}

/** 多行词表：每行一个，失焦时提交。 */
function WordsField({ field, value, disabled, onCommit }: { field: PresetField; value: string[]; disabled: boolean; onCommit: (value: string[]) => void }) {
  const [draft, setDraft] = useState(value.join('\n'));

  useEffect(() => {
    setDraft(value.join('\n'));
  }, [value]);

  const commit = () => {
    const words = Array.from(new Set(draft.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)));
    if (words.join('\n') !== value.join('\n')) onCommit(words);
  };

  return (
    <label className="blind-check-words-field">
      <span>
        <strong>{field.label}</strong>
        {field.hint && <small>{field.hint}</small>}
      </span>
      <textarea value={draft} disabled={disabled} rows={5} onChange={(event) => setDraft(event.target.value)} onBlur={commit} placeholder="每行一个" />
    </label>
  );
}

function FieldControl({ field, profile, disabled, onChange }: { field: PresetField; profile: BlindCheckProfile; disabled: boolean; onChange: (value: unknown) => void }) {
  const value = readProfileValue(profile, field.path);
  if (field.kind === 'switch') {
    return <AppSwitch checked={value === true} disabled={disabled} onCheckedChange={onChange} aria-label={field.label} />;
  }
  if (field.kind === 'number') {
    return <NumberField field={field} value={(value as number | null) ?? null} disabled={disabled} onCommit={onChange} />;
  }
  if (field.kind === 'tristate') {
    return (
      <select value={value === null || value === undefined ? '' : value ? 'true' : 'false'} disabled={disabled} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'true')} aria-label={field.label}>
        <option value="">{field.nullLabel}</option>
        <option value="false">{field.falseLabel}</option>
        <option value="true">{field.trueLabel}</option>
      </select>
    );
  }
  if (field.kind === 'bold') {
    return (
      <select value={value === null || value === undefined ? '' : value ? 'bold' : 'normal'} disabled={disabled} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'bold')} aria-label={field.label}>
        <option value="">不检查</option>
        <option value="bold">加粗</option>
        <option value="normal">不加粗</option>
      </select>
    );
  }
  if (field.kind === 'size') {
    const pt = (value as number | null) ?? null;
    const known = pt === null || SIZE_CHOICES.some((item) => Math.abs(item.value - pt) < 0.01);
    return (
      <select value={pt === null ? '' : String(pt)} disabled={disabled} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} aria-label={field.label}>
        {field.nullLabel && <option value="">{field.nullLabel}</option>}
        {!known && pt !== null && <option value={String(pt)}>{sizeLabel(pt)}</option>}
        {SIZE_CHOICES.map((item) => <option value={String(item.value)} key={item.label}>{item.label}（{item.value}磅）</option>)}
      </select>
    );
  }
  if (field.kind === 'font') {
    const font = (value as string | null) ?? '';
    return (
      <select value={font} disabled={disabled} onChange={(event) => onChange(event.target.value || null)} aria-label={field.label}>
        {field.nullLabel && <option value="">{field.nullLabel}</option>}
        {font && !FONT_CHOICES.includes(font) && <option value={font}>{font}</option>}
        {FONT_CHOICES.map((item) => <option value={item} key={item}>{item}</option>)}
      </select>
    );
  }
  return (
    <select value={(value as string | null) ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value || null)} aria-label={field.label}>
      {field.nullLabel && <option value="">{field.nullLabel}</option>}
      {(field.options || []).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>
  );
}

function CredentialWords({ enabled, words, busy, onToggle }: CredentialWordsProps) {
  return (
    <section className="blind-check-preset-section">
      <div className="blind-check-preset-section-head">
        <strong>资信库企业信息</strong>
      </div>
      <div className="content-generation-config-list">
        <div className="content-generation-config-row">
          <span>
            <strong>使用资信库企业信息</strong>
            <small>{words.length ? `将检查 ${words.length} 项信息` : '资信库尚未填写企业信息'}</small>
          </span>
          <AppSwitch checked={enabled} disabled={busy} onCheckedChange={onToggle} aria-label="使用资信库企业信息" />
        </div>
      </div>
      {enabled && words.length > 0 && (
        <div className="blind-check-word-chips">
          {words.map((word) => (
            <span key={`${word.label}-${word.value}`} title={word.label}>
              <em>{word.label}</em>
              {word.value}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** 预设编辑：选择和开关立即提交，数字与词表失焦提交；内置预设只读。 */
export default function PresetEditor({ tab, profile, readOnly, onCommit, credential, source }: PresetEditorProps) {
  const sections = presetSections[tab];
  return (
    <div className="blind-check-preset-editor">
      {tab === 'privacy' && <CredentialWords {...credential} />}
      {sections.map((section) => {
        const fields = section.fields.filter((field) => !field.visible || field.visible(profile));
        const words = fields.filter((field) => field.kind === 'words');
        const rows = fields.filter((field) => field.kind !== 'words');
        return (
          <section className="blind-check-preset-section" key={section.title}>
            <div className="blind-check-preset-section-head">
              <strong>{section.title}</strong>
              {section.description && <small>{section.description}</small>}
            </div>
            {words.length > 0 && (
              <div className="blind-check-words-grid">
                {words.map((field) => (
                  <WordsField
                    key={field.path.join('.')}
                    field={field}
                    value={(readProfileValue(profile, field.path) as string[]) || []}
                    disabled={readOnly}
                    onCommit={(value) => onCommit(writeProfileValue(profile, field.path, value))}
                  />
                ))}
              </div>
            )}
            {rows.length > 0 && (
              <div className="content-generation-config-list">
                {rows.map((field) => (
                  <div className="content-generation-config-row" key={field.path.join('.')}>
                    <span>
                      <strong>{field.label}</strong>
                      {field.hint && <small>{field.hint}</small>}
                      <FieldSource field={field} profile={profile} source={source} />
                    </span>
                    <FieldControl
                      field={field}
                      profile={profile}
                      disabled={readOnly}
                      onChange={(value) => onCommit(writeProfileValue(profile, field.path, value))}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
