import * as Popover from '@radix-ui/react-popover';
import { Cross2Icon, PlusIcon, TrashIcon } from '@radix-ui/react-icons';
import type { BusinessFillReviewImage, BusinessMaterials } from '../types';
import { BusinessImagePickerContent } from './BusinessFillDocument';

interface BusinessMaterialsPanelProps {
  materials: BusinessMaterials;
  /** 目录叶子 ID 对应的“编号 标题”，按目录顺序。 */
  placements: Record<string, string>;
  imageGroups: Array<[string, BusinessFillReviewImage[]]>;
  imagesById: Map<string, BusinessFillReviewImage>;
  saving?: boolean;
  onChange: (next: BusinessMaterials) => void;
}

const MISSING_PLACEMENT = '目录中已没有该小节，导出时不插入';

// 证明材料和承诺书按放置的小节分组显示：材料可增删图片或整项删除，承诺书可改正文或删除。
function BusinessMaterialsPanel({ materials, placements, imageGroups, imagesById, saving, onChange }: BusinessMaterialsPanelProps) {
  const updateMaterial = (index: number, patch: Partial<BusinessMaterials['materials'][number]>) => onChange({
    ...materials,
    materials: materials.materials.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
  });
  const updateCommitment = (index: number, paragraphs: string[]) => onChange({
    ...materials,
    commitments: materials.commitments.map((item, itemIndex) => (itemIndex === index ? { ...item, paragraphs } : item)),
  });
  // 用户补齐图片后确认已补齐，去掉缺少说明，导出不再写待填写。
  const clearMissing = (index: number) => onChange({
    ...materials,
    materials: materials.materials.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const { missing: _missing, ...rest } = item;
      return rest;
    }),
  });
  const removeMaterial = (index: number) => onChange({ ...materials, materials: materials.materials.filter((_item, itemIndex) => itemIndex !== index) });
  const removeCommitment = (index: number) => onChange({ ...materials, commitments: materials.commitments.filter((_item, itemIndex) => itemIndex !== index) });

  // 按目录顺序分组，目录中已没有的小节排在最后。
  const order = Object.keys(placements);
  const afters = [...new Set([...materials.materials, ...materials.commitments].map((item) => item.after))]
    .sort((a, b) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));

  if (!afters.length) {
    return <div className="business-fill-review-empty">填写 Agent 没有列出需要附后的证明材料或承诺书</div>;
  }

  return (
    <div className="business-materials">
      {afters.map((after) => (
        <section key={after}>
          <h3>放在“{placements[after] || MISSING_PLACEMENT}”之后</h3>
          {materials.materials.map((item, index) => (item.after !== after ? null : (
            <article key={`m${index}`} className={item.missing || !item.image_ids.length ? 'business-material is-missing' : 'business-material'}>
              <header>
                <strong>{item.title}</strong>
                <button type="button" className="business-material-icon" aria-label={`删除材料：${item.title}`} onClick={() => removeMaterial(index)} disabled={saving}>
                  <TrashIcon />
                </button>
              </header>
              <small>依据：{item.basis}</small>
              {item.missing && (
                <p className="business-material-missing">
                  <em>缺少：{item.missing}</em>
                  <button type="button" className="text-button" onClick={() => clearMissing(index)} disabled={saving}>已补齐</button>
                </p>
              )}
              {!item.missing && !item.image_ids.length && <em>还没有图片，导出时标为待填写</em>}
              <div className="business-material-images">
                {item.image_ids.map((imageId) => {
                  const image = imagesById.get(imageId);
                  return (
                    <figure key={imageId}>
                      {image ? <img src={image.asset_url} alt={image.name} /> : <span>图片已从资信库删除</span>}
                      <figcaption>{image ? `${image.label} · ${image.name}` : imageId}</figcaption>
                      <button
                        type="button"
                        className="business-material-icon"
                        aria-label="移除这张图片"
                        onClick={() => updateMaterial(index, { image_ids: item.image_ids.filter((id) => id !== imageId) })}
                        disabled={saving}
                      >
                        <Cross2Icon />
                      </button>
                    </figure>
                  );
                })}
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button type="button" className="business-material-add" disabled={saving}>
                      <PlusIcon />
                      <span>添加图片</span>
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <BusinessImagePickerContent
                      imageGroups={imageGroups}
                      onSelect={(imageId) => {
                        if (!item.image_ids.includes(imageId)) updateMaterial(index, { image_ids: [...item.image_ids, imageId] });
                      }}
                    />
                  </Popover.Portal>
                </Popover.Root>
              </div>
            </article>
          )))}
          {materials.commitments.map((item, index) => (item.after !== after ? null : (
            <article key={`c${index}`} className="business-material">
              <header>
                <strong>{item.title}</strong>
                <button type="button" className="business-material-icon" aria-label={`删除承诺书：${item.title}`} onClick={() => removeCommitment(index)} disabled={saving}>
                  <TrashIcon />
                </button>
              </header>
              <small>依据：{item.basis}（落款由导出时加上，每行一段）</small>
              <textarea
                value={item.paragraphs.join('\n')}
                rows={Math.min(12, Math.max(3, item.paragraphs.length + 1))}
                aria-label={`${item.title}正文`}
                onChange={(event) => updateCommitment(index, event.target.value.split('\n'))}
                disabled={saving}
              />
            </article>
          )))}
        </section>
      ))}
    </div>
  );
}

export default BusinessMaterialsPanel;
