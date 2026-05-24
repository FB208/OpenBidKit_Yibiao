import { useState } from 'react';
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
  type,
  ...inputProps
}: InputWithActionProps) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const canRevealPassword = type === 'password';
  const inputType = canRevealPassword && passwordVisible ? 'text' : type;
  const revealLabel = passwordVisible ? '隐藏密码' : '显示密码';

  return (
    <div className={`input-with-action ${canRevealPassword ? 'has-password-reveal' : ''} ${className}`.trim()}>
      <input
        {...inputProps}
        type={inputType}
        className={inputClassName || undefined}
        disabled={disabled}
      />
      {canRevealPassword && (
        <button
          type="button"
          className="input-with-action-icon-button"
          onClick={() => setPasswordVisible((visible) => !visible)}
          disabled={disabled}
          title={revealLabel}
          aria-label={revealLabel}
          aria-pressed={passwordVisible}
        >
          <svg className="input-with-action-eye-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="3" />
            {passwordVisible && <path d="M4 4l16 16" />}
          </svg>
        </button>
      )}
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
