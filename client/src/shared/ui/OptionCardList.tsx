import type { ReactNode } from 'react';
import { ChevronRightIcon } from '@radix-ui/react-icons';

export interface OptionCardItem<T extends string> {
  value: T;
  title: ReactNode;
  /** 标题下的简短说明，例如耗时或不可选的原因 */
  description?: ReactNode;
  /** 卡片左侧的图标，放在圆角色块里 */
  icon?: ReactNode;
  disabled?: boolean;
}

export interface OptionCardListProps<T extends string> {
  options: OptionCardItem<T>[];
  /** 点击卡片即执行，不再需要额外的确认按钮 */
  onSelect: (value: T) => void;
  /** 推荐或上次选择的选项，用主色描边标出 */
  highlightedValue?: T;
  /** 标出的选项标题旁的小标签，例如"上次选择" */
  highlightLabel?: string;
  'aria-label'?: string;
  className?: string;
}

/** 可点击的选项卡片列表：整张卡片就是按钮，用于弹窗里"选一种方式并立即开始"的场景 */
export default function OptionCardList<T extends string>({
  options,
  onSelect,
  highlightedValue,
  highlightLabel,
  'aria-label': ariaLabel,
  className,
}: OptionCardListProps<T>) {
  return (
    <div className={`yb-option-card-list${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const highlighted = option.value === highlightedValue;
        return (
          <button
            type="button"
            key={option.value}
            className={`yb-option-card${highlighted ? ' is-highlighted' : ''}`}
            disabled={option.disabled}
            onClick={() => onSelect(option.value)}
          >
            {option.icon != null ? <span className="yb-option-card-icon" aria-hidden="true">{option.icon}</span> : null}
            <span className="yb-option-card-body">
              <span className="yb-option-card-title">
                <strong>{option.title}</strong>
                {highlighted && highlightLabel ? <span className="yb-option-card-badge">{highlightLabel}</span> : null}
              </span>
              {option.description != null ? <span className="yb-option-card-description">{option.description}</span> : null}
            </span>
            <ChevronRightIcon className="yb-option-card-arrow" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
