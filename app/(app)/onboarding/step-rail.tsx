/**
 * A restrained step indicator for the setup guide.
 *
 * Not a progress bar with a percentage, and not a row of pills: a numbered
 * spine, a word for the state, and a tick only when the step is genuinely done
 * (derived from the database, never from a flag). State is carried by the label
 * as well as the mark, so it never depends on colour alone.
 */
import { Check } from '@/components/ui/icons';

export interface GuideStep {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

export default function StepRail({
  steps,
  activeKey,
  onSelect,
  disabled = false,
}: {
  steps: GuideStep[];
  activeKey: string;
  /** True while a change is still being reflected, so no step acts on stale data. */
  disabled?: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const active = step.key === activeKey;
        return (
          <li key={step.key} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(step.key)}
              aria-current={active ? 'step' : undefined}
              className="flex w-full items-start gap-3 px-4 py-3 text-left disabled:cursor-progress"
              style={{
                background: active ? 'var(--color-bg-page)' : 'transparent',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold tabular-nums"
                style={{
                  border: `1px solid ${step.done ? 'transparent' : 'var(--color-border)'}`,
                  backgroundColor: step.done ? 'var(--color-forest-deep)' : 'transparent',
                  color: step.done ? '#fff' : 'var(--color-text-faint)',
                }}
                aria-hidden
              >
                {step.done ? <Check size={12} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="block text-[13px] font-medium"
                  style={{
                    color: active ? 'var(--color-forest-deep)' : 'var(--color-text-primary)',
                  }}
                >
                  {step.label}
                </span>
                <span
                  className="mt-0.5 block text-[11px]"
                  style={{ color: 'var(--color-text-faint)' }}
                >
                  {step.detail}
                </span>
              </span>
              <span className="sr-only">
                {step.done ? 'Completed' : 'Not yet completed'}
                {active ? ', current step' : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
