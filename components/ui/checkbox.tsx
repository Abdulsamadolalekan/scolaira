'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils/cn';
import { Check } from './icons';

/* -------------------------------------------------------------------------
 * Checkbox
 * ----------------------------------------------------------------------- */
export interface CheckboxProps extends React.ComponentPropsWithoutRef<
  typeof CheckboxPrimitive.Root
> {
  label?: React.ReactNode;
  description?: React.ReactNode;
}

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(({ className, label, description, id, disabled, ...props }, ref) => {
  const inputId = React.useId();
  const finalId = id ?? inputId;
  return (
    <div className={cn('flex items-start gap-2', disabled && 'opacity-60')}>
      <CheckboxPrimitive.Root
        ref={ref}
        id={finalId}
        disabled={disabled}
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-border-strong bg-white',
          'transition-colors duration-fast ease-standard',
          'hover:border-forest-primary',
          'outline-none focus-visible:shadow-focus-ring',
          'data-[state=checked]:border-forest-primary data-[state=checked]:bg-forest-primary data-[state=checked]:text-white',
          'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-subtle',
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
          <Check size={12} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {(label || description) && (
        <div className="flex flex-col gap-0.5 leading-tight">
          {label && (
            <label
              htmlFor={finalId}
              className="cursor-pointer text-sm font-medium text-ink-primary"
            >
              {label}
            </label>
          )}
          {description && <p className="text-xs text-ink-muted">{description}</p>}
        </div>
      )}
    </div>
  );
});
Checkbox.displayName = 'Checkbox';

/* -------------------------------------------------------------------------
 * Radio + RadioGroup (native styled for simplicity/accessibility)
 * ----------------------------------------------------------------------- */
export interface RadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
}

export function RadioGroup({
  className,
  children,
  value,
  defaultValue,
  onValueChange,
  name,
  ...rest
}: RadioGroupProps) {
  const [internal, setInternal] = React.useState(defaultValue ?? '');
  const current = value ?? internal;
  const handle = React.useCallback(
    (v: string) => {
      setInternal(v);
      onValueChange?.(v);
    },
    [onValueChange],
  );
  const ctx = React.useMemo(
    () => ({ value: current, onValue: handle, name }),
    [current, name, handle],
  );
  return (
    <RadioCtx.Provider value={ctx}>
      <div role="radiogroup" className={cn('flex flex-col gap-2', className)} {...rest}>
        {children}
      </div>
    </RadioCtx.Provider>
  );
}

const RadioCtx = React.createContext<{
  value: string;
  onValue: (v: string) => void;
  name?: string;
}>({ value: '', onValue: () => {} });

export interface RadioItemProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name'> {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}

export function RadioItem({
  value,
  label,
  description,
  className,
  disabled,
  id,
  ...rest
}: RadioItemProps) {
  const ctx = React.useContext(RadioCtx);
  const inputId = React.useId();
  const finalId = id ?? inputId;
  const checked = ctx.value === value;
  return (
    <label
      htmlFor={finalId}
      className={cn(
        'flex cursor-pointer select-none items-start gap-2',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <span className="relative mt-0.5 flex h-4 w-4 items-center justify-center">
        <input
          type="radio"
          id={finalId}
          name={ctx.name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => ctx.onValue(value)}
          className="peer sr-only"
          {...rest}
        />
        <span
          className={cn(
            'h-4 w-4 rounded-full border border-border-strong bg-white transition-colors',
            'peer-hover:border-forest-primary',
            'peer-focus-visible:shadow-focus-ring',
            checked && 'border-forest-primary',
          )}
        />
        <span
          className={cn(
            'absolute h-1.5 w-1.5 rounded-full bg-forest-primary transition-opacity',
            'opacity-0',
            checked && 'opacity-100',
          )}
          aria-hidden
        />
      </span>
      <span className="flex flex-col gap-0.5 leading-tight">
        <span className="text-sm font-medium text-ink-primary">{label}</span>
        {description && <span className="text-xs text-ink-muted">{description}</span>}
      </span>
    </label>
  );
}

/* -------------------------------------------------------------------------
 * Switch
 * ----------------------------------------------------------------------- */
export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: React.ReactNode;
  description?: React.ReactNode;
}

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, label, description, id, ...props }, ref) => {
  const inputId = React.useId();
  const finalId = id ?? inputId;
  return (
    <div className="flex items-start justify-between gap-4">
      {(label || description) && (
        <div className="flex flex-col gap-0.5">
          {label && (
            <label
              htmlFor={finalId}
              className="cursor-pointer text-sm font-medium text-ink-primary"
            >
              {label}
            </label>
          )}
          {description && <p className="text-xs text-ink-muted">{description}</p>}
        </div>
      )}
      <SwitchPrimitive.Root
        ref={ref}
        id={finalId}
        className={cn(
          'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
          'transition-colors duration-fast ease-standard',
          'bg-ink-subtle',
          'data-[state=checked]:bg-forest-primary',
          'outline-none focus-visible:shadow-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm',
            'transition-transform duration-fast ease-standard',
            'translate-x-0.5 data-[state=checked]:translate-x-[18px]',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  );
});
Switch.displayName = 'Switch';
