'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { AlertCircle } from './icons';

/* -------------------------------------------------------------------------
 * Input — single-line text field.
 * ----------------------------------------------------------------------- */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  invalid?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  containerClassName?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, prefix, suffix, containerClassName, disabled, id, ...rest }, ref) => {
    const input = (
      <input
        ref={ref}
        id={id}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          'peer w-full bg-transparent text-ink-primary placeholder:text-ink-muted',
          'outline-none',
          'h-10 px-3',
          prefix && 'pl-0',
          suffix && 'pr-0',
          disabled && 'cursor-not-allowed text-ink-muted',
          'tabular-nums',
          className,
        )}
        {...rest}
      />
    );
    if (!prefix && !suffix) {
      return (
        <div
          className={cn(
            'flex items-center rounded border border-border-strong bg-white',
            'transition-colors duration-fast ease-standard',
            'focus-within:border-border-focus focus-within:shadow-focus-ring',
            invalid && 'border-danger-fg focus-within:shadow-focus-ring-danger',
            disabled && 'bg-surface-subtle',
            containerClassName,
          )}
        >
          {input}
        </div>
      );
    }
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded border border-border-strong bg-white px-3',
          'transition-colors duration-fast ease-standard',
          'focus-within:border-border-focus focus-within:shadow-focus-ring',
          invalid && 'border-danger-fg focus-within:shadow-focus-ring-danger',
          disabled && 'bg-surface-subtle text-ink-muted',
          containerClassName,
        )}
      >
        {prefix && (
          <span className="shrink-0 text-ink-muted" aria-hidden>
            {prefix}
          </span>
        )}
        {input}
        {suffix && (
          <span className="shrink-0 text-ink-muted" aria-hidden>
            {suffix}
          </span>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';

/* -------------------------------------------------------------------------
 * Textarea
 * ----------------------------------------------------------------------- */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, disabled, ...rest }, ref) => (
    <textarea
      ref={ref}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded border border-border-strong bg-white px-3 py-2',
        'resize-y text-ink-primary outline-none placeholder:text-ink-muted',
        'transition-colors duration-fast ease-standard',
        'focus:border-border-focus focus:shadow-focus-ring',
        invalid && 'border-danger-fg focus:shadow-focus-ring-danger',
        disabled && 'cursor-not-allowed bg-surface-subtle text-ink-muted',
        className,
      )}
      {...rest}
    />
  ),
);
Textarea.displayName = 'Textarea';

/* -------------------------------------------------------------------------
 * Select — native select for accessibility + mobile-friendliness.
 * ----------------------------------------------------------------------- */
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, disabled, children, ...rest }, ref) => (
    <div
      className={cn(
        'relative flex items-center rounded border border-border-strong bg-white',
        'transition-colors duration-fast ease-standard',
        'focus-within:border-border-focus focus-within:shadow-focus-ring',
        invalid && 'border-danger-fg focus-within:shadow-focus-ring-danger',
        disabled && 'bg-surface-subtle',
      )}
    >
      <select
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-10 w-full appearance-none bg-transparent px-3 pr-9',
          'text-ink-primary outline-none',
          disabled && 'cursor-not-allowed text-ink-muted',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-3 text-ink-muted"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  ),
);
Select.displayName = 'Select';

/* -------------------------------------------------------------------------
 * Label + Field — standard labelled field pattern.
 * ----------------------------------------------------------------------- */
export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, children, ...rest }, ref) => (
    <label ref={ref} className={cn('text-sm font-medium text-ink-primary', className)} {...rest}>
      {children}
      {required && (
        <span className="ml-0.5 text-danger-fg" aria-hidden>
          *
        </span>
      )}
    </label>
  ),
);
Label.displayName = 'Label';

export interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      )}
      {children}
      {error ? (
        <p role="alert" className="flex items-center gap-1 text-xs text-danger-fg">
          <AlertCircle size={12} />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}
