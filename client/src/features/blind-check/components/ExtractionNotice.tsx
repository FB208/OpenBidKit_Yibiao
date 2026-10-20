import { presetFieldLabel, presetFieldValueText } from '../presetFields';
import type { BlindCheckPresetSource, BlindCheckProfile } from '../types';

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * AI 生成预设的提取说明，只放各页签字段下放不下的内容：来源概况、字段下标不出来的疑似漏提、无法自动检查需要人工核对的条款、
 * 未能识别的结果和补充说明。提取值的依据、未通过核对、其余疑似漏提和"招标文件未要求"都标在各页签对应字段下，这里不重复列出。
 * 人工核对条款后列出相关检查项的当前设置，条款与生效的检查项矛盾时一眼能看出来。
 */
export default function ExtractionNotice({ source, profile }: { source: BlindCheckPresetSource; profile: BlindCheckProfile }) {
  const time = formatTime(source.extractedAt);
  // 疑似漏提的字段提取时设为不检查的，字段下会提示原句；对应字段不能留空的（如目录要求）字段下标不出来，在这里列出。
  const omissions = (source.omissions || []).filter((item) => !item.fields.some((path) => source.unspecified.includes(path)));
  return (
    <section className="blind-check-extraction-notice">
      <div className="blind-check-preset-section-head">
        <strong>AI 提取说明</strong>
        <small>
          {`来源：「${source.tenderName}」${time ? ` · ${time}` : ''}。AI 提取了 ${Object.keys(source.fields).length} 项格式要求，取值和原文依据显示在各页签对应设置下方；未通过核对或疑似漏提的项，所在页签标有"待核对"。`}
          {source.unspecified.length > 0 && '招标文件没写的项已设为不检查，其中字体、字号、对齐等格式项由一致性检查按全文多数给出建议。'}
        </small>
      </div>
      {omissions.length > 0 && (
        <div>
          <strong>原文还提到以下要求，但没有提取到对应设置（可能是 AI 漏提），请核对相关设置：</strong>
          <ul>
            {omissions.map((item) => (
              <li key={item.topic}>
                {`${item.topic}：「${item.sentence}」`}
                <small className="blind-check-manual-related">
                  {`相关设置：${item.fields.map((path) => `${presetFieldLabel(path)}（${presetFieldValueText(profile, path)}）`).join('、')}`}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {source.manual.length > 0 && (
        <div>
          <strong>以下要求无法自动检查，请人工核对：</strong>
          <ul>
            {source.manual.map((item, index) => {
              const related = source.manualFields?.[index] || [];
              return (
                <li key={item}>
                  {item}
                  {related.length > 0 && (
                    <small className="blind-check-manual-related">
                      {`相关设置：${related.map((path) => `${presetFieldLabel(path)}（${presetFieldValueText(profile, path)}）`).join('、')}`}
                    </small>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {source.dropped.length > 0 && (
        <p>
          <strong>未能识别、已忽略的提取结果：</strong>
          {source.dropped.join('；')}
        </p>
      )}
      {source.notes && (
        <p>
          <strong>补充说明：</strong>
          {source.notes}
        </p>
      )}
    </section>
  );
}
