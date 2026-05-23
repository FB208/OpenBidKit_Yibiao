import type { InputHTMLAttributes, ReactNode } from 'react';

export interface InputWithActionProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  actionLabel: ReactNode;
  onAction: () => void;
  actionDisabled?: boolean;
  actionTitle?: string;
  className?: string;
  inputClassName?: string;
}

function InputWithAction({
  actionLabel,
  onAction,
  actionDisabled = false,
  actionTitle,
  className = '',
  inputClassName = '',
  disabled,
  ...inputProps
}: InputWithActionProps) {
  return (
    <div className={`input-with-action ${className}`.trim()}>
      <input
        {...inputProps}
        className={inputClassName || undefined}
        disabled={disabled}
      />
      <button
        type="button"
        className="input-with-action-button"
        onClick={onAction}
        disabled={actionDisabled}
        title={actionTitle}
      >
        {actionLabel}
      </button>
    </div>
  );
}

export default InputWithAction;
