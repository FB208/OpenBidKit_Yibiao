import * as Switch from '@radix-ui/react-switch';

export interface AppSwitchProps {
  checked: boolean;
  /** 固定态开关（如必选项）可不传 */
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  id?: string;
}

/** 统一开关：基于 Radix Switch，替代原生 checkbox 拼装的 yb-switch-control 与各处自建开关 */
export default function AppSwitch({ checked, onCheckedChange, disabled = false, 'aria-label': ariaLabel, id }: AppSwitchProps) {
  return (
    <Switch.Root
      id={id}
      className="yb-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <Switch.Thumb className="yb-switch-thumb" />
    </Switch.Root>
  );
}
